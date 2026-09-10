import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPortableBytes,
  canonicalPortableJson,
  capturePortableRawBytes,
  decodeCapturedPortableUtf8,
  hardenPortableValue,
  portableCanonicalIdentity,
  portableContentIdentity,
  validateCanonicalIdentity,
  validateContentIdentity,
  validatePortableEnvironmentPolicyV1,
  validatePortablePathRefV1,
  validatePortableSourceBindingV1,
  validateToolContentIdentityV1,
  validateTypedCommandPlanV1,
  withCommandPlanIdentity,
  type PortableEnvironmentPolicyV1,
  type PortablePathRefV1,
  type PortableReportKind,
  type PortableSourceBindingV1,
  type ToolContentIdentityV1,
  type TypedCommandArgumentV1,
  type TypedCommandPlanV1,
} from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type {
  NativeProcessPlanV1,
  NativeProcessPlanIdentity,
  NativeProcessPlanV2,
  NativeProcessPlanIdentityV2,
  NativeProcessPortableCommandV1,
  NativeProcessToolV1,
} from "../domain/types.js";
import {
  acceptedExitCodesForNativeProcessProfile,
  buildNativeProcessPlanV1,
  buildNativeProcessPlanV2,
  validateNativeProcessPlanV1,
  validateNativeProcessPlanV2,
  type ApprovedNativeProcessContractValidator,
  type ApprovedNativeProcessContractValidatorV2,
} from "../domain/native-process-plan.js";
import {
  assertDisjointDirectories,
  assertPathWithin,
  resolveConfinedCandidate,
  resolveConfinedExistingFile,
  resolveExistingDirectory,
  resolveExistingFile,
} from "./path-boundary.js";

export const PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_SCHEMA =
  "evleda.kicad-runtime-command-contract.v1" as const;
export const PORTABLE_KICAD_SOURCE_CONTRACT_PREIMAGE_SCHEMA =
  "evleda.kicad-source-contract-preimage.v1" as const;
export const PORTABLE_KICAD_SOURCE_REVISION_PREIMAGE_SCHEMA =
  "evleda.kicad-source-revision-preimage.v1" as const;
export const PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_SCHEMA =
  "evleda.kicad-native-validation-contract-preimage.v1" as const;
export const PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_V2_SCHEMA =
  "evleda.kicad-native-validation-contract-preimage.v2" as const;
export const PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_SCHEMA =
  "evleda.kicad-normalizer-contract-preimage.v1" as const;
export const PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_V2_SCHEMA =
  "evleda.kicad-normalizer-contract-preimage.v2" as const;
export const PORTABLE_KICAD_CAPABILITY_MANIFEST_SCHEMA =
  "evleda.kicad-capability-manifest.v1" as const;
export const PORTABLE_KICAD_HELP_CAPTURE_SCHEMA =
  "evleda.kicad-help-capture.v1" as const;
export const PORTABLE_KICAD_PRIVATE_RESOLUTION_SCHEMA =
  "evleda.private-resolved-kicad-invocation.v1" as const;
export const PORTABLE_KICAD_PRIVATE_RESOLUTION_V2_SCHEMA =
  "evleda.private-resolved-kicad-invocation.v2" as const;
export const PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_SCHEMA =
  "evleda.kicad-output-byte-ceilings.v1" as const;
export const PORTABLE_KICAD_RUNTIME_TIMEOUT_MS = 120_000;
export const PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES = 1_048_576;

export type PortableKicadCommandKindV1 = PortableReportKind | "kicad_pdf";

export interface PortableKicadCommandSpecV1 {
  readonly argv: readonly string[];
  readonly sourceSuffix: ".kicad_sch" | ".kicad_pcb";
  readonly outputSuffix:
    | ".erc.json"
    | ".drc.json"
    | ".kicad_net"
    | ".stats.json"
    | ".d356"
    | ".pdf";
  readonly acceptedExitCodes: readonly number[];
  readonly sourceDisposition: "read-only" | "isolated-writable-copy";
  readonly sourceSnapshotPrefix: string;
  readonly privateOutputPrefix: string;
  readonly sourceEvaluationCapture: "command-input" | "post-refill-and-save";
  readonly publicSemantics:
    | "portable-v2"
    | "portable-rev-a-v2"
    | "private-non-semantic";
}

export interface PortableKicadRuntimeCommandContractV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_SCHEMA;
  readonly authority: "command-consistency-only";
  readonly nativeTool: "kicad-cli";
  readonly nativeMajorVersion: 10;
  readonly commands: Readonly<Record<PortableKicadCommandKindV1, PortableKicadCommandSpecV1>>;
  readonly releaseAuthorized: false;
}

const commandContractDraft = {
  schemaVersion: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_SCHEMA,
  authority: "command-consistency-only",
  nativeTool: "kicad-cli",
  nativeMajorVersion: 10,
  commands: {
    kicad_erc: {
      argv: [
        "sch",
        "erc",
        "--format",
        "json",
        "--units",
        "mm",
        "--severity-all",
        "--exit-code-violations",
        "--output",
        "<output>",
        "<source>",
      ],
      sourceSuffix: ".kicad_sch",
      outputSuffix: ".erc.json",
      acceptedExitCodes: [0, 5],
      sourceDisposition: "read-only",
      sourceSnapshotPrefix: "snapshots/kicad_erc",
      privateOutputPrefix: "captures/kicad_erc",
      sourceEvaluationCapture: "command-input",
      publicSemantics: "portable-v2",
    },
    kicad_drc: {
      argv: [
        "pcb",
        "drc",
        "--schematic-parity",
        "--refill-zones",
        "--save-board",
        "--format",
        "json",
        "--units",
        "mm",
        "--severity-all",
        "--exit-code-violations",
        "--output",
        "<output>",
        "<source>",
      ],
      sourceSuffix: ".kicad_pcb",
      outputSuffix: ".drc.json",
      acceptedExitCodes: [0, 5],
      sourceDisposition: "isolated-writable-copy",
      sourceSnapshotPrefix: "snapshots/kicad_drc",
      privateOutputPrefix: "captures/kicad_drc",
      sourceEvaluationCapture: "post-refill-and-save",
      publicSemantics: "portable-v2",
    },
    kicad_netlist: {
      argv: ["sch", "export", "netlist", "--output", "<output>", "<source>"],
      sourceSuffix: ".kicad_sch",
      outputSuffix: ".kicad_net",
      acceptedExitCodes: [0],
      sourceDisposition: "read-only",
      sourceSnapshotPrefix: "snapshots/kicad_netlist",
      privateOutputPrefix: "captures/kicad_netlist",
      sourceEvaluationCapture: "command-input",
      publicSemantics: "portable-v2",
    },
    kicad_stats: {
      argv: [
        "pcb",
        "export",
        "stats",
        "--format",
        "json",
        "--output",
        "<output>",
        "<source>",
      ],
      sourceSuffix: ".kicad_pcb",
      outputSuffix: ".stats.json",
      acceptedExitCodes: [0],
      sourceDisposition: "read-only",
      sourceSnapshotPrefix: "snapshots/kicad_stats",
      privateOutputPrefix: "captures/kicad_stats",
      sourceEvaluationCapture: "command-input",
      publicSemantics: "portable-v2",
    },
    kicad_d356: {
      argv: ["pcb", "export", "ipcd356", "--output", "<output>", "<source>"],
      sourceSuffix: ".kicad_pcb",
      outputSuffix: ".d356",
      acceptedExitCodes: [0],
      sourceDisposition: "read-only",
      sourceSnapshotPrefix: "snapshots/kicad_d356",
      privateOutputPrefix: "captures/kicad_d356",
      sourceEvaluationCapture: "command-input",
      publicSemantics: "portable-rev-a-v2",
    },
    kicad_pdf: {
      argv: ["sch", "export", "pdf", "--output", "<output>", "<source>"],
      sourceSuffix: ".kicad_sch",
      outputSuffix: ".pdf",
      acceptedExitCodes: [0],
      sourceDisposition: "read-only",
      sourceSnapshotPrefix: "snapshots/kicad_pdf",
      privateOutputPrefix: "captures/kicad_pdf",
      sourceEvaluationCapture: "command-input",
      publicSemantics: "private-non-semantic",
    },
  },
  releaseAuthorized: false,
} as const;

export const PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1 = hardenPortableValue(
  commandContractDraft,
) as PortableKicadRuntimeCommandContractV1;

export const PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1 =
  portableCanonicalIdentity(
    PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1,
    PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_SCHEMA,
  );

export interface PortableKicadOutputByteCeilingsV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_SCHEMA;
  readonly authority: "parser-bound";
  readonly limits: Readonly<Record<PortableKicadCommandKindV1, number>>;
}

export const PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1 = hardenPortableValue({
  schemaVersion: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_SCHEMA,
  authority: "parser-bound",
  limits: {
    kicad_erc: 8_388_608,
    kicad_drc: 8_388_608,
    kicad_netlist: 16_777_216,
    kicad_stats: 2_097_152,
    kicad_d356: 16_777_216,
    kicad_pdf: 16_777_216,
  },
}) as PortableKicadOutputByteCeilingsV1;

export const PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_IDENTITY_V1 =
  portableCanonicalIdentity(
    PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1,
    PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_SCHEMA,
  );

export interface PortableKicadCapabilityProbeSpecV1 {
  readonly args: readonly string[];
  readonly required: readonly string[];
}

/** The help surface that must exist before any V2/PDF runtime plan is usable. */
export const PORTABLE_KICAD_RUNTIME_CAPABILITY_PROBES_V1 = hardenPortableValue([
  {
    args: ["sch", "erc", "--help"],
    required: ["--format", "json", "--units", "--severity-all", "--exit-code-violations"],
  },
  {
    args: ["pcb", "drc", "--help"],
    required: [
      "--schematic-parity",
      "--refill-zones",
      "--save-board",
      "--format",
      "json",
      "--units",
      "--severity-all",
      "--exit-code-violations",
    ],
  },
  {
    args: ["sch", "export", "netlist", "--help"],
    required: ["--output", "--format", "kicadsexpr"],
  },
  {
    args: ["pcb", "export", "stats", "--help"],
    required: ["--output", "--format", "json", "--units"],
  },
  {
    args: ["pcb", "export", "ipcd356", "--help"],
    required: ["--output"],
  },
  {
    args: ["sch", "export", "pdf", "--help"],
    required: ["--output"],
  },
]) as readonly PortableKicadCapabilityProbeSpecV1[];

export interface ReviewedKicadD356ProfileV1 {
  readonly schemaVersion: "evleda.kicad-d356-rev-a-profile.v1";
  readonly profileId: "robotics-controller-v0";
  readonly boardRevision: "EVL-RC-G0-REV-A";
  readonly payloadSchemaVersion: "evleda.portable-kicad-d356-rev-a.v2";
  readonly reviewedNativeContractIdentity: CanonicalIdentity;
  readonly reviewedNativeContractContentIdentity: ContentIdentity;
  readonly exactBoardContentIdentity: ContentIdentity;
  readonly identity: CanonicalIdentity;
}

const d356ProfilePreimage = hardenPortableValue({
  schemaVersion: "evleda.kicad-d356-rev-a-profile.v1",
  profileId: "robotics-controller-v0",
  boardRevision: "EVL-RC-G0-REV-A",
  payloadSchemaVersion: "evleda.portable-kicad-d356-rev-a.v2",
  reviewedNativeContractIdentity: {
    algorithm: "sha256",
    digest: "82044fa6dd7467e5c08eae734fe51d33e2bd04a854eb4b0b7a167c6fe8c47789",
    schemaVersion: "evleda.reference-controller-native-contract.v1",
    canonicalizationVersion: "evleda-c14n-json-v1",
  },
  reviewedNativeContractContentIdentity: {
    algorithm: "sha256",
    digest: "573ddc66cfdfcbbc48a2a3d02d1fd29a57efd2cb26d0ce7dc79b9eac86adcc4d",
    size: 8_889,
  },
  exactBoardContentIdentity: {
    algorithm: "sha256",
    digest: "c74b10669a551225882e11372fe29a6ee28c92005ad47f9979d14bf741aff214",
    size: 1_615_312,
  },
}) as Omit<ReviewedKicadD356ProfileV1, "identity">;

export const REVIEWED_KICAD_D356_REV_A_PROFILE_V1 = hardenPortableValue({
  ...d356ProfilePreimage,
  identity: portableCanonicalIdentity(
    d356ProfilePreimage,
    "evleda.kicad-d356-rev-a-profile.v1",
  ),
}) as ReviewedKicadD356ProfileV1;

export const PORTABLE_KICAD_ENVIRONMENT_POLICY_V1 =
  validatePortableEnvironmentPolicyV1({
    schemaVersion: "evleda.portable-environment-policy.v1",
    pythonHashSeed: "0",
    pythonUtf8: "1",
    locale: "C",
    timezone: "UTC",
    privateFields: [
      { name: "HOME", disposition: "excluded-private" },
      { name: "KICAD_CONFIG_HOME", disposition: "excluded-private" },
      { name: "TEMP", disposition: "excluded-private" },
      { name: "TMP", disposition: "excluded-private" },
    ],
  });

export class PortableKicadRuntimeError extends Error {
  override readonly name = "PortableKicadRuntimeError";
}

function fail(message: string): never {
  throw new PortableKicadRuntimeError(message);
}

function portableRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactRecordKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function sameContentIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.size === right.size
  );
}

function sameCanonicalIdentity(left: CanonicalIdentity, right: CanonicalIdentity): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.schemaVersion === right.schemaVersion &&
    left.canonicalizationVersion === right.canonicalizationVersion
  );
}

function assertNativeTool(tool: ToolContentIdentityV1): void {
  if (
    tool.role !== "native_validator" ||
    tool.kind !== "native_executable" ||
    tool.name !== "kicad-cli" ||
    !/^10\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tool.version)
  ) {
    fail("Portable KiCad commands require an exact KiCad 10 native-validator identity.");
  }
}

function assertD356Profile(
  commandKind: PortableKicadCommandKindV1,
  profile: ReviewedKicadD356ProfileV1 | undefined,
): void {
  if (commandKind !== "kicad_d356") {
    if (profile !== undefined) {
      fail("A D356 normalization profile cannot be attached to another command kind.");
    }
    return;
  }
  if (profile === undefined) {
    fail("Portable D356 V2 is confined to the reviewed Rev-A profile.");
  }
  const safeIdentity = validateCanonicalIdentity(profile.identity, "$d356Profile/identity");
  if (
    canonicalPortableJson(profile) !==
      canonicalPortableJson(REVIEWED_KICAD_D356_REV_A_PROFILE_V1) ||
    !sameCanonicalIdentity(safeIdentity, REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity)
  ) {
    fail("Portable D356 V2 received an unreviewed or modified profile.");
  }
}

export interface KicadCapabilityProbeCaptureV1 {
  readonly argv: readonly string[];
  readonly requiredTokens: readonly string[];
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
}

export interface KicadCapabilityByteEvidenceV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_CAPABILITY_MANIFEST_SCHEMA;
  readonly authority: "observed-not-authenticated";
  readonly helpCaptureBytes: Uint8Array;
  readonly capabilityManifestBytes: Uint8Array;
  readonly helpIdentity: ContentIdentity;
  readonly capabilitiesIdentity: ContentIdentity;
}

/**
 * Capture identities are integrity-only. They bind the exact observed help text
 * and the capability projection derived from it; they do not authenticate who
 * supplied the executable or establish that it is safe.
 */
export function buildKicadCapabilityByteEvidenceV1(input: {
  readonly version: string;
  readonly commit: string;
  readonly probes: readonly KicadCapabilityProbeCaptureV1[];
}): KicadCapabilityByteEvidenceV1 {
  if (input.probes.length === 0 || input.probes.length > 64) {
    fail("KiCad capability evidence requires a bounded nonempty probe set.");
  }
  const seen = new Set<string>();
  const helpCaptures: Array<Readonly<Record<string, unknown>>> = [];
  const capabilities = input.probes.map((probe) => {
    if (
      probe.argv.length < 2 ||
      probe.argv.at(-1) !== "--help" ||
      probe.requiredTokens.length === 0
    ) {
      fail("KiCad capability probes must be explicit help commands with required tokens.");
    }
    const command = probe.argv.join(" ");
    if (seen.has(command)) fail("Duplicate KiCad capability probe.");
    seen.add(command);
    const stdoutSnapshot = capturePortableRawBytes(probe.stdoutBytes, 1_048_576, true);
    const stderrSnapshot = capturePortableRawBytes(probe.stderrBytes, 1_048_576, true);
    const observed = `${decodeCapturedPortableUtf8(stdoutSnapshot, "KiCad help stdout", true)}\n${decodeCapturedPortableUtf8(stderrSnapshot, "KiCad help stderr", true)}`;
    for (const token of probe.requiredTokens) {
      if (!observed.includes(token)) {
        fail(`KiCad help for '${command}' lacks required token '${token}'.`);
      }
    }
    const captured = {
      command,
      argv: [...probe.argv],
      stdoutIdentity: stdoutSnapshot.identity,
      stderrIdentity: stderrSnapshot.identity,
    };
    helpCaptures.push(captured);
    return { ...captured, requiredTokens: [...probe.requiredTokens] };
  });
  const helpCaptureBytes = canonicalPortableBytes({
    schemaVersion: PORTABLE_KICAD_HELP_CAPTURE_SCHEMA,
    authority: "observed-not-authenticated",
    version: input.version,
    commit: input.commit,
    captures: helpCaptures,
  });
  const capabilityManifestBytes = canonicalPortableBytes({
    schemaVersion: PORTABLE_KICAD_CAPABILITY_MANIFEST_SCHEMA,
    authority: "observed-not-authenticated",
    version: input.version,
    commit: input.commit,
    capabilities,
  });
  const privateHelpCaptureBytes = Buffer.from(helpCaptureBytes);
  const privateCapabilityManifestBytes = Buffer.from(capabilityManifestBytes);
  const helpIdentity = portableContentIdentity(privateHelpCaptureBytes);
  const capabilitiesIdentity = portableContentIdentity(privateCapabilityManifestBytes);
  return Object.freeze({
    schemaVersion: PORTABLE_KICAD_CAPABILITY_MANIFEST_SCHEMA,
    authority: "observed-not-authenticated",
    get helpCaptureBytes(): Uint8Array {
      return Buffer.from(privateHelpCaptureBytes);
    },
    get capabilityManifestBytes(): Uint8Array {
      return Buffer.from(privateCapabilityManifestBytes);
    },
    helpIdentity,
    capabilitiesIdentity,
  });
}

export function buildKicadNativeToolIdentityV1(input: {
  readonly version: string;
  readonly commit: string;
  readonly executableContentIdentity: ContentIdentity;
  readonly helpCaptureBytes: Uint8Array;
  readonly capabilityManifestBytes: Uint8Array;
}): ToolContentIdentityV1 {
  return validateToolContentIdentityV1({
    schemaVersion: "evleda.tool-content-identity.v1",
    role: "native_validator",
    kind: "native_executable",
    name: "kicad-cli",
    version: input.version,
    commit: input.commit,
    contentIdentity: validateContentIdentity(
      input.executableContentIdentity,
      "$nativeTool/executableContentIdentity",
    ),
    capabilitiesIdentity: portableContentIdentity(input.capabilityManifestBytes),
    helpIdentity: portableContentIdentity(input.helpCaptureBytes),
  });
}

export function buildPortableKicadNormalizerToolIdentityV1(input: {
  readonly name: string;
  readonly version: string;
  readonly commit: string;
  readonly implementationBytes: Uint8Array;
  readonly capabilityBytes: Uint8Array;
  readonly helpBytes: Uint8Array;
}): ToolContentIdentityV1 {
  return validateToolContentIdentityV1({
    schemaVersion: "evleda.tool-content-identity.v1",
    role: "portable_normalizer",
    kind: "portable_implementation",
    name: input.name,
    version: input.version,
    commit: input.commit,
    contentIdentity: portableContentIdentity(input.implementationBytes),
    capabilitiesIdentity: portableContentIdentity(input.capabilityBytes),
    helpIdentity: portableContentIdentity(input.helpBytes),
  });
}

export interface PortableKicadCommandPlanInputV1 {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly tool: ToolContentIdentityV1;
  readonly logicalCwd: PortablePathRefV1;
  readonly sourcePath: PortablePathRefV1;
  readonly outputPath: PortablePathRefV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}

function commandArguments(
  spec: PortableKicadCommandSpecV1,
  sourcePath: PortablePathRefV1,
  outputPath: PortablePathRefV1,
): readonly TypedCommandArgumentV1[] {
  return Object.freeze(
    spec.argv.map((argument): TypedCommandArgumentV1 => {
      if (argument === "<source>") return Object.freeze({ kind: "path", value: sourcePath });
      if (argument === "<output>") return Object.freeze({ kind: "path", value: outputPath });
      return Object.freeze({ kind: "literal", value: argument });
    }),
  );
}

export function buildPortableKicadCommandPlanV1(
  input: PortableKicadCommandPlanInputV1,
): TypedCommandPlanV1 {
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  if (spec === undefined) fail("Unsupported portable KiCad command kind.");
  const tool = validateToolContentIdentityV1(input.tool, "$plan/tool");
  assertNativeTool(tool);
  const logicalCwd = validatePortablePathRefV1(input.logicalCwd, "$plan/logicalCwd");
  const sourcePath = validatePortablePathRefV1(input.sourcePath, "$plan/sourcePath");
  const outputPath = validatePortablePathRefV1(input.outputPath, "$plan/outputPath");
  assertD356Profile(input.commandKind, input.d356Profile);
  if (
    logicalCwd.root !== "run_input" ||
    sourcePath.root !== "run_input" ||
    outputPath.root !== "run_private" ||
    logicalCwd.relativePath !== path.posix.dirname(sourcePath.relativePath) ||
    !sourcePath.relativePath.startsWith(`${spec.sourceSnapshotPrefix}/`) ||
    !outputPath.relativePath.startsWith(`${spec.privateOutputPrefix}/`) ||
    !sourcePath.relativePath.endsWith(spec.sourceSuffix) ||
    !outputPath.relativePath.endsWith(spec.outputSuffix)
  ) {
    fail("Portable KiCad command paths do not match their fixed root and extension matrix.");
  }
  const plan = withCommandPlanIdentity({
    schemaVersion: "evleda.typed-command-plan.v1",
    tool,
    logicalCwd,
    argv: commandArguments(spec, sourcePath, outputPath),
    environment: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1,
    expectedOutputs: [outputPath],
  });
  assertPortableKicadCommandPlanV1(plan, input.commandKind, input.d356Profile);
  return plan;
}

export function assertPortableKicadCommandPlanV1(
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
  d356Profile?: ReviewedKicadD356ProfileV1,
): TypedCommandPlanV1 {
  const plan = validateTypedCommandPlanV1(value, "$runtimeCommandPlan");
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[commandKind];
  if (spec === undefined) fail("Unsupported portable KiCad command kind.");
  assertNativeTool(plan.tool);
  assertD356Profile(commandKind, d356Profile);
  const signature = plan.argv.map((entry) =>
    entry.kind === "literal"
      ? entry.value
      : entry.value.root === "run_private"
        ? "<output>"
        : "<source>",
  );
  if (canonicalPortableJson(signature) !== canonicalPortableJson(spec.argv)) {
    fail("Portable KiCad command does not match the versioned runtime command contract.");
  }
  const outputArgument = plan.argv.at(-2);
  const sourceArgument = plan.argv.at(-1);
  if (
    plan.logicalCwd.root !== "run_input" ||
    sourceArgument?.kind !== "path" ||
    sourceArgument.value.root !== "run_input" ||
    !sourceArgument.value.relativePath.startsWith(`${spec.sourceSnapshotPrefix}/`) ||
    !sourceArgument.value.relativePath.endsWith(spec.sourceSuffix) ||
    outputArgument?.kind !== "path" ||
    outputArgument.value.root !== "run_private" ||
    !outputArgument.value.relativePath.startsWith(`${spec.privateOutputPrefix}/`) ||
    !outputArgument.value.relativePath.endsWith(spec.outputSuffix) ||
    plan.logicalCwd.relativePath !== path.posix.dirname(sourceArgument.value.relativePath) ||
    plan.expectedOutputs.length !== 1 ||
    canonicalPortableJson(plan.expectedOutputs[0]) !==
      canonicalPortableJson(outputArgument.value) ||
    canonicalPortableJson(plan.environment) !==
      canonicalPortableJson(PORTABLE_KICAD_ENVIRONMENT_POLICY_V1)
  ) {
    fail("Portable KiCad command path, output, cwd, or environment matrix mismatch.");
  }
  return plan;
}

function nativeProcessTool(tool: ToolContentIdentityV1): NativeProcessToolV1 {
  assertNativeTool(tool);
  return tool as NativeProcessToolV1;
}

function portableNativeProcessCommand(
  commandPlan: TypedCommandPlanV1,
): NativeProcessPortableCommandV1 {
  return commandPlan as unknown as NativeProcessPortableCommandV1;
}

/**
 * Wrap the frozen Portable Validation command exactly once in the neutral
 * native-process plan consumed by the durable W-08 invocation ledger.
 */
export function buildPortableKicadNativeProcessPlanV1(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly commandPlan: TypedCommandPlanV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): NativeProcessPlanV1 {
  const commandPlan = assertPortableKicadCommandPlanV1(
    input.commandPlan,
    input.commandKind,
    input.d356Profile,
  );
  const profile = {
    schemaVersion: "evleda.native-process-profile.kicad.v1" as const,
    domain: "kicad" as const,
    operation: input.commandKind,
    contractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
  };
  const plan = buildNativeProcessPlanV1({
    schemaVersion: "evleda.native-process-plan.v1",
    transport: "native_process",
    profile,
    tool: nativeProcessTool(commandPlan.tool),
    command: {
      kind: "portable_typed_command_v1",
      value: portableNativeProcessCommand(commandPlan),
    },
    acceptedExitCodes: acceptedExitCodesForNativeProcessProfile(profile),
    timeoutMs: PORTABLE_KICAD_RUNTIME_TIMEOUT_MS,
    maxStdoutBytes: PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES,
    maxStderrBytes: PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES,
    inputPolicy: {
      schemaVersion: "evleda.native-process-input-policy.v1",
      snapshot: "immutable_before_spawn",
      mutation: input.commandKind === "kicad_drc" ? "isolated_copy" : "immutable",
      evaluatedInput:
        input.commandKind === "kicad_drc"
          ? "post_execution_snapshot"
          : "command_input",
    },
  });
  return assertPortableKicadNativeProcessPlanV1(
    plan,
    input.commandKind,
    input.d356Profile,
  );
}

export function assertPortableKicadNativeProcessPlanV1(
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
  d356Profile?: ReviewedKicadD356ProfileV1,
): NativeProcessPlanV1 {
  const plan = validateNativeProcessPlanV1(value);
  if (
    plan.transport !== "native_process" ||
    plan.profile.domain !== "kicad" ||
    plan.profile.schemaVersion !== "evleda.native-process-profile.kicad.v1" ||
    plan.profile.operation !== commandKind ||
    !sameCanonicalIdentity(
      plan.profile.contractIdentity,
      PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    ) ||
    plan.command.kind !== "portable_typed_command_v1" ||
    plan.timeoutMs !== PORTABLE_KICAD_RUNTIME_TIMEOUT_MS ||
    plan.maxStdoutBytes !== PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES ||
    plan.maxStderrBytes !== PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES
  ) {
    fail("Native-process plan does not match the exact KiCad runtime profile.");
  }
  const commandPlan = assertPortableKicadCommandPlanV1(
    plan.command.value,
    commandKind,
    d356Profile,
  );
  if (
    canonicalPortableJson(plan.tool) !== canonicalPortableJson(commandPlan.tool) ||
    canonicalPortableJson(plan.acceptedExitCodes) !==
      canonicalPortableJson(
        PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[commandKind]
          .acceptedExitCodes,
      )
  ) {
    fail("Native-process KiCad tool or accepted-exit policy disagrees with its command.");
  }
  return plan;
}

/**
 * Pure approved-contract check for persistence/replay boundaries. The operation
 * is taken from the verified plan itself and then checked against the exact
 * KiCad contract; callers cannot choose a friendlier operation validator.
 * This approves command shape only, never executable authenticity or release.
 */
export function assertApprovedPortableKicadNativeProcessPlanV1(
  value: unknown,
): NativeProcessPlanV1 {
  const plan = validateNativeProcessPlanV1(value);
  if (plan.profile.domain !== "kicad") {
    fail("The approved KiCad command validator rejects non-KiCad process plans.");
  }
  const commandKind = plan.profile.operation;
  return assertPortableKicadNativeProcessPlanV1(
    plan,
    commandKind,
    commandKind === "kicad_d356" ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1 : undefined,
  );
}

export const APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V1 = Object.freeze({
  validatorId: "evleda.portable-kicad-runtime-contract.v1",
  profileDomain: "kicad",
  operations: Object.freeze([
    "kicad_erc",
    "kicad_drc",
    "kicad_netlist",
    "kicad_stats",
    "kicad_d356",
    "kicad_pdf",
  ] as const),
  contractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
  assertApproved: assertApprovedPortableKicadNativeProcessPlanV1,
}) satisfies ApprovedNativeProcessContractValidator;

/** Current native-process envelope with exact per-output parser ceilings. */
export function buildPortableKicadNativeProcessPlanV2(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly commandPlan: TypedCommandPlanV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): NativeProcessPlanV2 {
  const commandPlan = assertPortableKicadCommandPlanV1(
    input.commandPlan,
    input.commandKind,
    input.d356Profile,
  );
  const profile = {
    schemaVersion: "evleda.native-process-profile.kicad.v1" as const,
    domain: "kicad" as const,
    operation: input.commandKind,
    contractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
  };
  const plan = buildNativeProcessPlanV2({
    schemaVersion: "evleda.native-process-plan.v2",
    transport: "native_process",
    profile,
    tool: nativeProcessTool(commandPlan.tool),
    command: {
      kind: "portable_typed_command_v1",
      value: portableNativeProcessCommand(commandPlan),
    },
    expectedOutputs: commandPlan.expectedOutputs.map((outputPath) => ({
      schemaVersion: "evleda.native-process-expected-output.v1" as const,
      path: outputPath,
      maxBytes: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits[input.commandKind],
    })),
    acceptedExitCodes: acceptedExitCodesForNativeProcessProfile(profile),
    timeoutMs: PORTABLE_KICAD_RUNTIME_TIMEOUT_MS,
    maxStdoutBytes: PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES,
    maxStderrBytes: PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES,
    inputPolicy: {
      schemaVersion: "evleda.native-process-input-policy.v1",
      snapshot: "immutable_before_spawn",
      mutation: input.commandKind === "kicad_drc" ? "isolated_copy" : "immutable",
      evaluatedInput:
        input.commandKind === "kicad_drc"
          ? "post_execution_snapshot"
          : "command_input",
    },
  });
  return assertPortableKicadNativeProcessPlanV2(
    plan,
    input.commandKind,
    input.d356Profile,
  );
}

export function assertPortableKicadNativeProcessPlanV2(
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
  d356Profile?: ReviewedKicadD356ProfileV1,
): NativeProcessPlanV2 {
  const plan = validateNativeProcessPlanV2(value);
  if (
    plan.transport !== "native_process" ||
    plan.profile.domain !== "kicad" ||
    plan.profile.schemaVersion !== "evleda.native-process-profile.kicad.v1" ||
    plan.profile.operation !== commandKind ||
    !sameCanonicalIdentity(
      plan.profile.contractIdentity,
      PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    ) ||
    plan.command.kind !== "portable_typed_command_v1" ||
    plan.timeoutMs !== PORTABLE_KICAD_RUNTIME_TIMEOUT_MS ||
    plan.maxStdoutBytes !== PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES ||
    plan.maxStderrBytes !== PORTABLE_KICAD_RUNTIME_STREAM_LIMIT_BYTES
  ) {
    fail("Native-process V2 plan does not match the exact KiCad runtime profile.");
  }
  const commandPlan = assertPortableKicadCommandPlanV1(
    plan.command.value,
    commandKind,
    d356Profile,
  );
  const expectedLimit = PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits[commandKind];
  if (
    canonicalPortableJson(plan.tool) !== canonicalPortableJson(commandPlan.tool) ||
    canonicalPortableJson(plan.acceptedExitCodes) !==
      canonicalPortableJson(
        PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[commandKind]
          .acceptedExitCodes,
      ) ||
    plan.expectedOutputs.length !== commandPlan.expectedOutputs.length ||
    plan.expectedOutputs.some(
      (descriptor, index) =>
        descriptor.maxBytes !== expectedLimit ||
        canonicalPortableJson(descriptor.path) !==
          canonicalPortableJson(commandPlan.expectedOutputs[index]),
    )
  ) {
    fail(
      "Native-process V2 KiCad tool, exits, output order/path, or byte ceiling disagrees with its approved contract.",
    );
  }
  return plan;
}

export function assertApprovedPortableKicadNativeProcessPlanV2(
  value: unknown,
): NativeProcessPlanV2 {
  const plan = validateNativeProcessPlanV2(value);
  if (plan.profile.domain !== "kicad") {
    fail("The approved KiCad V2 command validator rejects non-KiCad process plans.");
  }
  const commandKind = plan.profile.operation;
  return assertPortableKicadNativeProcessPlanV2(
    plan,
    commandKind,
    commandKind === "kicad_d356" ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1 : undefined,
  );
}

export const APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2 = Object.freeze({
  validatorId: "evleda.portable-kicad-runtime-contract.v2",
  profileDomain: "kicad",
  operations: Object.freeze([
    "kicad_erc",
    "kicad_drc",
    "kicad_netlist",
    "kicad_stats",
    "kicad_d356",
    "kicad_pdf",
  ] as const),
  contractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
  assertApproved: assertApprovedPortableKicadNativeProcessPlanV2,
}) satisfies ApprovedNativeProcessContractValidatorV2;

export interface PortableKicadSourceContractPreimageV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_SOURCE_CONTRACT_PREIMAGE_SCHEMA;
  readonly runtimeCommandContractIdentity: CanonicalIdentity;
  readonly commandKind: PortableKicadCommandKindV1;
  readonly sourceSuffix: string;
  readonly sourceSnapshotPrefix: string;
  readonly sourceEvaluationCapture: "command-input" | "post-refill-and-save";
  readonly d356ProfileIdentity: CanonicalIdentity | null;
  readonly releaseAuthorized: false;
}

export interface PortableKicadSourceRevisionPreimageV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_SOURCE_REVISION_PREIMAGE_SCHEMA;
  readonly sourcePath: PortablePathRefV1;
  readonly sourceArtifactIdentity: ContentIdentity;
  readonly sourceContractIdentity: CanonicalIdentity;
  readonly releaseAuthorized: false;
}

export interface PortableKicadSourceIdentitySetV1 {
  readonly sourceContractPreimage: PortableKicadSourceContractPreimageV1;
  readonly sourceRevisionPreimage: PortableKicadSourceRevisionPreimageV1;
  readonly sourceBinding: PortableSourceBindingV1;
}

export function validatePortableKicadSourceIdentitySetV1(
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
  d356Profile?: ReviewedKicadD356ProfileV1,
): PortableKicadSourceIdentitySetV1 {
  assertD356Profile(commandKind, d356Profile);
  const safe = portableRecord(hardenPortableValue(value), "KiCad source identity set");
  exactRecordKeys(
    safe,
    ["sourceContractPreimage", "sourceRevisionPreimage", "sourceBinding"],
    "KiCad source identity set",
  );
  const contract = portableRecord(
    safe.sourceContractPreimage,
    "KiCad source contract preimage",
  );
  exactRecordKeys(
    contract,
    [
      "schemaVersion",
      "runtimeCommandContractIdentity",
      "commandKind",
      "sourceSuffix",
      "sourceSnapshotPrefix",
      "sourceEvaluationCapture",
      "d356ProfileIdentity",
      "releaseAuthorized",
    ],
    "KiCad source contract preimage",
  );
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[commandKind];
  const runtimeContractIdentity = validateCanonicalIdentity(
    contract.runtimeCommandContractIdentity,
    "$sourceIdentitySet/sourceContractPreimage/runtimeCommandContractIdentity",
  );
  const expectedProfileIdentity =
    commandKind === "kicad_d356"
      ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
      : null;
  if (
    contract.schemaVersion !== PORTABLE_KICAD_SOURCE_CONTRACT_PREIMAGE_SCHEMA ||
    contract.commandKind !== commandKind ||
    contract.sourceSuffix !== spec.sourceSuffix ||
    contract.sourceSnapshotPrefix !== spec.sourceSnapshotPrefix ||
    contract.sourceEvaluationCapture !== spec.sourceEvaluationCapture ||
    contract.releaseAuthorized !== false ||
    !sameCanonicalIdentity(
      runtimeContractIdentity,
      PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    ) ||
    canonicalPortableJson(contract.d356ProfileIdentity) !==
      canonicalPortableJson(expectedProfileIdentity)
  ) {
    fail("KiCad source contract preimage does not match the runtime command contract.");
  }

  const revision = portableRecord(
    safe.sourceRevisionPreimage,
    "KiCad source revision preimage",
  );
  exactRecordKeys(
    revision,
    [
      "schemaVersion",
      "sourcePath",
      "sourceArtifactIdentity",
      "sourceContractIdentity",
      "releaseAuthorized",
    ],
    "KiCad source revision preimage",
  );
  if (
    revision.schemaVersion !== PORTABLE_KICAD_SOURCE_REVISION_PREIMAGE_SCHEMA ||
    revision.releaseAuthorized !== false
  ) {
    fail("KiCad source revision preimage has an unsupported schema or authority.");
  }
  const sourcePath = validatePortablePathRefV1(
    revision.sourcePath,
    "$sourceIdentitySet/sourceRevisionPreimage/sourcePath",
  );
  const sourceArtifactIdentity = validateContentIdentity(
    revision.sourceArtifactIdentity,
    "$sourceIdentitySet/sourceRevisionPreimage/sourceArtifactIdentity",
  );
  const sourceContractIdentity = validateCanonicalIdentity(
    revision.sourceContractIdentity,
    "$sourceIdentitySet/sourceRevisionPreimage/sourceContractIdentity",
  );
  const expectedSourceContractIdentity = portableCanonicalIdentity(
    contract,
    "evleda.source-contract.v1",
  );
  if (
    !sameCanonicalIdentity(sourceContractIdentity, expectedSourceContractIdentity) ||
    sourcePath.root !== "run_input" ||
    !sourcePath.relativePath.startsWith(`${spec.sourceSnapshotPrefix}/`) ||
    !sourcePath.relativePath.endsWith(spec.sourceSuffix)
  ) {
    fail("KiCad source revision does not reproduce its command-specific contract.");
  }
  if (
    commandKind === "kicad_d356" &&
    !sameContentIdentity(
      sourceArtifactIdentity,
      REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity,
    )
  ) {
    fail("Portable D356 V2 source binding is not the exact reviewed Rev-A PCB.");
  }
  const binding = validatePortableSourceBindingV1(
    safe.sourceBinding,
    "$sourceIdentitySet/sourceBinding",
  );
  const expectedSourceRevisionIdentity = portableCanonicalIdentity(
    revision,
    "evleda.source-revision.v1",
  );
  if (
    !sameCanonicalIdentity(binding.sourceContractIdentity, sourceContractIdentity) ||
    !sameCanonicalIdentity(binding.sourceRevisionIdentity, expectedSourceRevisionIdentity) ||
    !sameContentIdentity(binding.sourceArtifactIdentity, sourceArtifactIdentity) ||
    canonicalPortableJson(binding.sourcePath) !== canonicalPortableJson(sourcePath)
  ) {
    fail("KiCad source identity preimages do not reproduce their portable binding.");
  }
  return Object.freeze({
    sourceContractPreimage: contract as unknown as PortableKicadSourceContractPreimageV1,
    sourceRevisionPreimage: revision as unknown as PortableKicadSourceRevisionPreimageV1,
    sourceBinding: binding,
  });
}

export function buildPortableKicadSourceIdentitySetV1(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly sourcePath: PortablePathRefV1;
  readonly sourceBytes: Uint8Array;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): PortableKicadSourceIdentitySetV1 {
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  if (spec === undefined) fail("Unsupported portable KiCad command kind.");
  assertD356Profile(input.commandKind, input.d356Profile);
  const sourcePath = validatePortablePathRefV1(input.sourcePath, "$source/sourcePath");
  if (
    sourcePath.root !== "run_input" ||
    !sourcePath.relativePath.startsWith(`${spec.sourceSnapshotPrefix}/`) ||
    !sourcePath.relativePath.endsWith(spec.sourceSuffix)
  ) {
    fail("Portable KiCad source path does not match the command contract.");
  }
  const sourceArtifactIdentity = portableContentIdentity(input.sourceBytes);
  if (sourceArtifactIdentity.size === 0) {
    fail("Portable KiCad source bytes must not be empty.");
  }
  if (
    input.commandKind === "kicad_d356" &&
    !sameContentIdentity(
      sourceArtifactIdentity,
      REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity,
    )
  ) {
    fail("Portable D356 V2 requires the exact reviewed Rev-A PCB bytes.");
  }
  const sourceContractPreimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_SOURCE_CONTRACT_PREIMAGE_SCHEMA,
    runtimeCommandContractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    commandKind: input.commandKind,
    sourceSuffix: spec.sourceSuffix,
    sourceSnapshotPrefix: spec.sourceSnapshotPrefix,
    sourceEvaluationCapture: spec.sourceEvaluationCapture,
    d356ProfileIdentity:
      input.commandKind === "kicad_d356"
        ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
        : null,
    releaseAuthorized: false,
  }) as PortableKicadSourceContractPreimageV1;
  const sourceContractIdentity = portableCanonicalIdentity(
    sourceContractPreimage,
    "evleda.source-contract.v1",
  );
  const sourceRevisionPreimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_SOURCE_REVISION_PREIMAGE_SCHEMA,
    sourcePath,
    sourceArtifactIdentity,
    sourceContractIdentity,
    releaseAuthorized: false,
  }) as PortableKicadSourceRevisionPreimageV1;
  const sourceBinding = validatePortableSourceBindingV1({
    schemaVersion: "evleda.portable-source-binding.v1",
    sourceRevisionIdentity: portableCanonicalIdentity(
      sourceRevisionPreimage,
      "evleda.source-revision.v1",
    ),
    sourceArtifactIdentity,
    sourcePath,
    sourceContractIdentity,
  });
  return validatePortableKicadSourceIdentitySetV1(
    { sourceContractPreimage, sourceRevisionPreimage, sourceBinding },
    input.commandKind,
    input.d356Profile,
  );
}

export interface PortableKicadNativeContractPreimageV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_SCHEMA;
  readonly runtimeCommandContractIdentity: CanonicalIdentity;
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentity;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly sourceBinding: PortableSourceBindingV1;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly evaluatedSourceIdentity: ContentIdentity;
  readonly sourceEvaluationCapture: "command-input" | "post-refill-and-save";
  readonly sourceSnapshotPolicy: "one-command-one-copy";
  readonly tool: ToolContentIdentityV1;
  readonly acceptedExitCodes: readonly number[];
  readonly sourceDisposition: "read-only" | "isolated-writable-copy";
  readonly d356ProfileIdentity: CanonicalIdentity | null;
  readonly authority: "integrity-only";
  readonly releaseAuthorized: false;
}

export function buildPortableKicadNativeContractV1(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlan: NativeProcessPlanV1;
  readonly sourceIdentitySet: PortableKicadSourceIdentitySetV1;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): {
  readonly preimage: PortableKicadNativeContractPreimageV1;
  readonly identity: CanonicalIdentity;
} {
  const nativeProcessPlan = assertPortableKicadNativeProcessPlanV1(
    input.nativeProcessPlan,
    input.commandKind,
    input.d356Profile,
  );
  if (nativeProcessPlan.command.kind !== "portable_typed_command_v1") {
    fail("KiCad native contract requires the portable typed-command variant.");
  }
  const plan = assertPortableKicadCommandPlanV1(
    nativeProcessPlan.command.value,
    input.commandKind,
    input.d356Profile,
  );
  const sourceIdentitySet = validatePortableKicadSourceIdentitySetV1(
    input.sourceIdentitySet,
    input.commandKind,
    input.d356Profile,
  );
  const sourceBinding = sourceIdentitySet.sourceBinding;
  const sourceContractIdentity = portableCanonicalIdentity(
    sourceIdentitySet.sourceContractPreimage,
    "evleda.source-contract.v1",
  );
  const sourceRevisionIdentity = portableCanonicalIdentity(
    sourceIdentitySet.sourceRevisionPreimage,
    "evleda.source-revision.v1",
  );
  if (
    !sameCanonicalIdentity(sourceBinding.sourceContractIdentity, sourceContractIdentity) ||
    !sameCanonicalIdentity(sourceBinding.sourceRevisionIdentity, sourceRevisionIdentity) ||
    sourceIdentitySet.sourceContractPreimage.commandKind !== input.commandKind ||
    canonicalPortableJson(sourceIdentitySet.sourceRevisionPreimage.sourcePath) !==
      canonicalPortableJson(sourceBinding.sourcePath) ||
    !sameContentIdentity(
      sourceIdentitySet.sourceRevisionPreimage.sourceArtifactIdentity,
      sourceBinding.sourceArtifactIdentity,
    )
  ) {
    fail("Native contract source identity preimages do not reproduce their binding.");
  }
  const invocationInputSourceIdentity = validateContentIdentity(
    input.invocationInputSourceIdentity,
    "$nativeContract/invocationInputSourceIdentity",
  );
  const sourceArgument = plan.argv.at(-1);
  if (
    sourceArgument?.kind !== "path" ||
    canonicalPortableJson(sourceArgument.value) !== canonicalPortableJson(sourceBinding.sourcePath)
  ) {
    fail("Native contract source binding does not match the command source.");
  }
  if (
    input.commandKind === "kicad_d356" &&
    !sameContentIdentity(
      sourceBinding.sourceArtifactIdentity,
      REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity,
    )
  ) {
    fail("D356 native contract is not bound to the reviewed Rev-A board.");
  }
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  if (
    spec.sourceEvaluationCapture === "command-input" &&
    !sameContentIdentity(invocationInputSourceIdentity, sourceBinding.sourceArtifactIdentity)
  ) {
    fail("Read-only native command input and evaluated-source identities must match.");
  }
  const preimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_SCHEMA,
    runtimeCommandContractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    commandKind: input.commandKind,
    nativeProcessPlanIdentity: nativeProcessPlan.planIdentity,
    commandPlanIdentity: plan.commandPlanIdentity,
    sourceBinding,
    invocationInputSourceIdentity,
    evaluatedSourceIdentity: sourceBinding.sourceArtifactIdentity,
    sourceEvaluationCapture: spec.sourceEvaluationCapture,
    sourceSnapshotPolicy: "one-command-one-copy",
    tool: plan.tool,
    acceptedExitCodes: spec.acceptedExitCodes,
    sourceDisposition: spec.sourceDisposition,
    d356ProfileIdentity:
      input.commandKind === "kicad_d356"
        ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
        : null,
    authority: "integrity-only",
    releaseAuthorized: false,
  }) as PortableKicadNativeContractPreimageV1;
  return Object.freeze({
    preimage,
    identity: portableCanonicalIdentity(preimage, "evleda.native-validation-contract.v1"),
  });
}

export interface PortableKicadNativeContractPreimageV2 {
  readonly schemaVersion: typeof PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_V2_SCHEMA;
  readonly runtimeCommandContractIdentity: CanonicalIdentity;
  readonly outputByteCeilingsIdentity: CanonicalIdentity;
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly expectedOutputs: NativeProcessPlanV2["expectedOutputs"];
  readonly sourceBinding: PortableSourceBindingV1;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly evaluatedSourceIdentity: ContentIdentity;
  readonly sourceEvaluationCapture: "command-input" | "post-refill-and-save";
  readonly sourceSnapshotPolicy: "one-command-one-copy";
  readonly tool: ToolContentIdentityV1;
  readonly acceptedExitCodes: readonly number[];
  readonly sourceDisposition: "read-only" | "isolated-writable-copy";
  readonly d356ProfileIdentity: CanonicalIdentity | null;
  readonly authority: "integrity-only";
  readonly releaseAuthorized: false;
}

export function buildPortableKicadNativeContractV2(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlan: NativeProcessPlanV2;
  readonly sourceIdentitySet: PortableKicadSourceIdentitySetV1;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): {
  readonly preimage: PortableKicadNativeContractPreimageV2;
  readonly identity: CanonicalIdentity;
} {
  const nativeProcessPlan = assertPortableKicadNativeProcessPlanV2(
    input.nativeProcessPlan,
    input.commandKind,
    input.d356Profile,
  );
  if (nativeProcessPlan.command.kind !== "portable_typed_command_v1") {
    fail("KiCad V2 native contract requires the portable typed-command variant.");
  }
  const plan = assertPortableKicadCommandPlanV1(
    nativeProcessPlan.command.value,
    input.commandKind,
    input.d356Profile,
  );
  const sourceIdentitySet = validatePortableKicadSourceIdentitySetV1(
    input.sourceIdentitySet,
    input.commandKind,
    input.d356Profile,
  );
  const sourceBinding = sourceIdentitySet.sourceBinding;
  const sourceContractIdentity = portableCanonicalIdentity(
    sourceIdentitySet.sourceContractPreimage,
    "evleda.source-contract.v1",
  );
  const sourceRevisionIdentity = portableCanonicalIdentity(
    sourceIdentitySet.sourceRevisionPreimage,
    "evleda.source-revision.v1",
  );
  if (
    !sameCanonicalIdentity(sourceBinding.sourceContractIdentity, sourceContractIdentity) ||
    !sameCanonicalIdentity(sourceBinding.sourceRevisionIdentity, sourceRevisionIdentity) ||
    sourceIdentitySet.sourceContractPreimage.commandKind !== input.commandKind ||
    canonicalPortableJson(sourceIdentitySet.sourceRevisionPreimage.sourcePath) !==
      canonicalPortableJson(sourceBinding.sourcePath) ||
    !sameContentIdentity(
      sourceIdentitySet.sourceRevisionPreimage.sourceArtifactIdentity,
      sourceBinding.sourceArtifactIdentity,
    )
  ) {
    fail("V2 native contract source identity preimages do not reproduce their binding.");
  }
  const invocationInputSourceIdentity = validateContentIdentity(
    input.invocationInputSourceIdentity,
    "$nativeContractV2/invocationInputSourceIdentity",
  );
  const sourceArgument = plan.argv.at(-1);
  if (
    sourceArgument?.kind !== "path" ||
    canonicalPortableJson(sourceArgument.value) !== canonicalPortableJson(sourceBinding.sourcePath)
  ) {
    fail("V2 native contract source binding does not match the command source.");
  }
  if (
    input.commandKind === "kicad_d356" &&
    !sameContentIdentity(
      sourceBinding.sourceArtifactIdentity,
      REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity,
    )
  ) {
    fail("D356 V2 native contract is not bound to the reviewed Rev-A board.");
  }
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  if (
    spec.sourceEvaluationCapture === "command-input" &&
    !sameContentIdentity(invocationInputSourceIdentity, sourceBinding.sourceArtifactIdentity)
  ) {
    fail("Read-only V2 native command input and evaluated-source identities must match.");
  }
  const preimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_NATIVE_CONTRACT_PREIMAGE_V2_SCHEMA,
    runtimeCommandContractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    outputByteCeilingsIdentity: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_IDENTITY_V1,
    commandKind: input.commandKind,
    nativeProcessPlanIdentity: nativeProcessPlan.planIdentity,
    commandPlanIdentity: plan.commandPlanIdentity,
    expectedOutputs: nativeProcessPlan.expectedOutputs,
    sourceBinding,
    invocationInputSourceIdentity,
    evaluatedSourceIdentity: sourceBinding.sourceArtifactIdentity,
    sourceEvaluationCapture: spec.sourceEvaluationCapture,
    sourceSnapshotPolicy: "one-command-one-copy",
    tool: plan.tool,
    acceptedExitCodes: spec.acceptedExitCodes,
    sourceDisposition: spec.sourceDisposition,
    d356ProfileIdentity:
      input.commandKind === "kicad_d356"
        ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
        : null,
    authority: "integrity-only",
    releaseAuthorized: false,
  }) as PortableKicadNativeContractPreimageV2;
  return Object.freeze({
    preimage,
    identity: portableCanonicalIdentity(preimage, "evleda.native-validation-contract.v1"),
  });
}

export interface PortableKicadNormalizerContractPreimageV1 {
  readonly schemaVersion: typeof PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_SCHEMA;
  readonly runtimeCommandContractIdentity: CanonicalIdentity;
  readonly commandKind: PortableKicadCommandKindV1;
  readonly normalizer: ToolContentIdentityV1;
  readonly publicSemantics: PortableKicadCommandSpecV1["publicSemantics"];
  readonly d356ProfileIdentity: CanonicalIdentity | null;
  readonly authority: "integrity-only";
  readonly releaseAuthorized: false;
}

export function buildPortableKicadNormalizerContractV1(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly normalizer: ToolContentIdentityV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): {
  readonly preimage: PortableKicadNormalizerContractPreimageV1;
  readonly identity: CanonicalIdentity;
} {
  assertD356Profile(input.commandKind, input.d356Profile);
  const normalizer = validateToolContentIdentityV1(
    input.normalizer,
    "$normalizerContract/normalizer",
  );
  if (
    normalizer.role !== "portable_normalizer" ||
    normalizer.kind !== "portable_implementation"
  ) {
    fail("Portable normalizer contract requires a portable-normalizer identity.");
  }
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  const preimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_SCHEMA,
    runtimeCommandContractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    commandKind: input.commandKind,
    normalizer,
    publicSemantics: spec.publicSemantics,
    d356ProfileIdentity:
      input.commandKind === "kicad_d356"
        ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
        : null,
    authority: "integrity-only",
    releaseAuthorized: false,
  }) as PortableKicadNormalizerContractPreimageV1;
  return Object.freeze({
    preimage,
    identity: portableCanonicalIdentity(
      preimage,
      "evleda.portable-normalizer-contract.v1",
    ),
  });
}

export interface PortableKicadNormalizerContractPreimageV2 {
  readonly schemaVersion: typeof PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_V2_SCHEMA;
  readonly runtimeCommandContractIdentity: CanonicalIdentity;
  readonly outputByteCeilingsIdentity: CanonicalIdentity;
  readonly commandKind: PortableKicadCommandKindV1;
  readonly maxOutputBytes: number;
  readonly normalizer: ToolContentIdentityV1;
  readonly publicSemantics: PortableKicadCommandSpecV1["publicSemantics"];
  readonly d356ProfileIdentity: CanonicalIdentity | null;
  readonly authority: "integrity-only";
  readonly releaseAuthorized: false;
}

export function buildPortableKicadNormalizerContractV2(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly normalizer: ToolContentIdentityV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): {
  readonly preimage: PortableKicadNormalizerContractPreimageV2;
  readonly identity: CanonicalIdentity;
} {
  assertD356Profile(input.commandKind, input.d356Profile);
  const normalizer = validateToolContentIdentityV1(
    input.normalizer,
    "$normalizerContractV2/normalizer",
  );
  if (
    normalizer.role !== "portable_normalizer" ||
    normalizer.kind !== "portable_implementation"
  ) {
    fail("Portable V2 normalizer contract requires a portable-normalizer identity.");
  }
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[input.commandKind];
  const preimage = hardenPortableValue({
    schemaVersion: PORTABLE_KICAD_NORMALIZER_CONTRACT_PREIMAGE_V2_SCHEMA,
    runtimeCommandContractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    outputByteCeilingsIdentity: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_IDENTITY_V1,
    commandKind: input.commandKind,
    maxOutputBytes: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits[input.commandKind],
    normalizer,
    publicSemantics: spec.publicSemantics,
    d356ProfileIdentity:
      input.commandKind === "kicad_d356"
        ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1.identity
        : null,
    authority: "integrity-only",
    releaseAuthorized: false,
  }) as PortableKicadNormalizerContractPreimageV2;
  return Object.freeze({
    preimage,
    identity: portableCanonicalIdentity(
      preimage,
      "evleda.portable-normalizer-contract.v1",
    ),
  });
}

export interface PrivatePortableKicadRootMapV1 {
  readonly reference: string;
  readonly runInput: string;
  readonly runPrivate: string;
}

export interface PrivatePortableKicadEnvironmentPathsV1 {
  readonly HOME: PortablePathRefV1;
  readonly KICAD_CONFIG_HOME: PortablePathRefV1;
  readonly TEMP: PortablePathRefV1;
  readonly TMP: PortablePathRefV1;
}

export interface ResolvedPrivateKicadExpectedOutputV2 {
  readonly path: string;
  readonly maxBytes: number;
}

export interface ResolvedPrivateKicadInvocationV2 {
  readonly schemaVersion: typeof PORTABLE_KICAD_PRIVATE_RESOLUTION_V2_SCHEMA;
  readonly disposition: "private-runtime-only";
  readonly commandKind: PortableKicadCommandKindV1;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedOutputPaths: readonly string[];
  readonly expectedOutputs: readonly ResolvedPrivateKicadExpectedOutputV2[];
  readonly acceptedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationInputSourceIdentity: ContentIdentity;
}

async function stableFileIdentity(filePath: string, label: string): Promise<ContentIdentity> {
  const before = await stat(filePath);
  if (!before.isFile()) fail(`${label} is not a regular file.`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  const after = await stat(filePath);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.nlink !== after.nlink
  ) {
    fail(`${label} changed while its identity was being checked.`);
  }
  return validateContentIdentity({
    algorithm: "sha256",
    digest: hash.digest("hex"),
    size: after.size,
  });
}

async function resolvePrivateDirectoryPath(
  runPrivate: string,
  value: PortablePathRefV1,
  label: string,
): Promise<string> {
  const safe = validatePortablePathRefV1(value, `$privateEnvironment/${label}`);
  if (safe.root !== "run_private") {
    fail(`${label} must be a private logical path.`);
  }
  const resolved = await resolveExistingDirectory(
    await resolveConfinedCandidate(
      runPrivate,
      runPrivate,
      safe.relativePath,
      `${label} directory`,
    ),
    `${label} directory`,
  );
  assertPathWithin(runPrivate, resolved, `${label} directory`, false);
  return resolved;
}

/**
 * Resolve a validated logical plan to process arguments. The returned object is
 * explicitly private and must never be copied into public artifacts or bundle
 * manifests because it contains host paths and private environment values.
 */
export async function resolvePortableKicadCommandPlanV2(input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlan: NativeProcessPlanV2;
  readonly roots: PrivatePortableKicadRootMapV1;
  readonly executablePath: string;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly helpCaptureBytes: Uint8Array;
  readonly capabilityManifestBytes: Uint8Array;
  readonly privateEnvironmentPaths: PrivatePortableKicadEnvironmentPathsV1;
  readonly d356Profile?: ReviewedKicadD356ProfileV1;
}): Promise<ResolvedPrivateKicadInvocationV2> {
  const nativeProcessPlan = assertPortableKicadNativeProcessPlanV2(
    input.nativeProcessPlan,
    input.commandKind,
    input.d356Profile,
  );
  if (nativeProcessPlan.command.kind !== "portable_typed_command_v1") {
    fail("KiCad resolver requires the portable typed-command variant.");
  }
  const plan = assertPortableKicadCommandPlanV1(
    nativeProcessPlan.command.value,
    input.commandKind,
    input.d356Profile,
  );
  const reference = await resolveExistingDirectory(input.roots.reference, "reference root");
  const runInput = await resolveExistingDirectory(input.roots.runInput, "run_input root");
  const runPrivate = await resolveExistingDirectory(input.roots.runPrivate, "run_private root");
  assertDisjointDirectories(reference, runInput, "reference root", "run_input root");
  assertDisjointDirectories(reference, runPrivate, "reference root", "run_private root");
  assertDisjointDirectories(runInput, runPrivate, "run_input root", "run_private root");

  const executablePath = await resolveExistingFile(input.executablePath, "KiCad executable");
  const executableMetadata = await lstat(executablePath);
  if (executableMetadata.isSymbolicLink() || executableMetadata.nlink !== 1) {
    fail("KiCad executable must be a single-link non-symlink file.");
  }
  const executableIdentity = await stableFileIdentity(executablePath, "KiCad executable");
  if (
    !sameContentIdentity(executableIdentity, plan.tool.contentIdentity) ||
    !sameContentIdentity(portableContentIdentity(input.helpCaptureBytes), plan.tool.helpIdentity) ||
    !sameContentIdentity(
      portableContentIdentity(input.capabilityManifestBytes),
      plan.tool.capabilitiesIdentity,
    )
  ) {
    fail("Resolved KiCad executable/help/capability bytes do not match the pinned tool identity.");
  }

  const cwd = await resolveExistingDirectory(
    await resolveConfinedCandidate(
      runInput,
      runInput,
      plan.logicalCwd.relativePath,
      "KiCad logical cwd",
    ),
    "KiCad logical cwd",
  );
  assertPathWithin(runInput, cwd, "KiCad logical cwd", false);

  const resolvedArguments: string[] = [];
  let resolvedSourcePath: string | undefined;
  for (const [index, argument] of plan.argv.entries()) {
    if (argument.kind === "literal") {
      resolvedArguments.push(argument.value);
      continue;
    }
    if (argument.value.root === "run_input") {
      const source = await resolveConfinedExistingFile(
        runInput,
        runInput,
        argument.value.relativePath,
        `KiCad source argument ${index}`,
      );
      const sourceMetadata = await lstat(source);
      if (sourceMetadata.nlink !== 1) {
        fail("KiCad run_input source must be a single-link isolated file.");
      }
      if (resolvedSourcePath !== undefined) {
        fail("KiCad runtime command contract permits exactly one source path.");
      }
      resolvedSourcePath = source;
      resolvedArguments.push(source);
      continue;
    }
    if (argument.value.root !== "run_private") {
      fail("KiCad runtime path arguments may use only run_input or run_private.");
    }
    const outputPath = await resolveConfinedCandidate(
      runPrivate,
      runPrivate,
      argument.value.relativePath,
      `KiCad output argument ${index}`,
    );
    const parent = await resolveExistingDirectory(
      path.dirname(outputPath),
      `KiCad output parent ${index}`,
    );
    assertPathWithin(runPrivate, parent, `KiCad output parent ${index}`, true);
    try {
      await lstat(outputPath);
      fail("KiCad private capture output must not exist before invocation.");
    } catch (error) {
      if (
        error instanceof PortableKicadRuntimeError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    resolvedArguments.push(outputPath);
  }

  const HOME = await resolvePrivateDirectoryPath(
    runPrivate,
    input.privateEnvironmentPaths.HOME,
    "HOME",
  );
  const KICAD_CONFIG_HOME = await resolvePrivateDirectoryPath(
    runPrivate,
    input.privateEnvironmentPaths.KICAD_CONFIG_HOME,
    "KICAD_CONFIG_HOME",
  );
  const TEMP = await resolvePrivateDirectoryPath(
    runPrivate,
    input.privateEnvironmentPaths.TEMP,
    "TEMP",
  );
  const TMP = await resolvePrivateDirectoryPath(
    runPrivate,
    input.privateEnvironmentPaths.TMP,
    "TMP",
  );
  const environment = Object.freeze({
    HOME,
    KICAD_CONFIG_HOME,
    TEMP,
    TMP,
    PYTHONHASHSEED: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.pythonHashSeed,
    PYTHONUTF8: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.pythonUtf8,
    LANG: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.locale,
    LANGUAGE: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.locale,
    LC_ALL: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.locale,
    TZ: PORTABLE_KICAD_ENVIRONMENT_POLICY_V1.timezone,
  });
  const expectedOutputPaths = Object.freeze(
    plan.expectedOutputs.map((output) => {
      const index = plan.argv.findIndex(
        (argument) =>
          argument.kind === "path" &&
          canonicalPortableJson(argument.value) === canonicalPortableJson(output),
      );
      const resolved = resolvedArguments[index];
      if (resolved === undefined) fail("Resolved expected output is missing from argv.");
      return resolved;
    }),
  );
  const expectedOutputs = Object.freeze(
    nativeProcessPlan.expectedOutputs.map((descriptor, index) =>
      Object.freeze({
        path: expectedOutputPaths[index]!,
        maxBytes: descriptor.maxBytes,
      }),
    ),
  );
  if (resolvedSourcePath === undefined) {
    fail("Resolved KiCad command source is missing.");
  }
  const invocationInputSourceIdentity = validateContentIdentity(
    input.invocationInputSourceIdentity,
    "$privateResolution/invocationInputSourceIdentity",
  );
  const observedInputIdentity = await stableFileIdentity(
    resolvedSourcePath,
    "KiCad invocation input source",
  );
  if (!sameContentIdentity(invocationInputSourceIdentity, observedInputIdentity)) {
    fail("Resolved KiCad source bytes do not match the pinned invocation-input identity.");
  }
  const result = Object.create(null) as ResolvedPrivateKicadInvocationV2;
  Object.defineProperties(result, {
    schemaVersion: {
      value: PORTABLE_KICAD_PRIVATE_RESOLUTION_V2_SCHEMA,
      enumerable: true,
    },
    disposition: { value: "private-runtime-only", enumerable: true },
    commandKind: { value: input.commandKind, enumerable: true },
    acceptedExitCodes: {
      value: nativeProcessPlan.acceptedExitCodes,
      enumerable: true,
    },
    timeoutMs: { value: nativeProcessPlan.timeoutMs, enumerable: true },
    maxStdoutBytes: {
      value: nativeProcessPlan.maxStdoutBytes,
      enumerable: true,
    },
    maxStderrBytes: {
      value: nativeProcessPlan.maxStderrBytes,
      enumerable: true,
    },
    nativeProcessPlanIdentity: {
      value: nativeProcessPlan.planIdentity,
      enumerable: true,
    },
    commandPlanIdentity: { value: plan.commandPlanIdentity, enumerable: true },
    invocationInputSourceIdentity: {
      value: invocationInputSourceIdentity,
      enumerable: true,
    },
    // Host material is intentionally non-enumerable. Direct runtime access is
    // supported, while JSON/string-spread projection cannot leak it by default.
    command: { value: await realpath(executablePath), enumerable: false },
    argv: { value: Object.freeze(resolvedArguments), enumerable: false },
    cwd: { value: cwd, enumerable: false },
    environment: { value: environment, enumerable: false },
    expectedOutputPaths: { value: expectedOutputPaths, enumerable: false },
    expectedOutputs: { value: expectedOutputs, enumerable: false },
  });
  return Object.freeze(result);
}
