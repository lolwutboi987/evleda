import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { z } from "zod";

export const REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA =
  "evleda.reference-controller-native-contract.v1" as const;
export const REFERENCE_CONTROLLER_NATIVE_CONTRACT_CANONICALIZATION =
  "evleda-c14n-json-v1" as const;
export const REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES = 262_144;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH =
  "src/knowledge/reference-controller-native-contract.v1.json" as const;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_DIGEST =
  "82044fa6dd7467e5c08eae734fe51d33e2bd04a854eb4b0b7a167c6fe8c47789" as const;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY =
  Object.freeze({
    algorithm: "sha256" as const,
    digest: "573ddc66cfdfcbbc48a2a3d02d1fd29a57efd2cb26d0ce7dc79b9eac86adcc4d",
    size: 8_889
  });
export const REFERENCE_CONTROLLER_REFERENCE_SET_REPORT_SCHEMA =
  "evleda.reference-controller-reference-set-agreement.v1" as const;
export const REFERENCE_CONTROLLER_NATIVE_AUTHORITY_SNAPSHOT_SCHEMA =
  "evleda.reference-controller-native-authority-snapshot.v1" as const;

export type ReferenceComponentRole =
  | "mcu"
  | "motor_driver"
  | "buck_5v"
  | "ldo_3v3"
  | "can_transceiver"
  | "usb_esd"
  | "encoder_buffer"
  | "sensor_power_switch";

export type ReferenceNativeSourceRole =
  | "exported_bom"
  | "schematic_netlist"
  | "engineering_bom"
  | "native_pcb"
  | "native_schematic"
  | "positions";

export type ReferenceNativeInterface =
  | "USB"
  | "CAN"
  | "UART"
  | "I2C"
  | "SPI"
  | "SWD"
  | "ENCODER";

export interface ReferenceNativeEndpoint {
  readonly reference: string;
  readonly pin: string;
}

export interface ReferenceNativeSignalFingerprint {
  readonly nativeNet: string;
  readonly endpoints: readonly ReferenceNativeEndpoint[];
}

export interface ReferenceNativeInterfaceFingerprint {
  readonly interface: ReferenceNativeInterface;
  readonly signals: readonly ReferenceNativeSignalFingerprint[];
}

export interface ReferenceNativeSourceBinding {
  readonly role: ReferenceNativeSourceRole;
  readonly path: string;
  readonly identity: ContentIdentity;
}

export interface ReferenceClassifiedExclusion {
  readonly reference: string;
  readonly classification:
    | "mechanical_no_electrical_pins"
    | "erc_power_flag_no_physical_component"
    | "reviewed_position_export_exclusion";
}

export interface ReferenceSetPolicy {
  readonly canonicalPhysicalComponentSetSource: "schematic_netlist_components";
  readonly positionExportPolicy: Readonly<{
    boardSides: readonly ["top", "bottom"];
    excludeDnp: true;
    honorPcbExcludeFromPositionFiles: true;
    reviewedReferenceExclusions: readonly ReferenceClassifiedExclusion[];
  }>;
  readonly requireExactPhysicalAgreementWith: readonly ["exported_bom", "native_pcb", "positions"];
  readonly schematicNodeReferenceExclusions: readonly ReferenceClassifiedExclusion[];
  readonly schematicSourceOnlyExclusions: readonly ReferenceClassifiedExclusion[];
}

export interface ReferenceControllerNativeContract {
  readonly schemaVersion: typeof REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA;
  readonly profileId: "robotics-controller-v0";
  readonly boardRevision: "EVL-RC-G0-REV-A";
  readonly scope: Readonly<{
    authority: "reviewed_native_candidate_semantics";
    qualification: "candidate_only";
    releaseAuthorized: false;
  }>;
  readonly componentDesignators: Readonly<Record<ReferenceComponentRole, readonly string[]>>;
  readonly requiredNativeNets: readonly string[];
  readonly signalAliases: Readonly<Record<string, string>>;
  readonly architectureNetAliases: Readonly<Record<string, readonly string[]>>;
  readonly schematicIntentRequiredSemanticNets: readonly string[];
  readonly supplementalNativeNets: readonly string[];
  readonly mcuPinFunctionOverrides: Readonly<Record<string, string>>;
  readonly interfaceEndpointFingerprints: readonly ReferenceNativeInterfaceFingerprint[];
  readonly sourceBindings: readonly ReferenceNativeSourceBinding[];
  readonly referenceSetPolicy: ReferenceSetPolicy;
  readonly identity: CanonicalIdentity;
}

export type ReferenceControllerNativeContractErrorCode =
  | "REFERENCE_NATIVE_CONTRACT_INVALID_JSON"
  | "REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE"
  | "REFERENCE_NATIVE_CONTRACT_INCONSISTENT"
  | "REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH"
  | "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH"
  | "REFERENCE_NATIVE_CONTRACT_NON_CANONICAL_JSON"
  | "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE"
  | "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY"
  | "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED"
  | "REFERENCE_NATIVE_CONTRACT_INVALID_AUTHORITY_SNAPSHOT"
  | "REFERENCE_NATIVE_CONTRACT_TOO_LARGE";

export class ReferenceControllerNativeContractError extends Error {
  public constructor(
    public readonly code: ReferenceControllerNativeContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReferenceControllerNativeContractError";
  }
}

const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const referenceSchema = z.string().regex(/^(?:#[A-Z]+|[A-Z]+)[0-9]+$/u).max(32);
const nativeNetSchema = z.string().min(1).max(100).regex(/^[+A-Z0-9_()-]+$/u);
const semanticNetSchema = z.string().min(1).max(100).regex(/^[A-Z0-9_]+$/u);
const contentIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: sha256DigestSchema,
  size: z.number().int().positive().max(16_777_216)
}).strict();
const canonicalIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: sha256DigestSchema,
  schemaVersion: z.literal(REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA),
  canonicalizationVersion: z.literal(REFERENCE_CONTROLLER_NATIVE_CONTRACT_CANONICALIZATION)
}).strict();
const endpointSchema = z.object({
  reference: referenceSchema,
  pin: z.string().min(1).max(16).regex(/^[A-Z0-9]+$/u)
}).strict();
const signalFingerprintSchema = z.object({
  nativeNet: nativeNetSchema,
  endpoints: z.array(endpointSchema).min(2)
}).strict();
const interfaceFingerprintSchema = z.object({
  interface: z.enum(["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"]),
  signals: z.array(signalFingerprintSchema).min(1)
}).strict();
const sourceBindingSchema = z.object({
  role: z.enum(["exported_bom", "schematic_netlist", "engineering_bom", "native_pcb", "native_schematic", "positions"]),
  path: z.string().min(1).max(512).regex(/^[a-zA-Z0-9._/-]+$/u),
  identity: contentIdentitySchema
}).strict();
const classifiedReferenceSchema = z.object({
  reference: referenceSchema,
  classification: z.enum([
    "mechanical_no_electrical_pins",
    "erc_power_flag_no_physical_component",
    "reviewed_position_export_exclusion"
  ])
}).strict();
const designatorList = (length: 1 | 2) => z.array(referenceSchema).length(length);

const contractSchema = z.object({
  schemaVersion: z.literal(REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA),
  profileId: z.literal("robotics-controller-v0"),
  boardRevision: z.literal("EVL-RC-G0-REV-A"),
  scope: z.object({
    authority: z.literal("reviewed_native_candidate_semantics"),
    qualification: z.literal("candidate_only"),
    releaseAuthorized: z.literal(false)
  }).strict(),
  componentDesignators: z.object({
    mcu: designatorList(1),
    motor_driver: designatorList(2),
    buck_5v: designatorList(1),
    ldo_3v3: designatorList(1),
    can_transceiver: designatorList(1),
    usb_esd: designatorList(1),
    encoder_buffer: designatorList(2),
    sensor_power_switch: designatorList(1)
  }).strict(),
  requiredNativeNets: z.array(nativeNetSchema).length(48),
  signalAliases: z.record(semanticNetSchema, nativeNetSchema),
  architectureNetAliases: z.record(semanticNetSchema, z.array(nativeNetSchema).min(1).max(2)),
  schematicIntentRequiredSemanticNets: z.array(semanticNetSchema).length(14),
  supplementalNativeNets: z.array(nativeNetSchema).length(3),
  mcuPinFunctionOverrides: z.record(
    z.string().regex(/^[1-9][0-9]?$/u),
    z.string().min(1).max(80).regex(/^[A-Z0-9_/]+$/u)
  ),
  interfaceEndpointFingerprints: z.array(interfaceFingerprintSchema).length(7),
  sourceBindings: z.array(sourceBindingSchema).length(6),
  referenceSetPolicy: z.object({
    canonicalPhysicalComponentSetSource: z.literal("schematic_netlist_components"),
    positionExportPolicy: z.object({
      boardSides: z.tuple([z.literal("top"), z.literal("bottom")]),
      excludeDnp: z.literal(true),
      honorPcbExcludeFromPositionFiles: z.literal(true),
      reviewedReferenceExclusions: z.array(classifiedReferenceSchema)
    }).strict(),
    requireExactPhysicalAgreementWith: z.tuple([
      z.literal("exported_bom"),
      z.literal("native_pcb"),
      z.literal("positions")
    ]),
    schematicNodeReferenceExclusions: z.array(classifiedReferenceSchema).min(1),
    schematicSourceOnlyExclusions: z.array(classifiedReferenceSchema).min(1)
  }).strict(),
  identity: canonicalIdentitySchema
}).strict();

const fail = (
  code: ReferenceControllerNativeContractErrorCode,
  message: string
): never => {
  throw new ReferenceControllerNativeContractError(code, message);
};

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key], seen);
    }
    Object.freeze(value);
  }
  return value;
};

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const sorted = (values: Iterable<string>): string[] => [...values].sort((left, right) =>
  left < right ? -1 : left > right ? 1 : 0
);
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const validateContractConsistency = (contract: ReferenceControllerNativeContract): void => {
  const designators = Object.values(contract.componentDesignators).flat();
  if (!unique(designators)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Component designators must be globally unique.");
  }
  if (!unique(contract.requiredNativeNets)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Required native nets must be unique.");
  }
  if (Object.keys(contract.signalAliases).length !== 37) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Signal aliases must cover exactly 37 profile signals.");
  }
  if (Object.keys(contract.architectureNetAliases).length !== 16) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Architecture aliases must cover exactly sixteen semantic nets.");
  }
  const requiredNets = new Set(contract.requiredNativeNets);
  for (const targets of Object.values(contract.architectureNetAliases)) {
    if (!unique(targets) || targets.some((target) => !requiredNets.has(target))) {
      fail(
        "REFERENCE_NATIVE_CONTRACT_INCONSISTENT",
        "Architecture aliases must contain unique required native-net targets."
      );
    }
  }
  if (
    !unique(contract.schematicIntentRequiredSemanticNets) ||
    contract.schematicIntentRequiredSemanticNets.some(
      (semanticNet) => contract.architectureNetAliases[semanticNet] === undefined
    )
  ) {
    fail(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT",
      "Every schematic-intent semantic net must have an explicit architecture alias."
    );
  }
  if (
    !unique(contract.supplementalNativeNets) ||
    contract.supplementalNativeNets.some((net) => requiredNets.has(net))
  ) {
    fail(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT",
      "Supplemental native nets must be unique and disjoint from required native nets."
    );
  }
  const reviewedNativeNets = new Set([
    ...contract.requiredNativeNets,
    ...contract.supplementalNativeNets
  ]);
  if (Object.values(contract.signalAliases).some((net) => !reviewedNativeNets.has(net))) {
    fail(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT",
      "Every signal alias must target a reviewed required or supplemental native net."
    );
  }
  if (Object.keys(contract.mcuPinFunctionOverrides).length !== 4) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Exactly four MCU pin-function overrides are required.");
  }
  const interfaceNames = contract.interfaceEndpointFingerprints.map((entry) => entry.interface);
  if (!unique(interfaceNames)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Interface fingerprints must have unique names.");
  }
  const fingerprintNets: string[] = [];
  for (const fingerprint of contract.interfaceEndpointFingerprints) {
    const localNets = fingerprint.signals.map((signal) => signal.nativeNet);
    if (!unique(localNets)) {
      fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", `${fingerprint.interface} repeats a native net.`);
    }
    fingerprintNets.push(...localNets);
    for (const signal of fingerprint.signals) {
      const endpoints = signal.endpoints.map((entry) => `${entry.reference}\u0000${entry.pin}`);
      if (!unique(endpoints)) {
        fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", `${signal.nativeNet} repeats an endpoint.`);
      }
    }
  }
  if (!unique(fingerprintNets)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "A fingerprint native net may belong to only one interface.");
  }
  const sourceRoles = contract.sourceBindings.map((entry) => entry.role);
  const sourcePaths = contract.sourceBindings.map((entry) => entry.path);
  if (!unique(sourceRoles) || !unique(sourcePaths)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Source-binding roles and paths must be unique.");
  }
  for (const binding of contract.sourceBindings) {
    if (
      binding.path.startsWith("/") ||
      binding.path.includes("\\") ||
      binding.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Source-binding paths must be normalized repository-relative paths.");
    }
  }
  const nodeExclusions = contract.referenceSetPolicy.schematicNodeReferenceExclusions;
  const sourceOnlyExclusions = contract.referenceSetPolicy.schematicSourceOnlyExclusions;
  const positionExclusions = contract.referenceSetPolicy.positionExportPolicy.reviewedReferenceExclusions;
  const classifiedReferences = [...nodeExclusions, ...sourceOnlyExclusions, ...positionExclusions]
    .map((entry) => entry.reference);
  if (!unique(classifiedReferences)) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Classified reference exclusions must be unique.");
  }
  if (
    nodeExclusions.some((entry) => entry.classification !== "mechanical_no_electrical_pins") ||
    sourceOnlyExclusions.some((entry) => entry.classification !== "erc_power_flag_no_physical_component") ||
    positionExclusions.some((entry) => entry.classification !== "reviewed_position_export_exclusion")
  ) {
    fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "Reference exclusions have an invalid policy classification.");
  }
};

export const referenceControllerNativeContractIdentityPreimage = (
  contract: ReferenceControllerNativeContract
): Omit<ReferenceControllerNativeContract, "identity"> => {
  const { identity: _identity, ...preimage } = contract;
  return preimage;
};

export const validateReferenceControllerNativeContract = (
  value: unknown
): ReferenceControllerNativeContract => {
  let parsed: z.infer<typeof contractSchema>;
  try {
    const result = contractSchema.safeParse(value);
    if (!result.success) {
      return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", "Native contract has an invalid or unknown field.");
    }
    parsed = result.data;
  } catch {
    return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", "Native contract could not be safely inspected.");
  }
  const snapshot = parsed as ReferenceControllerNativeContract;
  validateContractConsistency(snapshot);
  if (/^0{64}$/u.test(snapshot.identity.digest)) {
    return fail("REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH", "Native contract identity may not be the all-zero placeholder.");
  }
  const expected = canonicalIdentity(
    referenceControllerNativeContractIdentityPreimage(snapshot),
    REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA
  );
  if (
    !constantTimeDigestEqual(snapshot.identity.digest, expected.digest) ||
    canonicalJson(snapshot.identity) !== canonicalJson(expected)
  ) {
    return fail("REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH", "Native contract identity does not reproduce its explicit preimage.");
  }
  if (!constantTimeDigestEqual(snapshot.identity.digest, REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_DIGEST)) {
    return fail(
      "REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH",
      "Native contract identity is not the independently reviewed Rev-A trust anchor."
    );
  }
  return deepFreeze(snapshot);
};

export const parseReferenceControllerNativeContractJson = (
  source: string
): ReferenceControllerNativeContract => {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength > REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES) {
    return fail("REFERENCE_NATIVE_CONTRACT_TOO_LARGE", "Native contract JSON exceeds its byte limit.");
  }
  const actualContentIdentity = contentIdentity(source);
  if (
    actualContentIdentity.size !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size ||
    !constantTimeDigestEqual(
      actualContentIdentity.digest,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.digest
    )
  ) {
    return fail(
      "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
      "Native contract bytes are not the independently reviewed canonical Rev-A document."
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return fail("REFERENCE_NATIVE_CONTRACT_INVALID_JSON", "Native contract is not valid JSON.");
  }
  const contract = validateReferenceControllerNativeContract(value);
  if (source !== `${canonicalJson(contract)}\n`) {
    return fail(
      "REFERENCE_NATIVE_CONTRACT_NON_CANONICAL_JSON",
      "Native contract JSON must be exact evleda-c14n-json-v1 bytes followed by one LF."
    );
  }
  return contract;
};

export interface ReferenceControllerNativeFileInstance {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly linkCount: string;
  readonly size: number;
  readonly modifiedTimeNs: string;
  readonly changedTimeNs: string;
  readonly birthTimeNs: string;
}

declare const referenceControllerNativeAuthoritySnapshotBrand: unique symbol;

export interface ReferenceControllerRevANativeAuthoritySnapshot {
  readonly schemaVersion: typeof REFERENCE_CONTROLLER_NATIVE_AUTHORITY_SNAPSHOT_SCHEMA;
  readonly sourcePath: typeof REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH;
  readonly fileBinding: Readonly<{
    path: typeof REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH;
    sizeBytes: number;
    sha256: string;
  }>;
  readonly contract: ReferenceControllerNativeContract;
  readonly semanticIdentity: CanonicalIdentity;
  readonly contentIdentity: ContentIdentity;
  readonly canonicalJson: string;
  readonly fileInstance: ReferenceControllerNativeFileInstance;
  readonly identity: CanonicalIdentity;
  readonly [referenceControllerNativeAuthoritySnapshotBrand]: true;
}

const issuedAuthoritySnapshots = new WeakSet<object>();

const authoritySnapshotError = (
  code: ReferenceControllerNativeContractErrorCode,
  message: string,
  cause?: unknown
): never => {
  const error = new ReferenceControllerNativeContractError(code, message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: cause
    });
  }
  throw error;
};

type NativeBigIntStats = BigIntStats;

const nativeFileInstance = (stats: NativeBigIntStats): ReferenceControllerNativeFileInstance => {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
      "The module-owned Rev-A native contract must be an ordinary non-symlink file."
    );
  }
  if (stats.size <= 0n || stats.size > BigInt(REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES)) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_TOO_LARGE",
      "The module-owned Rev-A native contract has an invalid file size."
    );
  }
  return deepFreeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: stats.mode.toString(),
    linkCount: stats.nlink.toString(),
    size: Number(stats.size),
    modifiedTimeNs: stats.mtimeNs.toString(),
    changedTimeNs: stats.ctimeNs.toString(),
    birthTimeNs: stats.birthtimeNs.toString()
  });
};

const sameNativeFileInstance = (
  left: ReferenceControllerNativeFileInstance,
  right: ReferenceControllerNativeFileInstance
): boolean => canonicalJson(left) === canonicalJson(right);

const sameResolvedNativePath = (left: string, right: string): boolean => {
  return resolve(left) === resolve(right);
};

// Source execution lives at <root>/src/knowledge and compiled execution at
// <root>/dist/src/knowledge. Both resolve the one reviewed source authority;
// a TypeScript-emitted JSON module would rewrite whitespace and break the raw-byte pin.
const nativeContractModuleDirectory = dirname(fileURLToPath(import.meta.url));
const nativeContractTwoLevelsUp = resolve(nativeContractModuleDirectory, "../..");
const nativeContractRepositoryRoot = basename(nativeContractTwoLevelsUp) === "dist"
  ? resolve(nativeContractTwoLevelsUp, "..")
  : nativeContractTwoLevelsUp;
const nativeContractResolvedSourcePath = resolve(
  nativeContractRepositoryRoot,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH
);

const captureBootstrapNativeContract = (): Readonly<{
  source: string;
  contract: ReferenceControllerNativeContract;
}> => {
  let pathStat: NativeBigIntStats;
  let resolvedPath: string;
  try {
    pathStat = lstatSync(nativeContractResolvedSourcePath, { bigint: true });
    resolvedPath = realpathSync.native(nativeContractResolvedSourcePath);
  } catch (error) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
      "The module-owned Rev-A native contract is unavailable during bounded bootstrap.",
      error
    );
  }
  const pathInstance = nativeFileInstance(pathStat);
  if (!sameResolvedNativePath(resolvedPath, nativeContractResolvedSourcePath)) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
      "The module-owned Rev-A native contract bootstrap path may not traverse a symlink, reparse alias, or case-variant path."
    );
  }

  let fileDescriptor: number;
  try {
    const noFollow = fileConstants.O_NOFOLLOW ?? 0;
    fileDescriptor = openSync(
      nativeContractResolvedSourcePath,
      fileConstants.O_RDONLY | noFollow
    );
  } catch (error) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
      "The module-owned Rev-A native contract could not be opened during bounded bootstrap.",
      error
    );
  }

  try {
    const openedInstance = nativeFileInstance(
      fstatSync(fileDescriptor, { bigint: true })
    );
    if (!sameNativeFileInstance(pathInstance, openedInstance)) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file instance changed during bounded bootstrap open."
      );
    }
    if (
      openedInstance.size !==
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
        "The Rev-A native contract bootstrap size does not match the reviewed raw-content trust anchor."
      );
    }

    const boundedBytes = Buffer.alloc(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size + 1
    );
    let bytesRead = 0;
    while (bytesRead < boundedBytes.byteLength) {
      const count = readSync(
        fileDescriptor,
        boundedBytes,
        bytesRead,
        boundedBytes.byteLength - bytesRead,
        bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (
      bytesRead !== openedInstance.size ||
      bytesRead !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract byte count changed during bounded bootstrap read."
      );
    }
    const bytes = boundedBytes.subarray(0, bytesRead);
    const afterReadInstance = nativeFileInstance(
      fstatSync(fileDescriptor, { bigint: true })
    );
    if (!sameNativeFileInstance(openedInstance, afterReadInstance)) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file changed during bounded bootstrap read."
      );
    }

    const exactContentIdentity = contentIdentity(bytes);
    if (
      exactContentIdentity.size !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size ||
      !constantTimeDigestEqual(
        exactContentIdentity.digest,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.digest
      )
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
        "The Rev-A native contract bootstrap bytes do not match the reviewed raw-content trust anchor."
      );
    }
    const source = Buffer.from(bytes).toString("utf8");
    const contract = parseReferenceControllerNativeContractJson(source);

    const finalHandleInstance = nativeFileInstance(
      fstatSync(fileDescriptor, { bigint: true })
    );
    let finalPathInstance: ReferenceControllerNativeFileInstance;
    let finalResolvedPath: string;
    try {
      finalPathInstance = nativeFileInstance(
        lstatSync(nativeContractResolvedSourcePath, { bigint: true })
      );
      finalResolvedPath = realpathSync.native(nativeContractResolvedSourcePath);
    } catch (error) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract path disappeared before bounded bootstrap completion.",
        error
      );
    }
    if (
      !sameNativeFileInstance(openedInstance, finalHandleInstance) ||
      !sameNativeFileInstance(openedInstance, finalPathInstance) ||
      !sameResolvedNativePath(finalResolvedPath, nativeContractResolvedSourcePath)
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract identity, stat, or exact-case path changed before bounded bootstrap completion."
      );
    }
    return Object.freeze({ source, contract });
  } catch (error) {
    if (error instanceof ReferenceControllerNativeContractError) throw error;
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
      "The Rev-A native contract could not be bootstrapped from one stable bounded file instance.",
      error
    );
  } finally {
    try {
      closeSync(fileDescriptor);
    } catch (error) {
      authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract bootstrap file handle could not be closed.",
        error
      );
    }
  }
};

const bootstrapNativeContract = captureBootstrapNativeContract();
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT =
  bootstrapNativeContract.contract;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY =
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.identity;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CANONICAL_JSON =
  bootstrapNativeContract.source;
export const REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY =
  deepFreeze(contentIdentity(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CANONICAL_JSON));
export const REFERENCE_CONTROLLER_REV_A_REQUIRED_NATIVE_NETS =
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.requiredNativeNets;
export const REFERENCE_CONTROLLER_REV_A_SIGNAL_ALIASES =
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases;
export const REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE =
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.mcu[0]!;

const captureReferenceControllerRevANativeAuthority = async ():
  Promise<ReferenceControllerRevANativeAuthoritySnapshot> => {
  let pathStat: NativeBigIntStats;
  let resolvedPath: string;
  try {
    pathStat = await lstat(nativeContractResolvedSourcePath, { bigint: true }) as NativeBigIntStats;
    resolvedPath = await realpath(nativeContractResolvedSourcePath);
  } catch (error) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
      "The module-owned Rev-A native contract is unavailable.",
      error
    );
  }
  const pathInstance = nativeFileInstance(pathStat);
  if (!sameResolvedNativePath(resolvedPath, nativeContractResolvedSourcePath)) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
      "The module-owned Rev-A native contract path may not traverse a symlink or reparse alias."
    );
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const noFollow = fileConstants.O_NOFOLLOW ?? 0;
    handle = await open(nativeContractResolvedSourcePath, fileConstants.O_RDONLY | noFollow);
  } catch (error) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
      "The module-owned Rev-A native contract could not be opened as an ordinary file.",
      error
    );
  }

  try {
    const openedInstance = nativeFileInstance(
      await handle.stat({ bigint: true }) as NativeBigIntStats
    );
    if (!sameNativeFileInstance(pathInstance, openedInstance)) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file instance changed while it was opened."
      );
    }
    if (
      openedInstance.size !==
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
        "The Rev-A native contract file size does not match the reviewed raw-content trust anchor."
      );
    }
    const boundedBytes = Buffer.alloc(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size + 1
    );
    let bytesRead = 0;
    while (bytesRead < boundedBytes.byteLength) {
      const result = await handle.read(
        boundedBytes,
        bytesRead,
        boundedBytes.byteLength - bytesRead,
        bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (
      bytesRead !== openedInstance.size ||
      bytesRead !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract byte count changed while it was read."
      );
    }
    const bytes = boundedBytes.subarray(0, bytesRead);
    const afterReadInstance = nativeFileInstance(
      await handle.stat({ bigint: true }) as NativeBigIntStats
    );
    if (!sameNativeFileInstance(openedInstance, afterReadInstance)) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file changed while its bytes were read."
      );
    }

    const exactContentIdentity = deepFreeze(contentIdentity(bytes));
    if (
      exactContentIdentity.size !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.size ||
      !constantTimeDigestEqual(
        exactContentIdentity.digest,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY.digest
      )
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
        "The Rev-A native contract file bytes do not match the reviewed raw-content trust anchor."
      );
    }
    const exactCanonicalJson = Buffer.from(bytes).toString("utf8");
    const contract = parseReferenceControllerNativeContractJson(exactCanonicalJson);

    const finalHandleInstance = nativeFileInstance(
      await handle.stat({ bigint: true }) as NativeBigIntStats
    );
    let finalPathInstance: ReferenceControllerNativeFileInstance;
    let finalResolvedPath: string;
    try {
      finalPathInstance = nativeFileInstance(
        await lstat(nativeContractResolvedSourcePath, { bigint: true }) as NativeBigIntStats
      );
      finalResolvedPath = await realpath(nativeContractResolvedSourcePath);
    } catch (error) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract path disappeared before snapshot completion.",
        error
      );
    }
    if (
      !sameNativeFileInstance(openedInstance, finalHandleInstance) ||
      !sameNativeFileInstance(openedInstance, finalPathInstance) ||
      !sameResolvedNativePath(finalResolvedPath, nativeContractResolvedSourcePath)
    ) {
      return authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file identity or stat changed before snapshot completion."
      );
    }

    const fileBinding = deepFreeze({
      path: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
      sizeBytes: exactContentIdentity.size,
      sha256: exactContentIdentity.digest
    });
    const payload = deepFreeze({
      schemaVersion: REFERENCE_CONTROLLER_NATIVE_AUTHORITY_SNAPSHOT_SCHEMA,
      sourcePath: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
      fileBinding,
      semanticIdentity: contract.identity,
      contentIdentity: exactContentIdentity,
      fileInstance: openedInstance
    });
    const snapshot = deepFreeze({
      ...payload,
      contract,
      canonicalJson: exactCanonicalJson,
      identity: canonicalIdentity(payload, REFERENCE_CONTROLLER_NATIVE_AUTHORITY_SNAPSHOT_SCHEMA)
    }) as ReferenceControllerRevANativeAuthoritySnapshot;
    issuedAuthoritySnapshots.add(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof ReferenceControllerNativeContractError) throw error;
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
      "The Rev-A native contract could not be snapshotted from one stable file instance.",
      error
    );
  } finally {
    try {
      await handle.close();
    } catch (error) {
      authoritySnapshotError(
        "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
        "The Rev-A native contract file handle could not be closed after snapshotting.",
        error
      );
    }
  }
};

export const snapshotReferenceControllerRevANativeAuthority = async ():
  Promise<ReferenceControllerRevANativeAuthoritySnapshot> =>
  captureReferenceControllerRevANativeAuthority();

export const reverifyReferenceControllerRevANativeAuthority = async (
  snapshot: ReferenceControllerRevANativeAuthoritySnapshot
): Promise<void> => {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !issuedAuthoritySnapshots.has(snapshot) ||
    !Object.isFrozen(snapshot)
  ) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_INVALID_AUTHORITY_SNAPSHOT",
      "Rev-A native authority revalidation requires an opaque snapshot issued by this module."
    );
  }
  const current = await captureReferenceControllerRevANativeAuthority();
  issuedAuthoritySnapshots.delete(current);
  if (
    canonicalJson(current.fileInstance) !== canonicalJson(snapshot.fileInstance) ||
    canonicalJson(current.fileBinding) !== canonicalJson(snapshot.fileBinding) ||
    canonicalJson(current.semanticIdentity) !== canonicalJson(snapshot.semanticIdentity) ||
    canonicalJson(current.contentIdentity) !== canonicalJson(snapshot.contentIdentity) ||
    canonicalJson(current.identity) !== canonicalJson(snapshot.identity) ||
    current.canonicalJson !== snapshot.canonicalJson ||
    canonicalJson(current.contract) !== canonicalJson(snapshot.contract)
  ) {
    return authoritySnapshotError(
      "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
      "The module-owned Rev-A native authority differs from the captured file-instance snapshot."
    );
  }
};

export const referenceControllerRevASourceBinding = (
  role: ReferenceNativeSourceRole
): ReferenceNativeSourceBinding => {
  const matches = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.sourceBindings.filter(
    (binding) => binding.role === role
  );
  if (matches.length !== 1) {
    return fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", `Native source role ${role} is not uniquely bound.`);
  }
  return matches[0]!;
};

export interface ReferenceSetObservation {
  readonly schematicComponentReferences: readonly string[];
  readonly schematicNodeReferences: readonly string[];
  readonly exportedBomReferences: readonly string[];
  readonly nativePcbReferences: readonly string[];
  readonly positionCandidates: readonly ReferencePositionCandidate[];
  readonly positionReferences: readonly string[];
}

export interface ReferencePositionCandidate {
  readonly reference: string;
  readonly side: "top" | "bottom";
  readonly dnp: boolean;
  readonly excludeFromPositionFiles: boolean;
}

export interface ReferenceSetDifference {
  readonly source: "schematic_nodes" | "exported_bom" | "native_pcb" | "position_candidates" | "positions";
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export interface ReferenceSetAgreementReport {
  readonly schemaVersion: typeof REFERENCE_CONTROLLER_REFERENCE_SET_REPORT_SCHEMA;
  readonly contractIdentity: CanonicalIdentity;
  readonly passed: boolean;
  readonly canonicalPhysicalReferences: readonly string[];
  readonly expectedSchematicNodeReferences: readonly string[];
  readonly classifiedExclusions: Readonly<{
    schematicNodes: readonly ReferenceClassifiedExclusion[];
    schematicSourceOnly: readonly ReferenceClassifiedExclusion[];
    positions: readonly ReferenceClassifiedExclusion[];
  }>;
  readonly differences: readonly ReferenceSetDifference[];
  readonly identity: CanonicalIdentity;
}

const snapshotReferenceSet = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^(?:#[A-Z]+|[A-Z]+)[0-9]+$/u.test(entry))) {
    return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", `${name} must contain only exact component references.`);
  }
  if (!unique(value)) {
    return fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", `${name} contains duplicate component references.`);
  }
  return Object.freeze(sorted(value));
};

const snapshotPositionCandidates = (value: unknown): readonly ReferencePositionCandidate[] => {
  if (!Array.isArray(value)) {
    return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", "positionCandidates must be an array.");
  }
  const candidates: ReferencePositionCandidate[] = [];
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      !sameStrings(sorted(Object.keys(entry)), sorted(["reference", "side", "dnp", "excludeFromPositionFiles"]))
    ) {
      return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", "positionCandidates contains an invalid or unknown field.");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.reference !== "string" ||
      !/^(?:#[A-Z]+|[A-Z]+)[0-9]+$/u.test(candidate.reference) ||
      (candidate.side !== "top" && candidate.side !== "bottom") ||
      typeof candidate.dnp !== "boolean" ||
      typeof candidate.excludeFromPositionFiles !== "boolean"
    ) {
      return fail("REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE", "positionCandidates contains an invalid value.");
    }
    candidates.push({
      reference: candidate.reference,
      side: candidate.side,
      dnp: candidate.dnp,
      excludeFromPositionFiles: candidate.excludeFromPositionFiles
    });
  }
  if (!unique(candidates.map((entry) => entry.reference))) {
    return fail("REFERENCE_NATIVE_CONTRACT_INCONSISTENT", "positionCandidates contains duplicate references.");
  }
  return deepFreeze(candidates.sort((left, right) =>
    left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0
  ));
};

const difference = (
  source: ReferenceSetDifference["source"],
  expected: readonly string[],
  observed: readonly string[]
): ReferenceSetDifference => {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  return deepFreeze({
    source,
    missing: sorted(expected.filter((entry) => !observedSet.has(entry))),
    unexpected: sorted(observed.filter((entry) => !expectedSet.has(entry)))
  });
};

export const evaluateReferenceControllerRevAReferenceSetAgreement = (
  observation: ReferenceSetObservation
): ReferenceSetAgreementReport => {
  const canonicalPhysicalReferences = snapshotReferenceSet(
    observation.schematicComponentReferences,
    "schematicComponentReferences"
  );
  const nodeExclusions = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.referenceSetPolicy
    .schematicNodeReferenceExclusions;
  const excludedNodes = new Set(nodeExclusions.map((entry) => entry.reference));
  const expectedSchematicNodeReferences = Object.freeze(
    canonicalPhysicalReferences.filter((reference) => !excludedNodes.has(reference))
  );
  const observed = {
    schematic_nodes: snapshotReferenceSet(observation.schematicNodeReferences, "schematicNodeReferences"),
    exported_bom: snapshotReferenceSet(observation.exportedBomReferences, "exportedBomReferences"),
    native_pcb: snapshotReferenceSet(observation.nativePcbReferences, "nativePcbReferences"),
    positions: snapshotReferenceSet(observation.positionReferences, "positionReferences")
  } as const;
  const positionCandidates = snapshotPositionCandidates(observation.positionCandidates);
  const positionPolicy = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.referenceSetPolicy
    .positionExportPolicy;
  const reviewedPositionExclusions = new Set(
    positionPolicy.reviewedReferenceExclusions.map((entry) => entry.reference)
  );
  const eligiblePositionReferences = Object.freeze(positionCandidates
    .filter((entry) =>
      positionPolicy.boardSides.includes(entry.side) &&
      (!positionPolicy.excludeDnp || !entry.dnp) &&
      (!positionPolicy.honorPcbExcludeFromPositionFiles || !entry.excludeFromPositionFiles) &&
      !reviewedPositionExclusions.has(entry.reference)
    )
    .map((entry) => entry.reference));
  const differences = [
    difference("schematic_nodes", expectedSchematicNodeReferences, observed.schematic_nodes),
    difference("exported_bom", canonicalPhysicalReferences, observed.exported_bom),
    difference("native_pcb", canonicalPhysicalReferences, observed.native_pcb),
    difference("position_candidates", canonicalPhysicalReferences, positionCandidates.map((entry) => entry.reference)),
    difference("positions", eligiblePositionReferences, observed.positions)
  ];
  const payload = {
    schemaVersion: REFERENCE_CONTROLLER_REFERENCE_SET_REPORT_SCHEMA,
    contractIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
    passed: differences.every((entry) => entry.missing.length === 0 && entry.unexpected.length === 0),
    canonicalPhysicalReferences,
    expectedSchematicNodeReferences,
    classifiedExclusions: {
      schematicNodes: nodeExclusions,
      schematicSourceOnly: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.referenceSetPolicy
        .schematicSourceOnlyExclusions,
      positions: positionPolicy.reviewedReferenceExclusions
    },
    differences
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, REFERENCE_CONTROLLER_REFERENCE_SET_REPORT_SCHEMA)
  });
};

export const referenceSetsAgree = (report: ReferenceSetAgreementReport): boolean => {
  const { identity, ...payload } = report;
  const expected = canonicalIdentity(payload, REFERENCE_CONTROLLER_REFERENCE_SET_REPORT_SCHEMA);
  return report.passed && canonicalJson(identity) === canonicalJson(expected);
};
