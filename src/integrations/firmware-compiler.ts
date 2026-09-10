import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity, ToolIdentity } from "../domain/types.js";
import {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_EXECUTION_POLICY_SCHEMA,
  FIRMWARE_SOURCE_LOGICAL_NAMES,
  type FirmwareCompileBackend,
  type FirmwareCompileBackendConfiguration,
  type FirmwareCompileRequest,
  type FirmwareCompileResult,
  type FirmwareCompileSource,
  type FirmwareCompileStep,
  type FirmwareSourceLogicalName
} from "../workflow/contracts.js";
import {
  runBoundedProcess,
  type BoundedProcessResult,
  type BoundedProcessRunner
} from "./bounded-process.js";

export {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_SOURCE_LOGICAL_NAMES
} from "../workflow/contracts.js";
export type {
  FirmwareCompileBackend,
  FirmwareCompileBackendConfiguration,
  FirmwareCompileContextExtension,
  FirmwareCompileRequest,
  FirmwareCompileResult,
  FirmwareCompileSource,
  FirmwareCompileStep,
  FirmwareSourceLogicalName
} from "../workflow/contracts.js";

export const firmwareCompileArguments = (): readonly string[] => [
  "-std=c11", "-fno-lto", "-fno-use-linker-plugin",
  "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", "include",
  "src/board_contract.c", "tests/board_contract_validation.c", "-o",
  process.platform === "win32" ? "build/board_contract_validation.exe" : "build/board_contract_validation"
];

export interface LocalFirmwareCompileBackendOptions {
  readonly compilerPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: BoundedProcessRunner;
  readonly temporaryRoot?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export const FIRMWARE_COMPILE_RESOURCE_LIMITS = Object.freeze({
  maxSourceBytes: 512 * 1024,
  maxTotalSourceBytes: 2 * 1024 * 1024,
  maxCompilerBytes: 256 * 1024 * 1024,
  maxValidationExecutableBytes: 16 * 1024 * 1024,
});

const HOST_EXECUTION_POLICY = Object.freeze({
  schemaVersion: FIRMWARE_EXECUTION_POLICY_SCHEMA,
  acceptedSourceOrigin: "evleda-deterministic-generator" as const,
  agentDerivedOrUntrustedSourceExecution: "deny" as const,
  osSandbox: "none" as const,
  containmentClaim: "not-contained" as const,
  executableStrategy: "identity-checked-shared-path" as const,
  lto: "disabled" as const,
  linkerPlugin: "disabled" as const,
});

const HOST_SYSTEM_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
] as const;

const configuredValue = (
  environment: Readonly<Record<string, string | undefined>>,
  expectedName: string
): string | undefined =>
  Object.entries(environment).find(
    ([name, value]) =>
      value !== undefined &&
      name.toLocaleUpperCase("en-US") === expectedName.toLocaleUpperCase("en-US")
  )?.[1];

const processEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    NO_COLOR: "1",
    SOURCE_DATE_EPOCH: "0",
    PATH: "<compiler-dir>",
    TEMP: "<workspace>",
    TMP: "<workspace>",
    TMPDIR: "<workspace>",
  };
  for (const key of HOST_SYSTEM_ENVIRONMENT_KEYS) {
    const value = configuredValue(environment, key);
    if (value !== undefined) selected[key] = value;
  }
  return Object.freeze(selected);
};

const materializedEnvironment = (
  environment: Readonly<Record<string, string>>,
  workspace: string,
  compilerDirectory: string,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(environment).map(([key, value]) => [
    key,
    value.replaceAll("<workspace>", workspace).replaceAll("<compiler-dir>", compilerDirectory),
  ]),
));

const normalizedOutput = (
  value: string,
  workspace: string,
  executablePath: string
): string =>
  value
    .replaceAll(workspace, "<workspace>")
    .replaceAll(workspace.replaceAll("\\", "/"), "<workspace>")
    .replaceAll(executablePath, "<compiler>")
    .replaceAll(executablePath.replaceAll("\\", "/"), "<compiler>")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

const stepFrom = (
  operation: FirmwareCompileStep["operation"],
  commandRole: FirmwareCompileStep["commandRole"],
  commandIdentity: ContentIdentity,
  logicalArguments: readonly string[],
  result: BoundedProcessResult,
  workspace: string,
  executablePath: string
): FirmwareCompileStep => ({
  operation,
  commandRole,
  commandIdentity,
  arguments: [...logicalArguments],
  exitCode: result.exitCode,
  stdout: normalizedOutput(result.stdout, workspace, executablePath),
  stderr: normalizedOutput(result.stderr, workspace, executablePath)
});

const failureStep = (
  operation: FirmwareCompileStep["operation"],
  commandRole: FirmwareCompileStep["commandRole"],
  commandIdentity: ContentIdentity,
  logicalArguments: readonly string[],
  error: unknown,
  workspace: string,
  executablePath: string
): FirmwareCompileStep => {
  const candidate = error as { readonly stdout?: unknown; readonly stderr?: unknown };
  return {
    operation,
    commandRole,
    commandIdentity,
    arguments: [...logicalArguments],
    exitCode: null,
    stdout:
      typeof candidate.stdout === "string"
        ? normalizedOutput(candidate.stdout, workspace, executablePath)
        : "",
    stderr: normalizedOutput(
      typeof candidate.stderr === "string"
        ? candidate.stderr
        : error instanceof Error
          ? error.message
          : "Firmware toolchain invocation failed.",
      workspace,
      executablePath
    )
  };
};

const unsupported = (
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: CanonicalIdentity,
  requestedCompilerPath: string | null,
  code: string,
  message: string,
  steps: readonly FirmwareCompileStep[] = []
): FirmwareCompileResult => ({
  schemaVersion: "evleda.firmware-compile-result.v1",
  sourceRevisionDigest,
  configurationIdentity,
  status: "unsupported",
  code,
  message,
  backendId,
  requestedCompilerPath,
  compilerFamily: null,
  targetTriple: null,
  steps
});

const failed = (
  backendId: string,
  request: FirmwareCompileRequest,
  requestedCompilerPath: string,
  compilerFamily: "clang" | "gcc" | null,
  targetTriple: string | null,
  code: string,
  message: string,
  steps: readonly FirmwareCompileStep[],
  tool?: ToolIdentity,
  executableIdentity?: ContentIdentity
): FirmwareCompileResult => ({
  schemaVersion: "evleda.firmware-compile-result.v1",
  sourceRevisionDigest: request.sourceRevisionDigest,
  configurationIdentity: request.configurationIdentity,
  status: "fail",
  code,
  message,
  backendId,
  requestedCompilerPath,
  compilerFamily,
  targetTriple,
  ...(tool === undefined ? {} : { tool }),
  ...(executableIdentity === undefined ? {} : { executableIdentity }),
  steps
});

const compilerFamilyAndVersion = (
  output: string
): { readonly family: "clang" | "gcc"; readonly version: string } | undefined => {
  const clang = /(?:Apple\s+)?clang version\s+(?<version>\d+(?:\.\d+){1,3})/iu.exec(output);
  if (clang?.groups?.version !== undefined) {
    return { family: "clang", version: clang.groups.version };
  }
  const gcc = /(?:^|\b)gcc(?:\.exe)?(?:\s+\([^\r\n]*\))?\s+(?<version>\d+(?:\.\d+){1,3})/imu.exec(
    output
  );
  return gcc?.groups?.version === undefined
    ? undefined
    : { family: "gcc", version: gcc.groups.version };
};

const targetMatchesHost = (targetTriple: string): boolean => {
  const target = targetTriple.toLocaleLowerCase("en-US");
  const platformMatches =
    process.platform === "win32"
      ? /(?:mingw|windows|msvc|win32)/u.test(target)
      : process.platform === "darwin"
        ? /(?:apple|darwin)/u.test(target)
        : process.platform === "linux"
          ? target.includes("linux")
          : false;
  const architectureMatches =
    process.arch === "x64"
      ? /(?:x86_64|amd64)/u.test(target)
      : process.arch === "arm64"
        ? /(?:aarch64|arm64)/u.test(target)
        : target.includes(process.arch.toLocaleLowerCase("en-US"));
  return platformMatches && architectureMatches;
};

const sourceFileName = (logicalName: FirmwareSourceLogicalName): string => {
  const prefixes: Readonly<Record<FirmwareSourceLogicalName, string>> = {
    "firmware/include/board_contract.h": "include/board_contract.h",
    "firmware/src/board_contract.c": "src/board_contract.c",
    "firmware/tests/board_contract_validation.c": "tests/board_contract_validation.c"
  };
  return prefixes[logicalName];
};

const validateSources = (sources: readonly FirmwareCompileSource[]): string | undefined => {
  if (sources.length !== FIRMWARE_SOURCE_LOGICAL_NAMES.length) {
    return "The compile request must contain exactly the generated header, source, and validation test.";
  }
  const names = new Set(sources.map((source) => source.logicalName));
  if (names.size !== FIRMWARE_SOURCE_LOGICAL_NAMES.length) {
    return "The compile request contains duplicated generated source logical names.";
  }
  for (const name of FIRMWARE_SOURCE_LOGICAL_NAMES) {
    if (!names.has(name)) return `The compile request is missing ${name}.`;
  }
  let totalBytes = 0;
  for (const source of sources) {
    const actual = contentIdentity(source.content);
    totalBytes += actual.size;
    if (
      actual.digest !== source.identity.digest ||
      actual.size !== source.identity.size ||
      source.content.byteLength === 0 ||
      actual.size > FIRMWARE_COMPILE_RESOURCE_LIMITS.maxSourceBytes ||
      totalBytes > FIRMWARE_COMPILE_RESOURCE_LIMITS.maxTotalSourceBytes
    ) {
      return `Generated source ${source.logicalName} is empty, oversized, or does not match its content identity.`;
    }
  }
  return undefined;
};

const stableOrdinaryFile = async (
  filePath: string,
  maximumBytes: number,
): Promise<{ readonly path: string; readonly bytes: Buffer; readonly identity: ContentIdentity }> => {
  const first = await lstat(filePath);
  if (
    first.isSymbolicLink() || !first.isFile() || first.size <= 0 || first.size > maximumBytes
  ) throw new Error("file is not a bounded non-empty ordinary file");
  const canonicalPath = await realpath(filePath);
  const bytes = await readFile(canonicalPath);
  const second = await lstat(canonicalPath);
  if (
    !second.isFile() || bytes.byteLength !== first.size || second.size !== first.size ||
    second.mtimeMs !== first.mtimeMs || second.dev !== first.dev || second.ino !== first.ino
  ) throw new Error("file changed while it was captured");
  return { path: canonicalPath, bytes, identity: contentIdentity(bytes) };
};

const writeVerifiedPrivateFile = async (
  filePath: string,
  bytes: Uint8Array,
  expected: ContentIdentity,
  executable: boolean,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, bytes, { flag: "wx", mode: executable ? 0o500 : 0o400 });
  if (process.platform !== "win32") await chmod(filePath, executable ? 0o500 : 0o400);
  const copied = await stableOrdinaryFile(
    filePath,
    executable
      ? FIRMWARE_COMPILE_RESOURCE_LIMITS.maxValidationExecutableBytes
      : FIRMWARE_COMPILE_RESOURCE_LIMITS.maxSourceBytes,
  );
  if (copied.identity.digest !== expected.digest || copied.identity.size !== expected.size) {
    throw new Error("private firmware file copy failed identity verification");
  }
};

export class LocalFirmwareCompileBackend implements FirmwareCompileBackend {
  public readonly backendId = "local-explicit-native-c11";
  public readonly configuration: FirmwareCompileBackendConfiguration;
  readonly #configurationIdentity: CanonicalIdentity;
  readonly #compilerPath: string | undefined;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #runner: BoundedProcessRunner;
  readonly #temporaryRoot: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  public constructor(options: LocalFirmwareCompileBackendOptions = {}) {
    this.#environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.#compilerPath =
      options.compilerPath ?? configuredValue(this.#environment, "EVLEDA_FIRMWARE_CC");
    this.#runner = options.runner ?? runBoundedProcess;
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 120_000) {
      throw new Error("Firmware compile timeout must be an integer from 1 through 120000 milliseconds.");
    }
    if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0 || this.#maxOutputBytes > 1024 * 1024) {
      throw new Error("Firmware compile process output limit must be an integer from 1 through 1048576 bytes.");
    }
    const requestedCompilerPath =
      this.#compilerPath === undefined || this.#compilerPath.trim().length === 0
        ? null
        : path.normalize(this.#compilerPath);
    const environment = processEnvironment(this.#environment);
    this.configuration = Object.freeze({
      schemaVersion: FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
      backendId: this.backendId,
      requestedCompilerPath,
      environment,
      environmentIdentity: canonicalIdentity(environment, FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA),
      executionPolicy: HOST_EXECUTION_POLICY,
      resourceLimits: FIRMWARE_COMPILE_RESOURCE_LIMITS,
      platform: process.platform,
      architecture: process.arch,
      compileArguments: Object.freeze([...firmwareCompileArguments()]),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      processRunner: "evleda.bounded-process.v1"
    });
    this.#configurationIdentity = canonicalIdentity(
      this.configuration,
      FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA
    );
  }

  public async execute(request: FirmwareCompileRequest): Promise<FirmwareCompileResult> {
    // Snapshot caller-owned buffers before the first await. Neither caller mutation nor an
    // injected backend may change the bytes that this invocation validates after input freeze.
    if (
      !Array.isArray(request.sources) ||
      request.sources.length !== FIRMWARE_SOURCE_LOGICAL_NAMES.length ||
      request.sources.some((source) =>
        !(source.content instanceof Uint8Array) ||
        source.content.byteLength > FIRMWARE_COMPILE_RESOURCE_LIMITS.maxSourceBytes
      ) ||
      request.sources.reduce((total, source) => total + source.content.byteLength, 0) >
        FIRMWARE_COMPILE_RESOURCE_LIMITS.maxTotalSourceBytes
    ) {
      const boundedRequest: FirmwareCompileRequest = {
        schemaVersion: "evleda.firmware-compile-request.v1",
        sourceRevisionDigest: typeof request.sourceRevisionDigest === "string"
          ? request.sourceRevisionDigest
          : "invalid",
        configurationIdentity: this.#configurationIdentity,
        sourceOrigin: "evleda-deterministic-generator",
        sources: [],
      };
      return failed(
        this.backendId,
        boundedRequest,
        this.configuration.requestedCompilerPath ?? "",
        null,
        null,
        "FIRMWARE_COMPILE_SOURCE_INVALID",
        "Generated firmware sources exceed their count or byte limits.",
        [],
      );
    }
    const frozenRequest: FirmwareCompileRequest = {
      schemaVersion: request.schemaVersion,
      sourceRevisionDigest: request.sourceRevisionDigest,
      configurationIdentity: structuredClone(request.configurationIdentity),
      sourceOrigin: request.sourceOrigin,
      sources: request.sources.map((source) => ({
        logicalName: source.logicalName,
        content: Uint8Array.from(source.content),
        identity: structuredClone(source.identity)
      }))
    };
    request = frozenRequest;
    if (
      request.schemaVersion !== "evleda.firmware-compile-request.v1" ||
      !/^[0-9a-f]{64}$/u.test(request.sourceRevisionDigest) ||
      request.sourceOrigin !== this.configuration.executionPolicy.acceptedSourceOrigin ||
      this.configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
      this.configuration.executionPolicy.osSandbox !== "none" ||
      this.configuration.executionPolicy.containmentClaim !== "not-contained" ||
      this.configuration.executionPolicy.executableStrategy !== "identity-checked-shared-path" ||
      this.configuration.executionPolicy.lto !== "disabled" ||
      this.configuration.executionPolicy.linkerPlugin !== "disabled" ||
      !this.configuration.compileArguments.includes("-fno-lto") ||
      !this.configuration.compileArguments.includes("-fno-use-linker-plugin") ||
      canonicalJson(this.configuration.resourceLimits) !== canonicalJson(FIRMWARE_COMPILE_RESOURCE_LIMITS) ||
      request.configurationIdentity.algorithm !== "sha256" ||
      request.configurationIdentity.digest !== this.#configurationIdentity.digest ||
      request.configurationIdentity.schemaVersion !== FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA ||
      request.configurationIdentity.canonicalizationVersion !== "evleda-c14n-json-v1"
    ) {
      return unsupported(
        this.backendId,
        request.sourceRevisionDigest,
        this.#configurationIdentity,
        this.#compilerPath ?? null,
        "FIRMWARE_COMPILE_REQUEST_INVALID",
        "Firmware compilation requires deterministic generator output bound to the provisioned no-sandbox deny policy and a lowercase SHA-256 source revision."
      );
    }
    const sourceProblem = validateSources(request.sources);
    if (sourceProblem !== undefined) {
      return failed(
        this.backendId,
        request,
        this.#compilerPath ?? "",
        null,
        null,
        "FIRMWARE_COMPILE_SOURCE_INVALID",
        sourceProblem,
        []
      );
    }
    if (this.#compilerPath === undefined || this.#compilerPath.trim().length === 0) {
      return unsupported(
        this.backendId,
        request.sourceRevisionDigest,
        this.#configurationIdentity,
        null,
        "FIRMWARE_TOOLCHAIN_NOT_CONFIGURED",
        "No compiler is configured. Set EVLEDA_FIRMWARE_CC to an absolute native Clang or GCC executable path."
      );
    }
    if (!path.isAbsolute(this.#compilerPath)) {
      return unsupported(
        this.backendId,
        request.sourceRevisionDigest,
        this.#configurationIdentity,
        this.#compilerPath,
        "FIRMWARE_TOOLCHAIN_PATH_INVALID",
        "EVLEDA_FIRMWARE_CC must be an absolute path; PATH-only compiler discovery is intentionally unsupported."
      );
    }

    const requestedCompilerPath = path.normalize(this.#compilerPath);
    let executablePath: string;
    let executableIdentity: ContentIdentity;
    try {
      const captured = await stableOrdinaryFile(
        requestedCompilerPath,
        this.configuration.resourceLimits.maxCompilerBytes,
      );
      executablePath = captured.path;
      executableIdentity = captured.identity;
      if (path.relative(requestedCompilerPath, executablePath) !== "") {
        throw new Error("configured compiler path resolves through a path alias or link");
      }
    } catch {
      return unsupported(
        this.backendId,
        request.sourceRevisionDigest,
        this.#configurationIdentity,
        requestedCompilerPath,
        "FIRMWARE_TOOLCHAIN_UNAVAILABLE",
        "The configured firmware compiler is missing, oversized, unreadable, changed during capture, or does not resolve to the exact configured ordinary path."
      );
    }

    await mkdir(path.resolve(this.#temporaryRoot), { recursive: true, mode: 0o700 });
    const temporaryRootMetadata = await lstat(path.resolve(this.#temporaryRoot));
    if (temporaryRootMetadata.isSymbolicLink() || !temporaryRootMetadata.isDirectory()) {
      return unsupported(
        this.backendId,
        request.sourceRevisionDigest,
        this.#configurationIdentity,
        requestedCompilerPath,
        "FIRMWARE_WORK_ROOT_INVALID",
        "Firmware validation work root must be an ordinary private directory."
      );
    }
    const canonicalTemporaryRoot = await realpath(path.resolve(this.#temporaryRoot));
    const workspace = await mkdtemp(path.join(canonicalTemporaryRoot, "evleda-firmware-"));
    if (process.platform !== "win32") await chmod(workspace, 0o700);
    const environment = materializedEnvironment(
      this.configuration.environment,
      workspace,
      path.dirname(executablePath),
    );
    const steps: FirmwareCompileStep[] = [];
    let compilerFamily: "clang" | "gcc" | null = null;
    let targetTriple: string | null = null;
    let tool: ToolIdentity | undefined;
    try {
      await Promise.all([
        mkdir(path.join(workspace, "include"), { mode: 0o700 }),
        mkdir(path.join(workspace, "src"), { mode: 0o700 }),
        mkdir(path.join(workspace, "tests"), { mode: 0o700 }),
        mkdir(path.join(workspace, "build"), { mode: 0o700 }),
        mkdir(path.join(workspace, "run"), { mode: 0o700 })
      ]);
      await Promise.all(
        request.sources.map((source) =>
          writeVerifiedPrivateFile(
            path.join(workspace, sourceFileName(source.logicalName)),
            source.content,
            source.identity,
            false,
          )
        )
      );

      let versionResult: BoundedProcessResult;
      try {
        versionResult = await this.#runner({
          command: executablePath,
          args: ["--version"],
          cwd: workspace,
          env: environment,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: this.#maxOutputBytes
        });
      } catch (error) {
        steps.push(failureStep("compiler_version", "compiler", executableIdentity, ["--version"], error, workspace, executablePath));
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          null,
          null,
          "FIRMWARE_TOOLCHAIN_PROBE_FAILED",
          "The configured compiler could not complete a bounded version probe.",
          steps,
          undefined,
          executableIdentity
        );
      }
      steps.push(stepFrom("compiler_version", "compiler", executableIdentity, ["--version"], versionResult, workspace, executablePath));
      const identified = compilerFamilyAndVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
      if (versionResult.exitCode !== 0 || identified === undefined) {
        return unsupported(
          this.backendId,
          request.sourceRevisionDigest,
          this.#configurationIdentity,
          requestedCompilerPath,
          "FIRMWARE_TOOLCHAIN_UNSUPPORTED",
          "The configured executable did not identify itself as a supported Clang or GCC C compiler.",
          steps
        );
      }
      compilerFamily = identified.family;

      let targetResult: BoundedProcessResult;
      try {
        targetResult = await this.#runner({
          command: executablePath,
          args: ["-dumpmachine"],
          cwd: workspace,
          env: environment,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: this.#maxOutputBytes
        });
      } catch (error) {
        steps.push(failureStep("target_probe", "compiler", executableIdentity, ["-dumpmachine"], error, workspace, executablePath));
        return unsupported(
          this.backendId,
          request.sourceRevisionDigest,
          this.#configurationIdentity,
          requestedCompilerPath,
          "FIRMWARE_TOOLCHAIN_TARGET_UNSUPPORTED",
          "The configured compiler did not return a native target triple.",
          steps
        );
      }
      steps.push(stepFrom("target_probe", "compiler", executableIdentity, ["-dumpmachine"], targetResult, workspace, executablePath));
      targetTriple = targetResult.stdout.trim();
      if (
        targetResult.exitCode !== 0 ||
        targetTriple.length === 0 ||
        !targetMatchesHost(targetTriple)
      ) {
        return unsupported(
          this.backendId,
          request.sourceRevisionDigest,
          this.#configurationIdentity,
          requestedCompilerPath,
          "FIRMWARE_TOOLCHAIN_TARGET_UNSUPPORTED",
          "Only a compiler targeting the current host may run the generated validation executable.",
          steps
        );
      }
      tool = {
        name: compilerFamily,
        version: identified.version,
        adapter: "external",
        executablePath,
        executableDigest: executableIdentity.digest,
        capabilityProfile: `native-c11:${targetTriple}`
      };

      const currentExecutable = (await stableOrdinaryFile(
        executablePath,
        this.configuration.resourceLimits.maxCompilerBytes,
      )).identity;
      if (
        currentExecutable.digest !== executableIdentity.digest ||
        currentExecutable.size !== executableIdentity.size
      ) {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_TOOLCHAIN_MUTATED",
          "The compiler executable changed after identification and before compilation.",
          steps,
          tool,
          executableIdentity
        );
      }

      const executableName =
        process.platform === "win32"
          ? "build/board_contract_validation.exe"
          : "build/board_contract_validation";
      const compileArguments = [...firmwareCompileArguments()];
      let compileResult: BoundedProcessResult;
      try {
        compileResult = await this.#runner({
          command: executablePath,
          args: compileArguments,
          cwd: workspace,
          env: environment,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: this.#maxOutputBytes
        });
      } catch (error) {
        steps.push(
          failureStep("compile_and_link", "compiler", executableIdentity, compileArguments, error, workspace, executablePath)
        );
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_COMPILE_INVOCATION_FAILED",
          "The bounded compiler invocation failed before returning a usable exit status.",
          steps,
          tool,
          executableIdentity
        );
      }
      steps.push(
        stepFrom("compile_and_link", "compiler", executableIdentity, compileArguments, compileResult, workspace, executablePath)
      );
      if (compileResult.exitCode !== 0) {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_COMPILE_FAILED",
          "The generated C11 scaffold did not compile and link without diagnostics promoted to errors.",
          steps,
          tool,
          executableIdentity
        );
      }

      const validationPath = path.join(workspace, ...executableName.split("/"));
      let validationExecutableBytes: Buffer;
      let validationExecutableIdentity: ContentIdentity;
      try {
        const captured = await stableOrdinaryFile(
          validationPath,
          this.configuration.resourceLimits.maxValidationExecutableBytes,
        );
        validationExecutableBytes = captured.bytes;
        validationExecutableIdentity = captured.identity;
      } catch {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_COMPILE_OUTPUT_MISSING",
          "The compiler reported success but did not create the expected bounded ordinary validation executable.",
          steps,
          tool,
          executableIdentity
        );
      }
      const privateValidationPath = path.join(workspace, "run", path.basename(validationPath));
      try {
        await writeVerifiedPrivateFile(
          privateValidationPath,
          validationExecutableBytes,
          validationExecutableIdentity,
          true,
        );
      } catch {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_VALIDATION_COPY_FAILED",
          "The validation executable could not be copied into a verified private execution path.",
          steps,
          tool,
          executableIdentity
        );
      }

      let validationResult: BoundedProcessResult;
      try {
        validationResult = await this.#runner({
          command: privateValidationPath,
          args: [],
          cwd: workspace,
          env: environment,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: this.#maxOutputBytes
        });
      } catch (error) {
        steps.push(failureStep("validation_test", "validation_executable", validationExecutableIdentity, [], error, workspace, executablePath));
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_VALIDATION_EXECUTION_FAILED",
          "The compiled generated validation executable could not complete its bounded run.",
          steps,
          tool,
          executableIdentity
        );
      }
      steps.push(stepFrom("validation_test", "validation_executable", validationExecutableIdentity, [], validationResult, workspace, executablePath));
      if (validationResult.exitCode !== 0) {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_VALIDATION_TEST_FAILED",
          "The generated scaffold compiled, but its generated validation executable failed.",
          steps,
          tool,
          executableIdentity
        );
      }
      const finalValidationIdentity = (await stableOrdinaryFile(
        privateValidationPath,
        this.configuration.resourceLimits.maxValidationExecutableBytes,
      )).identity;
      if (
        finalValidationIdentity.digest !== validationExecutableIdentity.digest ||
        finalValidationIdentity.size !== validationExecutableIdentity.size
      ) {
        return failed(this.backendId, request, requestedCompilerPath, compilerFamily, targetTriple,
          "FIRMWARE_VALIDATION_BINARY_MUTATED", "The generated validation executable changed during execution.",
          steps, tool, executableIdentity);
      }

      let finalExecutableIdentity: ContentIdentity;
      try {
        finalExecutableIdentity = (await stableOrdinaryFile(
          executablePath,
          this.configuration.resourceLimits.maxCompilerBytes,
        )).identity;
      } catch {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_TOOLCHAIN_MUTATED",
          "The compiler executable became unreadable before final identity verification.",
          steps,
          tool,
          executableIdentity
        );
      }
      if (
        finalExecutableIdentity.digest !== executableIdentity.digest ||
        finalExecutableIdentity.size !== executableIdentity.size
      ) {
        return failed(
          this.backendId,
          request,
          requestedCompilerPath,
          compilerFamily,
          targetTriple,
          "FIRMWARE_TOOLCHAIN_MUTATED",
          "The compiler executable changed during generated-firmware validation.",
          steps,
          tool,
          executableIdentity
        );
      }

      for (const source of request.sources) {
        const current = (await stableOrdinaryFile(
          path.join(workspace, sourceFileName(source.logicalName)),
          this.configuration.resourceLimits.maxSourceBytes,
        )).identity;
        if (current.digest !== source.identity.digest || current.size !== source.identity.size) {
          return failed(
            this.backendId,
            request,
            requestedCompilerPath,
            compilerFamily,
            targetTriple,
            "FIRMWARE_SOURCE_MUTATED_DURING_VALIDATION",
            "A private generated source copy changed during host compilation or validation.",
            steps,
            tool,
            executableIdentity
          );
        }
      }

      return {
        schemaVersion: "evleda.firmware-compile-result.v1",
        sourceRevisionDigest: request.sourceRevisionDigest,
        configurationIdentity: request.configurationIdentity,
        status: "pass",
        code: "FIRMWARE_HOST_C11_VALIDATION_PASSED",
        message:
          "The exact generated scaffold compiled, linked, and passed its generated host validation test; target-MCU and physical behavior remain unproven.",
        backendId: this.backendId,
        requestedCompilerPath: executablePath,
        compilerFamily,
        targetTriple,
        tool,
        executableIdentity,
        validationExecutableIdentity,
        compiledSources: request.sources.map((source) => ({
          logicalName: source.logicalName,
          identity: source.identity
        })),
        steps
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
