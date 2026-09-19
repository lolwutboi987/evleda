import { assertFreshNativeNoConnectPcbIsolation, type FreshNativeTerminalBinding } from "./fresh-native-terminal-binding.js";
import { parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  canonicalIdentity,
  canonicalJson,
  constantTimeDigestEqual,
  contentIdentity,
} from "../core/canonical.js";
import {
  hardenPortableValue,
  parsePortableJsonBytes,
} from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
} from "../integrations/pcb-practice-analyzer.js";
import type { KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import {
  FRESH_NETCLASS_ASSIGNMENT_MODEL,
  assertEmptyDerivedNetClassAssignments,
  assertExactContractNetClassPatterns,
  createExactContractNetClassPatterns,
} from "./fresh-netclass-assignment.js";
import {
  FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
  type FreshDesignClearanceEvidence,
} from "./fresh-design-acceptance.js";
import {
  PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION,
  createPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
} from "./pcb-design-compilation-bundle.js";
import {
  PCB_DESIGN_CONTRACT_LIMITS,
  PCB_DESIGN_CONTRACT_SCHEMA_VERSION,
  type PcbDesignContract,
} from "./pcb-design-contract.js";
import {
  GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION,
  assertFreshProjectDirectoryChain,
  isVerifiedFreshProject,
  type FreshProject,
} from "./fresh-project.js";
import { parseFreshPcbStackup } from "./fresh-kicad-parser.js";

/**
 * Host-owned materialization and readback of the narrow KiCad-10 clearance
 * source set supported by the generic two-layer V1 workflow.
 *
 * This is intentionally not a DRC wrapper.  It proves configuration facts
 * from the project, PCB, and optional custom-rule bytes.  Geometry/DRC remain
 * separate acceptance inputs.
 */
export const FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION =
  "evleda.fresh-netclass-materialization.v2" as const;
export const FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION =
  "evleda.fresh-netclass-semantic-authority.v2" as const;
export const FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION =
  "evleda.fresh-netclass-preparation-evidence.v2" as const;
export const FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION =
  "evleda.fresh-clearance-evidence-receipt.v2" as const;
export const FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION =
  "evleda.fresh-clearance-rule-source-set.v2" as const;

export const FRESH_CLEARANCE_EVIDENCE_LIMITS = Object.freeze({
  maximumProjectBytes: 16 * 1024 * 1024,
  maximumPcbBytes: 64 * 1024 * 1024,
  maximumRulesBytes: 4 * 1024 * 1024,
  maximumMarkerBytes: 2 * 1024 * 1024,
  maximumSExpressionDepth: 256,
  maximumSExpressionNodes: 1_000_000,
  maximumTokenBytes: 1024 * 1024,
  maximumProjectClasses: 512,
  maximumProjectAssignments: 10_000,
});

const MANAGED_NETCLASS_PREFIX = "EVLEDA_";
const BOARD_VERSIONS = new Set<number>(PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS);
const CONTRACT_NET_NAME_PATTERN = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u;
const RESERVED_CONTRACT_NET_NAMES = new Set(["__proto__", "constructor", "prototype", "~no-connect", "~unnamed"]);
const CONTRACT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/u;
const KICAD_COMMIT = /^[a-f0-9]{7,64}$/iu;
const HEX_64 = /^[a-f0-9]{64}$/u;
const KICAD_10_VERSION = /^10\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const NUMERIC_EPSILON = 1e-12;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/u;
const MAX_KICAD_NET_ID = 2_147_483_647;
const KICAD_10_LAYER_IDENTITIES_BY_BOARD_VERSION = new Map<number, Readonly<Record<string, number>>>([
  [20250316, Object.freeze({ "F.Cu": 0, "B.Cu": 31, "Edge.Cuts": 44 })],
  [20260206, Object.freeze({ "F.Cu": 0, "B.Cu": 2, "Edge.Cuts": 25, "Dwgs.User": 17 })],
]);
// KiCad 10.0.3 initializes item-layer lookups from the default LSET::Name map;
// the root layer table serializes only enabled layers. These audited technical
// names can therefore appear on native footprint fields, graphics, and pads
// without being enabled in the root table. Copper and other names still need
// an explicit declaration; this does not change any copper-layer/rule checks.
const KICAD_10_TECHNICAL_ITEM_LAYER_NAMES = Object.freeze([
  "F.SilkS", "B.SilkS", "F.Fab", "B.Fab",
  "F.Mask", "B.Mask", "F.Paste", "B.Paste",
] as const);
const KICAD_CAPABILITY_TOKENS = Object.freeze([
  "sch erc",
  "pcb drc",
  "sch export netlist",
  "pcb export stats",
  "pcb export ipcd356",
  "sch export pdf",
  "sch export bom",
  "sch export svg",
  "pcb export gerbers",
  "pcb export drill",
  "pcb export pos",
  "pcb render",
] as const);
const MAX_CLEARANCE_RECEIPT_PAIRS =
  (PCB_DESIGN_CONTRACT_LIMITS.maxNets * (PCB_DESIGN_CONTRACT_LIMITS.maxNets - 1)) / 2;

const isContractNetName = (value: string): boolean =>
  CONTRACT_NET_NAME_PATTERN.test(value)
  && /[A-Za-z0-9]/u.test(value)
  && !RESERVED_CONTRACT_NET_NAMES.has(value.toLowerCase())
  && !/^unconnected-\(/iu.test(value);

export type FreshClearanceEvidenceErrorCode =
  | "INVALID_INPUT"
  | "UNVERIFIED_BUNDLE"
  | "UNVERIFIED_PROJECT"
  | "UNSUPPORTED_KICAD"
  | "INVALID_PROJECT_JSON"
  | "UNSUPPORTED_PCB"
  | "UNSUPPORTED_RULES"
  | "AMBIGUOUS_RULES"
  | "UNASSIGNED_NET"
  | "SOURCE_DRIFT"
  | "ATOMIC_WRITE_FAILED"
  | "ATOMIC_ROLLBACK_FAILED";

export class FreshClearanceEvidenceError extends Error {
  public constructor(
    public readonly code: FreshClearanceEvidenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FreshClearanceEvidenceError";
  }
}

export interface FreshClearanceKicadIdentity {
  readonly kind: "kicad-cli";
  readonly version: string;
  readonly commit: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly capabilityHelpSha256: string;
  readonly confirmedCapabilities: readonly string[];
}

export interface FreshClearanceNetClassBinding {
  readonly contractNetClassId: string;
  readonly kicadNetClassName: string;
  readonly traceWidthMm: number;
  readonly configuredClearanceMm: number;
  readonly netNames: readonly string[];
}

export interface FreshNetClassMaterialization {
  readonly schemaVersion: typeof FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION;
  readonly assignmentModel: typeof FRESH_NETCLASS_ASSIGNMENT_MODEL;
  readonly classification: "candidate-validation";
  readonly origin: "host";
  readonly fabricationAuthorized: false;
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly changed: boolean;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly kicad: FreshClearanceKicadIdentity;
  readonly preimageProjectSettingsIdentity: ContentIdentity;
  readonly projectSettingsIdentity: ContentIdentity;
  readonly pcbIdentityAtMaterialization: ContentIdentity;
  readonly customRulesIdentity: ContentIdentity | null;
  readonly netClasses: readonly FreshClearanceNetClassBinding[];
  readonly identity: CanonicalIdentity;
}

/** Exact KiCad-10 class record written for one bundle-owned managed class. */
export interface FreshNetClassSemanticDefinition {
  readonly bus_width: number;
  readonly clearance: number;
  readonly diff_pair_gap: number;
  readonly diff_pair_via_gap: number;
  readonly diff_pair_width: number;
  readonly line_style: number;
  readonly microvia_diameter: number;
  readonly microvia_drill: number;
  readonly name: string;
  readonly pcb_color: string;
  readonly priority: number;
  readonly schematic_color: string;
  readonly track_width: number;
  readonly tuning_profile: string;
  readonly via_diameter: number;
  readonly via_drill: number;
  readonly wire_width: number;
}

export interface FreshNetClassContractAssignment {
  readonly netName: string;
  readonly contractNetClassId: string;
  readonly kicadNetClassName: string;
}

/**
 * Stable, path-free pre-authoring authority for the materialized net-class
 * semantics. It intentionally excludes transaction and raw-source identities.
 */
export interface FreshNetClassSemanticAuthority {
  readonly schemaVersion: typeof FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION;
  readonly classification: "candidate-validation";
  readonly origin: "host";
  readonly fabricationAuthorized: false;
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly kicad: FreshClearanceKicadIdentity;
  readonly ruleResolution: Readonly<{
    readonly boardMinimum: "absolute-floor";
    readonly netClassConflict: "larger-clearance";
    readonly customRules: "absent-or-empty-only";
    readonly localPadOrFootprintOverrides: "rejected";
    readonly zones: "rejected";
    readonly netClassPatterns: typeof FRESH_NETCLASS_ASSIGNMENT_MODEL.netClassPatterns;
    readonly derivedLabelAssignments: "empty-only";
    readonly contractNetAssignments: "exclusive";
  }>;
  readonly boardMinimumClearanceMm: number;
  /** Complete exact records for bundle-owned managed classes only. */
  readonly netClasses: readonly FreshNetClassSemanticDefinition[];
  /** One deterministic exclusive assignment for every contract net. */
  readonly contractNetAssignments: readonly FreshNetClassContractAssignment[];
  readonly identity: CanonicalIdentity;
}

/** Closed, path-free bridge from the write receipt to its stable semantics. */
export interface FreshNetClassPreparationEvidence {
  readonly schemaVersion: typeof FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION;
  readonly classification: "candidate-validation";
  readonly origin: "host";
  readonly fabricationAuthorized: false;
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly kicad: FreshClearanceKicadIdentity;
  readonly materializationIdentity: CanonicalIdentity;
  readonly semanticAuthorityIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

export interface FreshClearancePairEvidence {
  readonly leftNet: string;
  readonly rightNet: string;
  readonly effectiveClearanceMm: number;
  readonly limitingSources: readonly string[];
}

export interface FreshClearanceNetEvidence {
  readonly name: string;
  readonly contractNetClassId: string;
  readonly kicadNetClassName: string;
  readonly configuredClearanceMm: number;
  readonly effectiveClearanceMm: number;
}

export interface FreshClearanceEvidenceReceipt {
  readonly schemaVersion: typeof FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  readonly classification: "candidate-validation";
  readonly origin: "host";
  readonly fabricationAuthorized: false;
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly kicad: FreshClearanceKicadIdentity;
  readonly sourceIdentities: Readonly<{
    readonly projectSettings: ContentIdentity;
    readonly customRules: ContentIdentity | null;
    readonly pcb: ContentIdentity;
    readonly ruleSourceSet: CanonicalIdentity;
  }>;
  readonly ruleResolution: Readonly<{
    readonly boardMinimum: "absolute-floor";
    readonly netClassConflict: "larger-clearance";
    readonly customRules: "absent-or-empty-only";
    readonly localPadOrFootprintOverrides: "rejected";
    readonly zones: "rejected";
    readonly netClassPatterns: typeof FRESH_NETCLASS_ASSIGNMENT_MODEL.netClassPatterns;
    readonly derivedLabelAssignments: "empty-only";
    readonly contractNetAssignments: "exclusive";
  }>;
  readonly boardMinimumClearanceMm: number;
  readonly netClasses: readonly FreshClearanceNetClassBinding[];
  readonly nets: readonly FreshClearanceNetEvidence[];
  readonly pairs: readonly FreshClearancePairEvidence[];
  /** Exact compatibility projection consumed by fresh-design acceptance V1. */
  readonly acceptanceEvidence: FreshDesignClearanceEvidence;
  readonly evidenceLimitations: readonly string[];
  readonly identity: CanonicalIdentity;
}

export interface FreshClearanceOperationOptions {
  readonly project: FreshProject;
  /** Must be a bundle authenticated by the create/parse bundle boundary. */
  readonly compilationBundle: PcbDesignCompilationBundle;
  /** Use KicadCliAdapter.identity; executable paths are neither used nor persisted. */
  readonly kicad: KicadExecutableIdentity;
}

/** Shared configuration facts only; this is not a V1 contract or a clearance artifact. */
export type FreshNetClassSourceContract = Pick<PcbDesignContract, "identity" | "scope" | "netClasses" | "nets"> & {
  readonly routingConstraints: Pick<PcbDesignContract["routingConstraints"], "viaPolicy">;
};
export interface FreshNetClassSourceBundle {
  readonly identity: CanonicalIdentity;
  readonly contract: FreshNetClassSourceContract;
}
interface SharedNetClassOperationOptions {
  readonly project: FreshProject;
  readonly compilationBundle: FreshNetClassSourceBundle;
  readonly kicad: KicadExecutableIdentity;
  readonly zones: "rejected" | "not-evaluated";
  /** Supplied only by a family-specific host boundary, never by model input. */
  readonly authenticateMarker: (bytes: Buffer) => Promise<void>;
  /** Exact family-owned rule source validation; omission preserves V1 absent/empty rules. */
  readonly validateCustomRules?: (source: CapturedFile | null) => void;
  /** Optional family-owned exact numeric policy; never repairs or overrides current source drift. */
  readonly assertProjectSettings?: (settings: Readonly<Record<string, unknown>>) => void;
  /** Family-owned current native parity; never a provider list of extra names. */
  readonly qualifyNativeTerminals?: (pcbSource: string) => Promise<FreshNativeTerminalBinding | undefined>;
  readonly assertNativeTerminalSourcesCurrent?: () => Promise<void>;
}

interface Atom {
  readonly value: string;
  readonly quoted: boolean;
}

interface SExpressionNode {
  readonly name: string;
  readonly values: readonly Atom[];
  readonly children: readonly SExpressionNode[];
}

interface CapturedFile {
  readonly bytes: Buffer;
  readonly identity: ContentIdentity;
  readonly mode: number;
}

interface SourcePaths {
  readonly projectSettings: string;
  readonly pcb: string;
  readonly customRules: string;
  readonly marker: string;
  readonly lock: string;
}

interface CapturedSources {
  readonly projectSettings: CapturedFile;
  readonly pcb: CapturedFile;
  readonly customRules: CapturedFile | null;
  readonly marker: CapturedFile;
}

interface PcbFacts {
  readonly fileVersion: number;
  readonly generatorVersion: string | null;
  readonly netNames: readonly string[];
}

interface ProjectReadback {
  readonly boardMinimumClearanceMm: number;
  readonly netClasses: readonly FreshClearanceNetClassBinding[];
}

type JsonRecord = Record<string, unknown>;

const fail = (
  code: FreshClearanceEvidenceErrorCode,
  message: string,
  cause?: unknown,
): never => {
  throw new FreshClearanceEvidenceError(code, message, cause === undefined ? undefined : { cause });
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown, label: string, code: FreshClearanceEvidenceErrorCode): JsonRecord => {
  if (!isRecord(value)) return fail(code, `${label} must be a JSON object.`);
  return value;
};

const exactKeys = (
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string,
  code: FreshClearanceEvidenceErrorCode = "INVALID_INPUT",
): void => {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} must contain exactly the closed V1 member set.`);
  }
};

const validateCanonicalIdentityShape = (
  value: unknown,
  label: string,
  expectedSchemaVersion?: string,
): CanonicalIdentity => {
  const identity = record(value, label, "INVALID_INPUT");
  exactKeys(identity, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], label);
  if (identity.algorithm !== "sha256"
      || typeof identity.digest !== "string" || !HEX_64.test(identity.digest)
      || typeof identity.schemaVersion !== "string" || identity.schemaVersion.length === 0 || identity.schemaVersion.length > 256
      || (expectedSchemaVersion !== undefined && identity.schemaVersion !== expectedSchemaVersion)
      || identity.canonicalizationVersion !== "evleda-c14n-json-v1") {
    return fail("INVALID_INPUT", `${label} is not a valid canonical identity in the required domain.`);
  }
  return identity as unknown as CanonicalIdentity;
};

const validateContentIdentityShape = (
  value: unknown,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): ContentIdentity => {
  const identity = record(value, label, "INVALID_INPUT");
  exactKeys(identity, ["algorithm", "digest", "size"], label);
  if (identity.algorithm !== "sha256"
      || typeof identity.digest !== "string" || !HEX_64.test(identity.digest)
      || typeof identity.size !== "number" || !Number.isSafeInteger(identity.size)
      || identity.size <= 0 || identity.size > maximumBytes) {
    return fail("INVALID_INPUT", `${label} is not a valid nonempty content identity.`);
  }
  return identity as unknown as ContentIdentity;
};

const contentIdentitiesEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === "sha256"
  && right.algorithm === "sha256"
  && left.size === right.size
  && constantTimeDigestEqual(left.digest, right.digest);

const canonicalValuesEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const numericMillimetres = (
  value: unknown,
  label: string,
  code: FreshClearanceEvidenceErrorCode,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 500) {
    return fail(code, `${label} must be a finite nonnegative millimetre value.`);
  }
  return value;
};

const boundedMillimetres = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: FreshClearanceEvidenceErrorCode = "INVALID_INPUT",
): number => {
  const numeric = numericMillimetres(value, label, code);
  if (numeric < minimum || numeric > maximum) {
    return fail(code, `${label} must be between ${minimum} and ${maximum} millimetres.`);
  }
  return numeric;
};

const cloneJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const result = Object.create(null) as JsonRecord;
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: cloneJson(child), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  return value;
};

const normalizedKicadIdentity = (input: KicadExecutableIdentity): FreshClearanceKicadIdentity => {
  let value: Readonly<Record<string, unknown>>;
  try {
    value = record(hardenPortableValue(input, {
      maxBytes: 256 * 1024,
      maxDepth: 8,
      maxNodes: 2_048,
      maxArrayLength: 256,
      maxOwnKeys: 64,
      maxKeyBytes: 128,
      maxStringBytes: 4_096,
    }), "KiCad executable identity", "INVALID_INPUT");
  } catch (error) {
    return fail("INVALID_INPUT", "KiCad executable identity is not bounded plain host data.", error);
  }
  const capabilities = value.confirmedCapabilities;
  const capabilityOrder = new Map<string, number>(
    KICAD_CAPABILITY_TOKENS.map((capability, index) => [capability, index]),
  );
  if (value.kind !== "kicad-cli"
      || typeof value.version !== "string" || !KICAD_10_VERSION.test(value.version)
      || typeof value.commit !== "string" || !KICAD_COMMIT.test(value.commit)
      || typeof value.sha256 !== "string" || !HEX_64.test(value.sha256)
      || typeof value.capabilityHelpSha256 !== "string" || !HEX_64.test(value.capabilityHelpSha256)
      || typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0
      || !Array.isArray(capabilities)
      || capabilities.length > 256
      || capabilities.some((entry) => typeof entry !== "string" || !capabilityOrder.has(entry))
      || new Set(capabilities).size !== capabilities.length
      || capabilities.some((entry, index) => index > 0
        && capabilityOrder.get(capabilities[index - 1] as string)! >= capabilityOrder.get(entry as string)!)) {
    return fail("UNSUPPORTED_KICAD", "Clearance evidence requires an exact host-observed KiCad 10 executable identity.");
  }
  return deepFreeze({
    kind: "kicad-cli",
    version: value.version,
    commit: value.commit,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    capabilityHelpSha256: value.capabilityHelpSha256,
    confirmedCapabilities: [...capabilities] as string[],
  });
};

const managedClassName = (bundle: FreshNetClassSourceBundle, index: number): string =>
  `${MANAGED_NETCLASS_PREFIX}${bundle.identity.digest.slice(0, 12)}_C${String(index + 1).padStart(2, "0")}`;

const classBindings = (bundle: FreshNetClassSourceBundle): readonly FreshClearanceNetClassBinding[] => {
  const ordered = [...bundle.contract.netClasses].sort((left, right) => compareText(left.id, right.id));
  return deepFreeze(ordered.map((netClass, index) => ({
    contractNetClassId: netClass.id,
    kicadNetClassName: managedClassName(bundle, index),
    traceWidthMm: netClass.traceWidthMm,
    configuredClearanceMm: netClass.clearanceMm,
    netNames: bundle.contract.nets
      .filter((net) => net.netClassId === netClass.id)
      .map((net) => net.name)
      .sort(compareText),
  })));
};

const validateTwoLayerContract = (contract: FreshNetClassSourceContract): void => {
  if (contract.scope.board.layerCount !== 2
      || contract.scope.board.copperLayers.length !== 2
      || contract.scope.board.copperLayers[0] !== "F.Cu"
      || contract.scope.board.copperLayers[1] !== "B.Cu") {
    fail("INVALID_INPUT", "Fresh clearance evidence supports only the closed two-layer PCB contract V1.");
  }
};

const sourcePaths = async (project: FreshProject): Promise<SourcePaths> => {
  if (!isVerifiedFreshProject(project) || project.workflowKind !== "generic" || project.genericBinding === undefined) {
    return fail("UNVERIFIED_PROJECT", "Clearance materialization requires a bundle-bound generic FreshProject capability.");
  }
  return commonSourcePaths(project);
};

const commonSourcePaths = async (project: FreshProject): Promise<SourcePaths> => {
  if (!isVerifiedFreshProject(project)) return fail("UNVERIFIED_PROJECT", "Net-class preparation requires an authenticated FreshProject capability.");
  try {
    await assertFreshProjectDirectoryChain(project);
  } catch (error) {
    return fail("UNVERIFIED_PROJECT", "Fresh project directory identity is no longer valid.", error);
  }
  const root = path.resolve(project.projectPath);
  const expectedPcb = path.join(root, `${project.name}.kicad_pcb`);
  const expectedMarker = path.join(path.resolve(project.outputPath), ".evleda-pcb-agent-fresh.json");
  if (path.resolve(project.pcbPath) !== expectedPcb
      || path.resolve(project.markerPath) !== expectedMarker
      || path.dirname(expectedPcb) !== root
      || path.dirname(expectedMarker) !== path.resolve(project.outputPath)) {
    return fail("UNVERIFIED_PROJECT", "Fresh project paths are not the exact marker-owned direct children.");
  }
  return Object.freeze({
    projectSettings: path.join(root, `${project.name}.kicad_pro`),
    pcb: expectedPcb,
    customRules: path.join(root, `${project.name}.kicad_dru`),
    marker: expectedMarker,
    lock: path.join(root, ".evleda-fresh-clearance.lock"),
  });
};

const captureRequired = async (
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<CapturedFile> => {
  let before;
  try { before = await lstat(filePath, { bigint: true }); }
  catch (error) { return fail("SOURCE_DRIFT", `${label} is missing or unreadable.`, error); }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
    return fail("SOURCE_DRIFT", `${label} must be a bounded regular non-link file.`);
  }
  let bytes: Buffer;
  try { bytes = await readFile(filePath); }
  catch (error) { return fail("SOURCE_DRIFT", `${label} could not be captured.`, error); }
  const after = await lstat(filePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== after.size) {
    return fail("SOURCE_DRIFT", `${label} changed while its bytes were being captured.`);
  }
  return Object.freeze({ bytes, identity: contentIdentity(bytes), mode: Number(after.mode & 0o777n) });
};

const captureOptional = async (
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<CapturedFile | null> => {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("SOURCE_DRIFT", `${label} cannot be inspected.`, error);
  }
  return captureRequired(filePath, maximumBytes, label);
};

const captureSourceSet = async (paths: SourcePaths): Promise<CapturedSources> => {
  const [projectSettings, pcb, customRules, marker] = await Promise.all([
    captureRequired(paths.projectSettings, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes, "KiCad project settings"),
    captureRequired(paths.pcb, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumPcbBytes, "KiCad PCB"),
    captureOptional(paths.customRules, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumRulesBytes, "KiCad custom rules"),
    captureRequired(paths.marker, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes, "Fresh project marker"),
  ]);
  return Object.freeze({ projectSettings, pcb, customRules, marker });
};

const sameOptionalCapture = (left: CapturedFile | null, right: CapturedFile | null): boolean =>
  left === null ? right === null : right !== null && contentIdentitiesEqual(left.identity, right.identity);

const sourceSetsEqual = (left: CapturedSources, right: CapturedSources): boolean =>
  contentIdentitiesEqual(left.projectSettings.identity, right.projectSettings.identity)
  && contentIdentitiesEqual(left.pcb.identity, right.pcb.identity)
  && contentIdentitiesEqual(left.marker.identity, right.marker.identity)
  && sameOptionalCapture(left.customRules, right.customRules);

const strictProjectJson = (bytes: Buffer): JsonRecord => {
  let parsed: unknown;
  try {
    parsed = parsePortableJsonBytes(bytes, {
      maxBytes: FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes,
      maxDepth: 64,
      maxNodes: 500_000,
      maxArrayLength: 100_000,
      maxOwnKeys: 10_000,
      maxKeyBytes: 1_024,
      maxStringBytes: 1024 * 1024,
    });
  } catch (error) {
    return fail("INVALID_PROJECT_JSON", "KiCad project settings are not bounded, duplicate-free strict UTF-8 JSON.", error);
  }
  return record(parsed, "KiCad project settings", "INVALID_PROJECT_JSON");
};

const validateMarkerBinding = async (
  bytes: Buffer,
  project: FreshProject,
  bundle: PcbDesignCompilationBundle,
): Promise<void> => {
  let authenticatedMarkerIdentity: ContentIdentity;
  try { authenticatedMarkerIdentity = await project.assertMarkerCurrent(); }
  catch (error) {
    return fail("UNVERIFIED_PROJECT", "FreshProject rejected its closed original marker identity.", error);
  }
  const capturedMarkerIdentity = contentIdentity(bytes);
  if (!contentIdentitiesEqual(authenticatedMarkerIdentity, capturedMarkerIdentity)) {
    return fail("UNVERIFIED_PROJECT", "Captured marker bytes differ from the marker authenticated by the FreshProject capability.");
  }
  let parsed: unknown;
  try {
    parsed = parsePortableJsonBytes(bytes, {
      maxBytes: FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes,
      maxDepth: 64,
      maxNodes: 100_000,
      maxArrayLength: 10_000,
      maxOwnKeys: 2_048,
      maxKeyBytes: 512,
      maxStringBytes: 512 * 1024,
    });
  } catch (error) {
    return fail("UNVERIFIED_PROJECT", "Fresh project marker is not strict bounded JSON.", error);
  }
  const marker = record(parsed, "Fresh project marker", "UNVERIFIED_PROJECT");
  if (marker.schemaVersion !== "evleda.pcb-agent-fresh-project.v2"
      || marker.workflowKind !== "generic"
      || marker.name !== project.name
      || marker.outputPath !== project.outputPath
      || marker.projectPath !== project.projectPath
      || !canonicalValuesEqual(marker.genericBinding, project.genericBinding)) {
    fail("UNVERIFIED_PROJECT", "Fresh project marker no longer carries the exact in-process generic binding.");
  }
  let actualReference;
  try { actualReference = createPcbDesignCompilationBundleRef(bundle); }
  catch (error) { return fail("UNVERIFIED_BUNDLE", "Compilation bundle was not authenticated by its create/parse boundary.", error); }
  if (!canonicalValuesEqual(actualReference, project.genericBinding!.bundleRef)
      || !canonicalValuesEqual(bundle.contract.identity, project.genericBinding!.contractIdentity)) {
    fail("UNVERIFIED_BUNDLE", "Authenticated compilation bundle does not match the generic FreshProject binding.");
  }
};

class BoundedSExpressionParser {
  readonly #source: string;
  #cursor = 0;
  #nodeCount = 0;

  public constructor(source: string) {
    this.#source = source;
  }

  public parseAll(): readonly SExpressionNode[] {
    const nodes: SExpressionNode[] = [];
    this.#skipTrivia();
    while (this.#cursor < this.#source.length) {
      nodes.push(this.#node(1));
      this.#skipTrivia();
    }
    return nodes;
  }

  #increment(): void {
    this.#nodeCount += 1;
    if (this.#nodeCount > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumSExpressionNodes) {
      fail("UNSUPPORTED_PCB", "KiCad S-expression node budget was exceeded.");
    }
  }

  #skipTrivia(): void {
    while (this.#cursor < this.#source.length) {
      while (this.#cursor < this.#source.length && /\s/u.test(this.#source[this.#cursor]!)) this.#cursor += 1;
      if (this.#source[this.#cursor] !== "#") return;
      while (this.#cursor < this.#source.length && this.#source[this.#cursor] !== "\n") this.#cursor += 1;
    }
  }

  #atom(): Atom {
    this.#increment();
    if (this.#source[this.#cursor] === '"') {
      this.#cursor += 1;
      let value = "";
      while (this.#cursor < this.#source.length) {
        const character = this.#source[this.#cursor++]!;
        if (character === '"') {
          if (Buffer.byteLength(value, "utf8") > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumTokenBytes) {
            fail("UNSUPPORTED_PCB", "KiCad S-expression token budget was exceeded.");
          }
          return { value, quoted: true };
        }
        if (character === "\\") {
          if (this.#cursor >= this.#source.length) fail("UNSUPPORTED_PCB", "KiCad string has an unterminated escape.");
          const escaped = this.#source[this.#cursor++]!;
          const replacements: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
          if (!Object.hasOwn(replacements, escaped)) fail("UNSUPPORTED_PCB", "KiCad string uses an unsupported escape.");
          value += replacements[escaped]!;
        } else {
          if (character.charCodeAt(0) < 0x20) fail("UNSUPPORTED_PCB", "KiCad string contains an unescaped control character.");
          value += character;
        }
        if (value.length > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumTokenBytes) {
          fail("UNSUPPORTED_PCB", "KiCad S-expression token budget was exceeded.");
        }
      }
      return fail("UNSUPPORTED_PCB", "KiCad string is unterminated.");
    }
    const start = this.#cursor;
    while (this.#cursor < this.#source.length
      && !/[\s()#]/u.test(this.#source[this.#cursor]!)) this.#cursor += 1;
    if (this.#cursor === start) return fail("UNSUPPORTED_PCB", "Expected a KiCad S-expression atom.");
    const value = this.#source.slice(start, this.#cursor);
    if (Buffer.byteLength(value, "utf8") > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumTokenBytes) {
      return fail("UNSUPPORTED_PCB", "KiCad S-expression token budget was exceeded.");
    }
    return { value, quoted: false };
  }

  #node(depth: number): SExpressionNode {
    if (depth > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumSExpressionDepth) {
      return fail("UNSUPPORTED_PCB", "KiCad S-expression nesting is unsupported.");
    }
    if (this.#source[this.#cursor] !== "(") return fail("UNSUPPORTED_PCB", "Expected a KiCad S-expression form.");
    this.#cursor += 1;
    this.#skipTrivia();
    if (this.#cursor >= this.#source.length || this.#source[this.#cursor] === "(" || this.#source[this.#cursor] === ")") {
      return fail("UNSUPPORTED_PCB", "KiCad S-expression form has no name.");
    }
    const head = this.#atom();
    if (head.quoted) return fail("UNSUPPORTED_PCB", "KiCad S-expression form names cannot be quoted.");
    const values: Atom[] = [];
    const children: SExpressionNode[] = [];
    while (true) {
      this.#skipTrivia();
      if (this.#cursor >= this.#source.length) return fail("UNSUPPORTED_PCB", `KiCad ${head.value} form is unterminated.`);
      if (this.#source[this.#cursor] === ")") {
        this.#cursor += 1;
        return { name: head.value, values, children };
      }
      if (this.#source[this.#cursor] === "(") children.push(this.#node(depth + 1));
      else values.push(this.#atom());
    }
  }
}

const decodeUtf8 = (
  bytes: Buffer,
  label: string,
  code: FreshClearanceEvidenceErrorCode,
): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { return fail(code, `${label} is not strict UTF-8.`, error); }
};

const parseSExpressions = (
  bytes: Buffer,
  label: string,
  code: FreshClearanceEvidenceErrorCode,
): readonly SExpressionNode[] => {
  try {
    return new BoundedSExpressionParser(decodeUtf8(bytes, label, code)).parseAll();
  } catch (error) {
    if (error instanceof FreshClearanceEvidenceError) {
      if (error.code === code) throw error;
      return fail(code, `${label} has unsupported S-expression syntax.`, error);
    }
    return fail(code, `${label} has unsupported S-expression syntax.`, error);
  }
};

const directChildren = (node: SExpressionNode, name: string): readonly SExpressionNode[] =>
  node.children.filter((child) => child.name === name);

const oneChild = (node: SExpressionNode, name: string): SExpressionNode | null => {
  const matches = directChildren(node, name);
  return matches.length === 1 ? matches[0]! : null;
};

const scalarChild = (node: SExpressionNode, name: string): string | null => {
  const child = oneChild(node, name);
  return child !== null && child.children.length === 0 && child.values.length === 1
    ? child.values[0]!.value
    : null;
};

const descendants = (node: SExpressionNode, skipZoneContents = false): readonly SExpressionNode[] => {
  const result: SExpressionNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length > 0) {
    const child = pending.pop()!;
    result.push(child);
    if (skipZoneContents && child.name === "zone") continue;
    for (let index = child.children.length - 1; index >= 0; index -= 1) pending.push(child.children[index]!);
  }
  return result;
};

const parseCustomRuleSource = (source: CapturedFile | null): void => {
  if (source === null) return;
  const forms = parseSExpressions(source.bytes, "KiCad custom rules", "UNSUPPORTED_RULES");
  if (forms.length !== 1
      || forms[0]!.name !== "version"
      || forms[0]!.children.length !== 0
      || forms[0]!.values.length !== 1
      || forms[0]!.values[0]!.quoted
      || forms[0]!.values[0]!.value !== "1") {
    fail(
      "UNSUPPORTED_RULES",
      "Custom .kicad_dru rules are unsupported by clearance evidence V1; only an absent or empty version-1 deck is accepted.",
    );
  }
};

const netReference = (
  node: SExpressionNode,
  numericNets: ReadonlyMap<string, string>,
): string | null => {
  if (node.children.length !== 0 || node.values.length < 1 || node.values.length > 2) {
    return fail("UNSUPPORTED_PCB", "PCB item net reference is malformed or ambiguous.");
  }
  const first = node.values[0]!;
  if (node.values.length === 1) {
    if (first.quoted) return first.value.length === 0 ? null : first.value;
    if (!isCanonicalUnsignedInteger(first.value, MAX_KICAD_NET_ID)) {
      return fail("UNSUPPORTED_PCB", "PCB item net reference is neither a quoted name nor a canonical bounded numeric ID.");
    }
    if (first.value === "0") return null;
    const resolved = numericNets.get(first.value);
    if (resolved === undefined || resolved.length === 0) return fail("UNSUPPORTED_PCB", `PCB item references undeclared net ID ${first.value}.`);
    return resolved;
  }
  const second = node.values[1]!;
  if (first.quoted || !isCanonicalUnsignedInteger(first.value, MAX_KICAD_NET_ID)
      || !second.quoted || (first.value === "0") !== (second.value === "")) {
    return fail("UNSUPPORTED_PCB", "PCB item net ID/name pair is malformed.");
  }
  const declared = numericNets.get(first.value);
  if (declared === undefined || declared !== second.value) {
    return fail("UNSUPPORTED_PCB", "PCB item net ID/name pair is missing from or conflicts with the unique board net table.");
  }
  return first.value === "0" ? null : declared;
};

/** Root forms accepted by KiCad 10.0.3's parseBOARD_unchecked switch. */
const KICAD_10_ROOT_FORMS = new Set([
  "version", "host", "generator", "generator_version", "general", "page", "paper", "title_block",
  "layers", "setup", "property", "variants", "net", "net_class",
  "gr_arc", "gr_curve", "gr_line", "gr_poly", "gr_circle", "gr_rect", "image", "barcode",
  "gr_text", "gr_text_box", "table", "dimension", "footprint", "segment", "arc",
  "group", "generated", "via", "zone", "target", "point", "embedded_fonts", "embedded_files",
]);

const SINGLE_LAYER_FORMS = new Set([
  "gr_arc", "gr_curve", "gr_line", "gr_poly", "gr_circle", "gr_rect", "image", "barcode",
  "gr_text", "gr_text_box", "table", "table_cell", "dimension", "footprint", "target", "point",
  "fp_arc", "fp_curve", "fp_line", "fp_poly", "fp_circle", "fp_rect", "fp_text", "fp_text_box",
  "generated",
]);

const COPPER_GRAPHIC_FORMS = new Set([
  "gr_arc", "gr_curve", "gr_line", "gr_poly", "gr_circle", "gr_rect", "image", "barcode",
  "gr_text", "gr_text_box", "table", "table_cell", "dimension", "target", "point",
  "fp_arc", "fp_curve", "fp_line", "fp_poly", "fp_circle", "fp_rect", "fp_text", "fp_text_box",
  "property",
]);

const isCanonicalUnsignedInteger = (value: string, maximum: number): boolean => {
  if (!CANONICAL_UNSIGNED_DECIMAL.test(value) || value.length > 10) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum;
};

const declaredLayerNames = (
  layers: SExpressionNode,
  fileVersion: number,
): ReadonlySet<string> => {
  if (layers.values.length !== 0 || layers.children.length === 0) {
    return fail("UNSUPPORTED_PCB", "PCB layer table is empty or malformed.");
  }
  const auditedIdentities = KICAD_10_LAYER_IDENTITIES_BY_BOARD_VERSION.get(fileVersion);
  if (auditedIdentities === undefined) {
    return fail("UNSUPPORTED_PCB", "PCB layer-table identity mapping is not audited for this file version.");
  }
  const names = new Set<string>();
  const ordinals = new Set<number>();
  for (const entry of layers.children) {
    if (!isCanonicalUnsignedInteger(entry.name, 63) || entry.children.length !== 0 || entry.values.length < 2
        || !entry.values[0]!.quoted || entry.values[0]!.value.length === 0
        || entry.values[1]!.quoted || names.has(entry.values[0]!.value)) {
      return fail("UNSUPPORTED_PCB", "PCB layer table contains a malformed or duplicate layer entry.");
    }
    const ordinal = Number(entry.name);
    const name = entry.values[0]!.value;
    const auditedOrdinal = auditedIdentities[name];
    if (fileVersion === 20260206 && (name === "Dwgs.User" || ordinal === 17)
        && (name !== "Dwgs.User" || ordinal !== 17 || entry.values[1]!.value !== "user"
          || entry.values.length > 3 || entry.values[2] !== undefined && !entry.values[2]!.quoted)) {
      return fail("UNSUPPORTED_PCB", "PCB Dwgs.User must retain its audited ordinal 17 and user type; aliases or conflicting declarations are unsupported.");
    }
    if (ordinals.has(ordinal)
        || (auditedOrdinal !== undefined && ordinal !== auditedOrdinal)) {
      return fail("UNSUPPORTED_PCB", "PCB layer table ordinals must be unique and match the audited file-version identity mapping.");
    }
    ordinals.add(ordinal);
    names.add(name);
  }
  return names;
};

const exactSingleLayer = (item: SExpressionNode, layerNames: ReadonlySet<string>): string => {
  const fields = directChildren(item, "layer");
  if (fields.length !== 1 || fields[0]!.children.length !== 0 || fields[0]!.values.length !== 1
      || !fields[0]!.values[0]!.quoted) {
    return fail("UNSUPPORTED_PCB", `PCB ${item.name} must contain exactly one well-formed layer child.`);
  }
  const name = fields[0]!.values[0]!.value;
  if (!layerNames.has(name)) {
    return fail("UNSUPPORTED_PCB", `PCB ${item.name} layer ${JSON.stringify(name)} is neither declared nor an audited technical layer name.`);
  }
  return name;
};

const exactLayerSet = (
  item: SExpressionNode,
  layerNames: ReadonlySet<string>,
): readonly string[] => {
  const fields = directChildren(item, "layers");
  if (fields.length !== 1 || fields[0]!.children.length !== 0 || fields[0]!.values.length === 0
      || fields[0]!.values.length > 64 || fields[0]!.values.some((entry) => !entry.quoted)) {
    return fail("UNSUPPORTED_PCB", `PCB ${item.name} must contain exactly one well-formed layers child.`);
  }
  const supportedWildcards = new Set(["*.Cu", "F&B.Cu", "*.Mask", "*.Paste"]);
  const names = fields[0]!.values.map((entry) => entry.value);
  if (new Set(names).size !== names.length) {
    return fail("UNSUPPORTED_PCB", `PCB ${item.name} layers contain duplicate names.`);
  }
  if (names.some((name) => !layerNames.has(name) && !supportedWildcards.has(name))) {
    return fail("UNSUPPORTED_PCB", `PCB ${item.name} layers contain a name outside declared layers, audited technical names, and supported wildcards.`);
  }
  return names;
};

/** Stackup layer rows are metadata, never copper-item selectors. Validate their exact source before excluding them. */
const closedStackupMetadata = (root: SExpressionNode, source: string): ReadonlySet<SExpressionNode> => {
  const all = descendants(root);
  const stacks = all.filter(item => item.name === "stackup");
  if (stacks.length === 0) return new Set();
  const setups = directChildren(root, "setup");
  if (stacks.length !== 1 || setups.length !== 1 || all.filter(item => item.name === "setup").length !== 1
      || setups[0]!.values.length !== 0 || directChildren(setups[0]!, "stackup")[0] !== stacks[0]) {
    return fail("UNSUPPORTED_PCB", "Physical stackup must be the single direct child of one root setup form.");
  }
  const observed = parseFreshPcbStackup(source);
  if (observed.status !== "explicit" || !observed.observationsComplete || observed.issues.length !== 0) {
    return fail("UNSUPPORTED_PCB", "Physical stackup contains unsupported, ambiguous or incomplete source metadata.");
  }
  const metadata = new Set([stacks[0]!, ...descendants(stacks[0]!)]);
  // Do not let the metadata distinction hide copper objects or rogue selectors anywhere in setup.
  const itemKinds = new Set([...SINGLE_LAYER_FORMS, "arc", "segment", "pad", "via", "zone", "module", "net", "net_class"]);
  for (const item of descendants(setups[0]!)) {
    if (!metadata.has(item) && (itemKinds.has(item.name) || item.name === "layer" || item.name === "layers")) {
      return fail("UNSUPPORTED_PCB", "PCB setup metadata contains a nested board item or unexpected layer selector.");
    }
  }
  return metadata;
};

const assertClosedLayeredItems = (
  root: SExpressionNode,
  layerNames: ReadonlySet<string>,
  source: string,
  zones: "rejected" | "not-evaluated" = "rejected",
  fileVersion?: number,
): void => {
  // The 20260206 native USB-C source retains stock drawing graphics on a
  // disabled Dwgs.User layer. KiCad 10.0.3 initializes this default name in
  // parser::init independently of the enabled root table. Bound that exception
  // to ordinary footprint graphics; it confers no pad, route or copper meaning.
  const footprintGraphicLayers = fileVersion === 20260206 ? new Set([...layerNames, "Dwgs.User"]) : layerNames;
  for (const child of root.children) {
    if (!KICAD_10_ROOT_FORMS.has(child.name)) {
      fail("UNSUPPORTED_PCB", `PCB root contains unsupported KiCad form ${child.name}.`);
    }
  }
  if (directChildren(root, "net_class").length > 0) {
    fail("UNSUPPORTED_RULES", "Legacy board-embedded net classes are unsupported; project-local net_settings is authoritative.");
  }
  if (descendants(root, zones === "not-evaluated").some((item) => item.name === "module")) {
    fail("UNSUPPORTED_PCB", "Legacy module records are outside the audited KiCad-10 clearance object model.");
  }
  const stackupMetadata = closedStackupMetadata(root, source);
  for (const item of descendants(root, zones === "not-evaluated")) {
    if (stackupMetadata.has(item)) continue;
    // Zone settings and descendants are not promoted into V1 clearance evidence.
    // The plane family reports them as not evaluated and needs its own later gate.
    if (zones === "not-evaluated" && item.name === "zone") continue;
    const layerFields = directChildren(item, "layer");
    const layerSetFields = directChildren(item, "layers");
    if (SINGLE_LAYER_FORMS.has(item.name)) {
      if (layerSetFields.length !== 0) {
        fail("UNSUPPORTED_PCB", `Single-layer PCB ${item.name} cannot carry a plural layers child.`);
      }
      const layer = exactSingleLayer(item, item.name.startsWith("fp_") && COPPER_GRAPHIC_FORMS.has(item.name) ? footprintGraphicLayers : layerNames);
      if (COPPER_GRAPHIC_FORMS.has(item.name) && (layer === "F.Cu" || layer === "B.Cu")) {
        fail("UNSUPPORTED_PCB", `Copper ${item.name} graphics are outside the clearance-evidence V1 object model.`);
      }
      continue;
    }
    if (item.name === "arc" || item.name === "segment") {
      if (layerFields.length > 0 && layerSetFields.length > 0) {
        fail("UNSUPPORTED_PCB", `PCB ${item.name} cannot carry both layer and layers children.`);
      }
      const layers = layerFields.length === 1
        ? [exactSingleLayer(item, layerNames)]
        : exactLayerSet(item, layerNames);
      if (layers.filter((layer) => layer === "F.Cu" || layer === "B.Cu" || layer === "*.Cu" || layer === "F&B.Cu").length !== 1) {
        fail("UNSUPPORTED_PCB", `PCB routed ${item.name} must resolve to exactly one copper layer.`);
      }
      continue;
    }
    if (item.name === "pad") {
      exactLayerSet(item, layerNames);
      if (layerFields.length > 0) fail("UNSUPPORTED_PCB", "PCB pad has an unexpected singular layer child.");
      continue;
    }
    if (item.name === "via") {
      const layers = exactLayerSet(item, layerNames);
      if (layerFields.length > 0 || layers.length !== 2 || layers[0] !== "F.Cu" || layers[1] !== "B.Cu") {
        fail("UNSUPPORTED_PCB", "Two-layer V1 supports only an exact F.Cu-to-B.Cu via layer pair.");
      }
      continue;
    }
    if (item.name === "property" && layerFields.length > 0) {
      if (layerSetFields.length !== 0) {
        fail("UNSUPPORTED_PCB", "Single-layer PCB property cannot carry a plural layers child.");
      }
      const layer = exactSingleLayer(item, layerNames);
      if (layer === "F.Cu" || layer === "B.Cu") {
        fail("UNSUPPORTED_PCB", "Copper footprint property text is outside the clearance-evidence V1 object model.");
      }
      continue;
    }
    if (layerFields.length > 0 || layerSetFields.length > 0) {
      fail("UNSUPPORTED_PCB", `PCB form ${item.name} has unsupported or ambiguous layer semantics.`);
    }
  }
};

/** Reuse only the closed source item/layer inventory for V2 reference coverage.
 * Zone geometry, clearance rules and V1 acceptance are deliberately not assessed.
 */
export function assertFreshPlaneReferenceCopperScope(source: string): void {
  const forms = parseSExpressions(Buffer.from(source, "utf8"), "KiCad PCB", "UNSUPPORTED_PCB");
  if (forms.length !== 1 || forms[0]!.name !== "kicad_pcb" || forms[0]!.values.length !== 0) fail("UNSUPPORTED_PCB", "Expected one PCB root for reference copper scope.");
  const root = forms[0]!;
  const version = scalarChild(root, "version");
  if (version === null || !/^\d+$/u.test(version) || !BOARD_VERSIONS.has(Number(version))) fail("UNSUPPORTED_PCB", "Unsupported reference PCB version.");
  const table = oneChild(root, "layers");
  if (table === null) fail("UNSUPPORTED_PCB", "Reference copper scope needs one complete layer table.");
  const layers = declaredLayerNames(table!, Number(version));
  const copper = [...layers].filter(name => name.endsWith(".Cu"));
  if (copper.length !== 2 || copper[0] !== "F.Cu" || copper[1] !== "B.Cu") fail("UNSUPPORTED_PCB", "Reference copper scope supports exact F.Cu/B.Cu layers.");
  assertClosedLayeredItems(root, new Set([...layers, ...KICAD_10_TECHNICAL_ITEM_LAYER_NAMES]), source, "not-evaluated", Number(version));
}

const parsePcbFacts = (bytes: Buffer, requireGeneratorVersion: boolean, zones: "rejected" | "not-evaluated" = "rejected", nativeTerminals?: FreshNativeTerminalBinding): PcbFacts => {
  if(nativeTerminals!==undefined)assertFreshNativeNoConnectPcbIsolation(nativeTerminals,parseFreshPcbSource(bytes.toString("utf8")));
  const forms = parseSExpressions(bytes, "KiCad PCB", "UNSUPPORTED_PCB");
  if (forms.length !== 1 || forms[0]!.name !== "kicad_pcb" || forms[0]!.values.length !== 0) {
    return fail("UNSUPPORTED_PCB", "Expected exactly one kicad_pcb root form.");
  }
  const root = forms[0]!;
  const versionText = scalarChild(root, "version");
  if (versionText === null || !/^\d+$/u.test(versionText)) return fail("UNSUPPORTED_PCB", "PCB file version is missing or malformed.");
  const fileVersion = Number(versionText);
  if (!Number.isSafeInteger(fileVersion) || !BOARD_VERSIONS.has(fileVersion)) {
    return fail("UNSUPPORTED_PCB", `PCB file version ${versionText} is outside the audited KiCad-10 parser set.`);
  }
  const generatorVersions = directChildren(root, "generator_version");
  const generatorVersion = generatorVersions.length === 0 ? null : scalarChild(root, "generator_version");
  if (generatorVersions.length > 1 || (generatorVersions.length === 1 && generatorVersion === null)) {
    return fail("UNSUPPORTED_PCB", "PCB generator version is ambiguous or malformed.");
  }
  if (requireGeneratorVersion && (generatorVersion === null || !/^10\.\d+(?:\.\d+)?$/u.test(generatorVersion))) {
    return fail("UNSUPPORTED_PCB", "Clearance evidence requires a PCB saved by an identified KiCad 10 generator.");
  }
  const layers = oneChild(root, "layers");
  if (layers === null) return fail("UNSUPPORTED_PCB", "PCB must contain exactly one layer table.");
  const layerNames = declaredLayerNames(layers, fileVersion);
  const copperLayers = [...layerNames].filter((name) => name.endsWith(".Cu"));
  if (copperLayers.length !== 2 || copperLayers[0] !== "F.Cu" || copperLayers[1] !== "B.Cu") {
    return fail("UNSUPPORTED_PCB", "Clearance evidence V1 requires exactly F.Cu and B.Cu in that order.");
  }
  if (zones === "rejected" && descendants(root).some((item) => item.name === "zone")) {
    return fail("UNSUPPORTED_PCB", "Copper zones have local clearance semantics and are rejected by clearance evidence V1.");
  }
  for (const item of descendants(root, zones === "not-evaluated")) {
    if ((item.name === "footprint" || item.name === "pad") && directChildren(item, "clearance").length > 0) {
      return fail("UNSUPPORTED_PCB", "Pad or footprint local copper-clearance overrides are rejected by clearance evidence V1.");
    }
  }
  const itemLayerNames = new Set<string>([...layerNames, ...KICAD_10_TECHNICAL_ITEM_LAYER_NAMES]);
  assertClosedLayeredItems(root, itemLayerNames, bytes.toString("utf8"), zones, fileVersion);

  const numericNets = new Map<string, string>();
  const tableNames = new Set<string>();
  for (const entry of directChildren(root, "net")) {
    if (entry.children.length !== 0 || entry.values.length !== 2
        || entry.values[0]!.quoted
        || !isCanonicalUnsignedInteger(entry.values[0]!.value, MAX_KICAD_NET_ID)
        || !entry.values[1]!.quoted) {
      return fail("UNSUPPORTED_PCB", "PCB root net table is malformed.");
    }
    const [ordinal, name] = [entry.values[0]!.value, entry.values[1]!.value];
    if ((ordinal === "0") !== (name === "") || numericNets.has(ordinal) || tableNames.has(name)) {
      return fail("UNSUPPORTED_PCB", "PCB root net table contains a duplicate or conflicting entry.");
    }
    numericNets.set(ordinal, name);
    if (name.length > 0) tableNames.add(name);
  }
  const usedNames = new Set<string>();
  for (const item of descendants(root, zones === "not-evaluated")) {
    if (item.name !== "pad" && item.name !== "segment" && item.name !== "arc" && item.name !== "via") continue;
    const netFields = directChildren(item, "net");
    if (netFields.length > 1 || ((item.name === "segment" || item.name === "arc" || item.name === "via") && netFields.length !== 1)) {
      return fail("UNSUPPORTED_PCB", `PCB ${item.name} has a missing or ambiguous net assignment.`);
    }
    if (netFields.length === 1) {
      const name = netReference(netFields[0]!, numericNets);
      if (name !== null) usedNames.add(name);
    }
  }
  const allNames = [...new Set([...tableNames, ...usedNames])].sort(compareText);
  const noConnectNames=new Set(nativeTerminals?.endpoints.map(endpoint=>endpoint.nativeNetName)??[]);
  if (allNames.some((name) => !isContractNetName(name)&&!noConnectNames.has(name))) {
    return fail("UNSUPPORTED_PCB", "PCB contains a net name outside the closed contract grammar.");
  }
  return Object.freeze({ fileVersion, generatorVersion, netNames: Object.freeze(allNames.filter(name=>!noConnectNames.has(name))) });
};

const defaultNetClass = (): JsonRecord => ({
  bus_width: 12,
  clearance: 0.2,
  diff_pair_gap: 0.25,
  diff_pair_via_gap: 0.25,
  diff_pair_width: 0.2,
  line_style: 0,
  microvia_diameter: 0.3,
  microvia_drill: 0.1,
  name: "Default",
  pcb_color: "rgba(0, 0, 0, 0.000)",
  priority: 2_147_483_647,
  schematic_color: "rgba(0, 0, 0, 0.000)",
  track_width: 0.2,
  tuning_profile: "",
  via_diameter: 0.6,
  via_drill: 0.3,
  wire_width: 6,
});

const generatedNetClass = (
  binding: FreshClearanceNetClassBinding,
  contract: FreshNetClassSourceContract,
): FreshNetClassSemanticDefinition => {
  const boundedVia = contract.routingConstraints.viaPolicy.mode === "bounded"
    ? contract.routingConstraints.viaPolicy
    : null;
  return {
    bus_width: 12,
    clearance: binding.configuredClearanceMm,
    diff_pair_gap: 0.25,
    diff_pair_via_gap: 0.25,
    diff_pair_width: binding.traceWidthMm,
    line_style: 0,
    microvia_diameter: 0.3,
    microvia_drill: 0.1,
    name: binding.kicadNetClassName,
    pcb_color: "rgba(0, 0, 0, 0.000)",
    priority: -1,
    schematic_color: "rgba(0, 0, 0, 0.000)",
    track_width: binding.traceWidthMm,
    tuning_profile: "",
    via_diameter: boundedVia?.diameterMm ?? 0.6,
    via_drill: boundedVia?.drillMm ?? 0.3,
    wire_width: 6,
  };
};

const assertNetSettingsMetaV5 = (
  value: unknown,
  code: FreshClearanceEvidenceErrorCode,
): void => {
  const meta = record(value, "KiCad net_settings.meta", code);
  if (Object.keys(meta).length !== 1 || !Object.hasOwn(meta, "version") || meta.version !== 5) {
    fail(code, "KiCad net_settings.meta must be the exact audited { version: 5 } schema marker.");
  }
};

const authoredPatternsForBindings = (bindings: readonly FreshClearanceNetClassBinding[]) =>
  createExactContractNetClassPatterns(bindings.flatMap((binding) =>
    binding.netNames.map((netName) => ({ netName, kicadNetClassName: binding.kicadNetClassName }))));

const assertAuthoredAssignmentSources = (
  netSettings: JsonRecord,
  bindings: readonly FreshClearanceNetClassBinding[],
): void => {
  try {
    assertExactContractNetClassPatterns(netSettings.netclass_patterns, authoredPatternsForBindings(bindings));
    assertEmptyDerivedNetClassAssignments(netSettings.netclass_assignments);
  } catch (error) {
    fail("AMBIGUOUS_RULES", "KiCad authored netclass patterns or derived label assignments differ from the closed contract model.", error);
  }
};

const preparedProjectSettings = (
  source: JsonRecord,
  project: FreshProject,
  bundle: FreshNetClassSourceBundle,
  bindings: readonly FreshClearanceNetClassBinding[],
): JsonRecord => {
  const root = record(cloneJson(source), "KiCad project settings", "INVALID_PROJECT_JSON");
  const board = record(root.board, "KiCad project board section", "INVALID_PROJECT_JSON");
  if (board.file !== `${project.name}.kicad_pcb`) {
    return fail("INVALID_PROJECT_JSON", "KiCad project board file must be the exact project-local PCB basename.");
  }
  let designSettings: JsonRecord;
  if (board.design_settings === undefined) {
    designSettings = Object.create(null) as JsonRecord;
    board.design_settings = designSettings;
  } else designSettings = record(board.design_settings, "KiCad board design settings", "INVALID_PROJECT_JSON");
  let boardRules: JsonRecord;
  if (designSettings.rules === undefined) {
    boardRules = Object.create(null) as JsonRecord;
    designSettings.rules = boardRules;
  } else boardRules = record(designSettings.rules, "KiCad board rules", "INVALID_PROJECT_JSON");
  if (boardRules.min_clearance === undefined) boardRules.min_clearance = 0;
  else boundedMillimetres(boardRules.min_clearance, "Board minimum clearance", 0, 10, "INVALID_PROJECT_JSON");

  let netSettings: JsonRecord;
  if (root.net_settings === undefined) {
    netSettings = Object.create(null) as JsonRecord;
    root.net_settings = netSettings;
    netSettings.meta = { version: 5 };
  } else {
    netSettings = record(root.net_settings, "KiCad net settings", "INVALID_PROJECT_JSON");
    assertNetSettingsMetaV5(netSettings.meta, "INVALID_PROJECT_JSON");
  }
  if (netSettings.net_colors === undefined) netSettings.net_colors = null;
  const patterns = netSettings.netclass_patterns;

  let classes: unknown[];
  if (netSettings.classes === undefined) classes = [defaultNetClass()];
  else if (!Array.isArray(netSettings.classes)) return fail("INVALID_PROJECT_JSON", "KiCad net classes must be an array.");
  else classes = netSettings.classes;
  if (classes.length > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectClasses) {
    return fail("INVALID_PROJECT_JSON", "KiCad net-class inventory exceeds its bound.");
  }
  const retained: unknown[] = [];
  const names = new Set<string>();
  let defaultCount = 0;
  const expectedManaged = new Set(bindings.map((binding) => binding.kicadNetClassName));
  for (const [index, candidate] of classes.entries()) {
    const candidateRecord = record(candidate, `KiCad net class ${index + 1}`, "INVALID_PROJECT_JSON");
    const name = candidateRecord.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 256 || names.has(name)) {
      return fail("AMBIGUOUS_RULES", "KiCad net-class names are missing, duplicate, or overlong.");
    }
    names.add(name);
    if (name === "Default") defaultCount += 1;
    if (name.startsWith(MANAGED_NETCLASS_PREFIX)) {
      if (!expectedManaged.has(name)) return fail("SOURCE_DRIFT", "Project contains a managed net class from another bundle identity.");
      continue;
    }
    retained.push(candidateRecord);
  }
  if (defaultCount > 1) return fail("AMBIGUOUS_RULES", "KiCad project contains multiple Default net classes.");
  const hasManagedClasses = [...names].some((name) => name.startsWith(MANAGED_NETCLASS_PREFIX));
  // Re-materialization verifies authored state. In particular, an old cache-only
  // project must never be silently promoted to current authored-rule evidence.
  if (hasManagedClasses) readProjectConfiguration(source, project, bundle, bindings);
  else if (patterns !== undefined && (!Array.isArray(patterns) || patterns.length !== 0)) {
    try { assertExactContractNetClassPatterns(patterns, authoredPatternsForBindings(bindings)); }
    catch (error) { return fail("AMBIGUOUS_RULES", "Existing netclass patterns are not exact authored contract mappings.", error); }
  }
  try { assertEmptyDerivedNetClassAssignments(netSettings.netclass_assignments ?? null); }
  catch (error) { return fail("AMBIGUOUS_RULES", "Derived net-class label assignments are unsupported for this passive-global authoring model.", error); }
  if (defaultCount === 0) retained.unshift(defaultNetClass());
  netSettings.classes = [
    ...retained,
    ...bindings.map((binding) => generatedNetClass(binding, bundle.contract)),
  ];

  netSettings.netclass_patterns = authoredPatternsForBindings(bindings);
  // Preserve native null on replay; the host initially emits an empty object.
  netSettings.netclass_assignments = netSettings.netclass_assignments === null ? null : {};
  return root;
};

const readProjectConfiguration = (
  source: JsonRecord,
  project: FreshProject,
  bundle: FreshNetClassSourceBundle,
  bindings: readonly FreshClearanceNetClassBinding[],
): ProjectReadback => {
  const board = record(source.board, "KiCad project board section", "INVALID_PROJECT_JSON");
  if (board.file !== `${project.name}.kicad_pcb`) return fail("INVALID_PROJECT_JSON", "KiCad project points at another PCB basename.");
  const design = record(board.design_settings, "KiCad board design settings", "INVALID_PROJECT_JSON");
  const rules = record(design.rules, "KiCad board rules", "INVALID_PROJECT_JSON");
  const boardMinimumClearanceMm = boundedMillimetres(rules.min_clearance, "Board minimum clearance", 0, 10, "INVALID_PROJECT_JSON");
  const netSettings = record(source.net_settings, "KiCad net settings", "INVALID_PROJECT_JSON");
  assertNetSettingsMetaV5(netSettings.meta, "INVALID_PROJECT_JSON");
  assertAuthoredAssignmentSources(netSettings, bindings);
  if (!Array.isArray(netSettings.classes)
      || netSettings.classes.length > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectClasses) {
    return fail("INVALID_PROJECT_JSON", "KiCad net-class inventory is missing or over its bound.");
  }
  const byName = new Map<string, JsonRecord>();
  for (const [index, candidate] of netSettings.classes.entries()) {
    const classRecord = record(candidate, `KiCad net class ${index + 1}`, "INVALID_PROJECT_JSON");
    const name = classRecord.name;
    if (typeof name !== "string" || name.length === 0 || byName.has(name)) {
      return fail("AMBIGUOUS_RULES", "KiCad net-class names are missing or duplicate.");
    }
    byName.set(name, classRecord);
  }
  for (const binding of bindings) {
    const actual = byName.get(binding.kicadNetClassName);
    const expected = generatedNetClass(binding, bundle.contract);
    if (actual === undefined || !canonicalValuesEqual(actual, expected)) {
      return fail("SOURCE_DRIFT", `Managed KiCad net class for ${binding.contractNetClassId} differs from its bundle-derived definition.`);
    }
  }
  for (const name of byName.keys()) {
    if (name.startsWith(MANAGED_NETCLASS_PREFIX)
        && !bindings.some((binding) => binding.kicadNetClassName === name)) {
      return fail("SOURCE_DRIFT", "KiCad project contains an unbound managed net class.");
    }
  }
  return Object.freeze({ boardMinimumClearanceMm, netClasses: bindings });
};

const writeTemporary = async (target: string, bytes: Buffer, mode: number): Promise<string> => {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    return temporary;
  } catch (error) {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await unlink(temporary); } catch { /* best effort */ }
    return fail("ATOMIC_WRITE_FAILED", "Could not stage the KiCad project-settings replacement.", error);
  }
};

const atomicReplace = async (
  target: string,
  expected: CapturedFile,
  replacement: Buffer,
): Promise<void> => {
  const temporary = await writeTemporary(target, replacement, expected.mode);
  try {
    const current = await captureRequired(target, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes, "KiCad project settings");
    if (!contentIdentitiesEqual(current.identity, expected.identity)) {
      return fail("SOURCE_DRIFT", "KiCad project settings changed before atomic replacement.");
    }
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best effort */ }
    if (error instanceof FreshClearanceEvidenceError) throw error;
    return fail("ATOMIC_WRITE_FAILED", "Atomic KiCad project-settings replacement failed.", error);
  }
};

const rollbackProjectSettings = async (
  target: string,
  committedIdentity: ContentIdentity,
  preimage: CapturedFile,
): Promise<void> => {
  let current: CapturedFile;
  try {
    current = await captureRequired(target, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes, "Committed KiCad project settings");
  } catch (error) {
    return fail("ATOMIC_ROLLBACK_FAILED", "Committed project settings could not be inspected for rollback.", error);
  }
  if (!contentIdentitiesEqual(current.identity, committedIdentity)) {
    return fail("ATOMIC_ROLLBACK_FAILED", "Refusing rollback because project settings changed after this transaction committed.");
  }
  const temporary = await writeTemporary(target, preimage.bytes, preimage.mode);
  try { await rename(temporary, target); }
  catch (error) {
    try { await unlink(temporary); } catch { /* best effort */ }
    return fail("ATOMIC_ROLLBACK_FAILED", "Exact project-settings preimage rollback failed.", error);
  }
  const restored = await captureRequired(target, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes, "Restored KiCad project settings");
  if (!contentIdentitiesEqual(restored.identity, preimage.identity)) {
    return fail("ATOMIC_ROLLBACK_FAILED", "Project-settings rollback did not restore the exact preimage bytes.");
  }
};

const withMaterializationLock = async <Value>(paths: SourcePaths, operation: () => Promise<Value>): Promise<Value> => {
  let handle;
  try { handle = await open(paths.lock, "wx", 0o600); }
  catch (error) { return fail("ATOMIC_WRITE_FAILED", "Another clearance materialization is active or left an unresolved lock.", error); }
  const lockIdentity = await handle.stat({ bigint: true });
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    try { await handle.close(); } catch { /* best effort */ }
    try {
      const current = await lstat(paths.lock, { bigint: true });
      if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await unlink(paths.lock);
    } catch { /* a missing/replaced lock is deliberately not removed */ }
  }
};

/** Deterministic rollback probe used only by the focused Vitest process. */
const injectPostCommitTestFault = (): void => {
  const fault = process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT;
  if (fault === undefined) return;
  if (process.env.NODE_ENV !== "test" || fault !== "throw") {
    fail("INVALID_INPUT", "Invalid or non-test fresh-clearance fault-injection request.");
  }
  fail("SOURCE_DRIFT", "Injected post-commit verification fault.");
};

/** Deterministic final-capture race probe used only by the focused Vitest process. */
const injectPreReceiptTestFault = async (paths: SourcePaths): Promise<void> => {
  const fault = process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT;
  if (fault === undefined) return;
  if (process.env.NODE_ENV !== "test" || fault !== "append-project-byte") {
    fail("INVALID_INPUT", "Invalid or non-test fresh-clearance pre-receipt fault-injection request.");
  }
  try {
    await appendFile(paths.projectSettings, "\n", "utf8");
  } catch (error) {
    fail("SOURCE_DRIFT", "Could not inject the deterministic pre-receipt source drift.", error);
  }
};

const assertGeneratorMatchesKicad = (generatorVersion: string | null, kicad: FreshClearanceKicadIdentity): void => {
  if (generatorVersion === null) return fail("UNSUPPORTED_PCB", "PCB generator version is missing.");
  const exactSeries = kicad.version.split(".").slice(0, 2).join(".");
  if (generatorVersion !== exactSeries && generatorVersion !== kicad.version) {
    fail("SOURCE_DRIFT", `PCB generator ${generatorVersion} does not match identified KiCad series ${exactSeries}.`);
  }
};

const assertExactPcbNets = (facts: PcbFacts, contract: PcbDesignContract): void => {
  const expected = contract.nets.map((net) => net.name).sort(compareText);
  if (facts.netNames.length !== expected.length
      || facts.netNames.some((entry, index) => entry !== expected[index])) {
    fail(
      "UNASSIGNED_NET",
      `PCB net inventory must exactly match the contract; expected ${expected.join(", ") || "<none>"}, observed ${facts.netNames.join(", ") || "<none>"}.`,
    );
  }
};

const CLEARANCE_RULE_RESOLUTION = deepFreeze({
  boardMinimum: "absolute-floor" as const,
  netClassConflict: "larger-clearance" as const,
  customRules: "absent-or-empty-only" as const,
  localPadOrFootprintOverrides: "rejected" as const,
  zones: "rejected" as const,
  ...FRESH_NETCLASS_ASSIGNMENT_MODEL,
});

const CLEARANCE_EVIDENCE_LIMITATIONS = deepFreeze([
  "This is configuration/readback evidence, not a DRC result or geometry clearance measurement.",
  "Custom rules, zones, copper graphics, and pad/footprint local clearance overrides are rejected by the bounded model.",
  "Assignments are host-generated escaped anchored exact-contract-name patterns; the schematic-derived label cache must be empty (object or null). Exact net inventory is required because KiCad also applies an anchored wildcard matcher.",
  "KiCad 10.0.3 kicad-cli exposes no net-class or constraint-resolution inspection command; exact value evidence is source-readback, while the opt-in native fixture proves KiCad accepts those project bytes.",
  "KiCad executable identity is host-observed and path-free in this receipt; the caller must obtain it from the probed KiCad adapter.",
]);

const sourceRuleIdentity = (
  sources: CapturedSources,
  kicad: FreshClearanceKicadIdentity,
): CanonicalIdentity => {
  const payload = {
    schemaVersion: FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
    projectSettings: sources.projectSettings.identity,
    customRules: sources.customRules?.identity ?? null,
    pcb: sources.pcb.identity,
    kicad,
    resolution: CLEARANCE_RULE_RESOLUTION,
  };
  return canonicalIdentity(payload, FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION);
};

const pairEvidence = (
  contract: PcbDesignContract,
  boardMinimum: number,
): readonly FreshClearancePairEvidence[] => {
  const classes = new Map(contract.netClasses.map((entry) => [entry.id, entry]));
  const nets = [...contract.nets].sort((left, right) => compareText(left.name, right.name));
  const result: FreshClearancePairEvidence[] = [];
  for (let leftIndex = 0; leftIndex < nets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nets.length; rightIndex += 1) {
      const left = nets[leftIndex]!;
      const right = nets[rightIndex]!;
      const leftClearance = classes.get(left.netClassId)!.clearanceMm;
      const rightClearance = classes.get(right.netClassId)!.clearanceMm;
      const effective = Math.max(boardMinimum, leftClearance, rightClearance);
      const sources = [
        ...(Math.abs(boardMinimum - effective) <= NUMERIC_EPSILON ? ["board.design_settings.rules.min_clearance"] : []),
        ...(Math.abs(leftClearance - effective) <= NUMERIC_EPSILON ? [`netclass:${left.netClassId}`] : []),
        ...(Math.abs(rightClearance - effective) <= NUMERIC_EPSILON ? [`netclass:${right.netClassId}`] : []),
      ];
      result.push({
        leftNet: left.name,
        rightNet: right.name,
        effectiveClearanceMm: effective,
        limitingSources: [...new Set(sources)].sort(compareText),
      });
    }
  }
  return deepFreeze(result);
};

const buildEvidenceReceipt = (
  project: FreshProject,
  bundle: PcbDesignCompilationBundle,
  kicad: FreshClearanceKicadIdentity,
  sources: CapturedSources,
  configured: ProjectReadback,
): FreshClearanceEvidenceReceipt => {
  const pairs = pairEvidence(bundle.contract, configured.boardMinimumClearanceMm);
  const pairByNet = new Map<string, number[]>();
  for (const pair of pairs) {
    const left = pairByNet.get(pair.leftNet) ?? [];
    left.push(pair.effectiveClearanceMm);
    pairByNet.set(pair.leftNet, left);
    const right = pairByNet.get(pair.rightNet) ?? [];
    right.push(pair.effectiveClearanceMm);
    pairByNet.set(pair.rightNet, right);
  }
  const bindingById = new Map(configured.netClasses.map((entry) => [entry.contractNetClassId, entry]));
  const nets = [...bundle.contract.nets]
    .sort((left, right) => compareText(left.name, right.name))
    .map((net): FreshClearanceNetEvidence => {
      const binding = bindingById.get(net.netClassId)!;
      const pairValues = pairByNet.get(net.name) ?? [];
      return {
        name: net.name,
        contractNetClassId: net.netClassId,
        kicadNetClassName: binding.kicadNetClassName,
        configuredClearanceMm: binding.configuredClearanceMm,
        effectiveClearanceMm: pairValues.length === 0
          ? Math.max(configured.boardMinimumClearanceMm, binding.configuredClearanceMm)
          : Math.min(...pairValues),
      };
    });
  const ruleSourceSet = sourceRuleIdentity(sources, kicad);
  const acceptanceEvidence: FreshDesignClearanceEvidence = {
    origin: "host",
    schemaVersion: FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
    source: "kicad-effective-netclass-rules",
    pcbSha256: sources.pcb.identity.digest,
    rulesSourceSha256: ruleSourceSet.digest,
    netClasses: configured.netClasses.map((binding) => {
      const classNets = nets.filter((net) => net.contractNetClassId === binding.contractNetClassId);
      return {
        id: binding.contractNetClassId,
        configuredClearanceMm: binding.configuredClearanceMm,
        effectiveClearanceMm: Math.min(...classNets.map((net) => net.effectiveClearanceMm)),
      };
    }),
  };
  const payload = {
    schemaVersion: FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    classification: "candidate-validation" as const,
    origin: "host" as const,
    fabricationAuthorized: false as const,
    qualificationEstablished: false as const,
    releaseAuthorized: false as const,
    bundleIdentity: bundle.identity,
    contractIdentity: bundle.contract.identity,
    genericProjectBindingIdentity: project.genericBinding!.identity,
    freshMarkerContentIdentity: sources.marker.identity,
    kicad,
    sourceIdentities: {
      projectSettings: sources.projectSettings.identity,
      customRules: sources.customRules?.identity ?? null,
      pcb: sources.pcb.identity,
      ruleSourceSet,
    },
    ruleResolution: CLEARANCE_RULE_RESOLUTION,
    boardMinimumClearanceMm: configured.boardMinimumClearanceMm,
    netClasses: configured.netClasses,
    nets,
    pairs,
    acceptanceEvidence,
    evidenceLimitations: CLEARANCE_EVIDENCE_LIMITATIONS,
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION),
  });
};

const buildNetClassSemanticAuthority = (
  project: FreshProject,
  bundle: PcbDesignCompilationBundle,
  kicad: FreshClearanceKicadIdentity,
  sources: CapturedSources,
  configured: ProjectReadback,
): FreshNetClassSemanticAuthority => {
  const bindingByClassId = new Map(
    configured.netClasses.map((binding) => [binding.contractNetClassId, binding]),
  );
  const contractNetAssignments = [...bundle.contract.nets]
    .sort((left, right) => compareText(left.name, right.name))
    .map((net): FreshNetClassContractAssignment => ({
      netName: net.name,
      contractNetClassId: net.netClassId,
      kicadNetClassName: bindingByClassId.get(net.netClassId)!.kicadNetClassName,
    }));
  const payload = {
    schemaVersion: FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION,
    classification: "candidate-validation" as const,
    origin: "host" as const,
    fabricationAuthorized: false as const,
    qualificationEstablished: false as const,
    releaseAuthorized: false as const,
    bundleIdentity: bundle.identity,
    contractIdentity: bundle.contract.identity,
    genericProjectBindingIdentity: project.genericBinding!.identity,
    freshMarkerContentIdentity: sources.marker.identity,
    kicad,
    ruleResolution: {
      boardMinimum: "absolute-floor" as const,
      netClassConflict: "larger-clearance" as const,
      customRules: "absent-or-empty-only" as const,
      localPadOrFootprintOverrides: "rejected" as const,
      zones: "rejected" as const,
      ...FRESH_NETCLASS_ASSIGNMENT_MODEL,
    },
    boardMinimumClearanceMm: configured.boardMinimumClearanceMm,
    netClasses: configured.netClasses.map((binding) => generatedNetClass(binding, bundle.contract)),
    contractNetAssignments,
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION),
  });
};

/**
 * Deterministically inserts bundle-owned net classes and exact per-net direct
 * assignments into the marker-owned project settings.  All unrelated JSON
 * member values, classes, and non-contract assignments are preserved.
 */
async function materializeNetClassSources<Result>(
  options: SharedNetClassOperationOptions,
  build: (facts: Readonly<{ changed: boolean; kicad: FreshClearanceKicadIdentity; before: CapturedSources; after: CapturedSources; bindings: readonly FreshClearanceNetClassBinding[] }>) => Result,
): Promise<Result> {
  const paths = await commonSourcePaths(options.project);
  const kicad = normalizedKicadIdentity(options.kicad);
  validateTwoLayerContract(options.compilationBundle.contract);
  const bindings = classBindings(options.compilationBundle);
  return withMaterializationLock(paths, async () => {
    const before = await captureSourceSet(paths);
    await options.authenticateMarker(before.marker.bytes);
    (options.validateCustomRules ?? parseCustomRuleSource)(before.customRules);
    const beforeNativeTerminals=await options.qualifyNativeTerminals?.(before.pcb.bytes.toString("utf8"));
    parsePcbFacts(before.pcb.bytes, false, options.zones,beforeNativeTerminals);
    const projectJson = strictProjectJson(before.projectSettings.bytes);
    options.assertProjectSettings?.(projectJson);
    const nextProject = preparedProjectSettings(projectJson, options.project, options.compilationBundle, bindings);
    options.assertProjectSettings?.(nextProject);
    // A native save may reorder JSON object members without changing any
    // setting. Keep an already-correct authored source byte-for-byte intact.
    // The normal configuration, source and native-terminal checks still run.
    const nextBytes = canonicalValuesEqual(projectJson, nextProject) ? before.projectSettings.bytes
      : Buffer.from(`${JSON.stringify(nextProject, null, 2)}\n`, "utf8");
    if (nextBytes.byteLength > FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes) {
      return fail("INVALID_PROJECT_JSON", "Materialized KiCad project settings exceed the source-size bound.");
    }
    const nextIdentity = contentIdentity(nextBytes);
    const changed = !contentIdentitiesEqual(before.projectSettings.identity, nextIdentity);
    if (changed) {
      await atomicReplace(paths.projectSettings, before.projectSettings, nextBytes);
      try {
        injectPostCommitTestFault();
        const committed = await captureRequired(paths.projectSettings, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes, "Materialized KiCad project settings");
        if (!contentIdentitiesEqual(committed.identity, nextIdentity)) {
          return fail("ATOMIC_WRITE_FAILED", "Materialized project settings do not match the staged bytes.");
        }
        readProjectConfiguration(strictProjectJson(committed.bytes), options.project, options.compilationBundle, bindings);
        const unchanged = await captureSourceSet(paths);
        if (!contentIdentitiesEqual(unchanged.pcb.identity, before.pcb.identity)
            || !contentIdentitiesEqual(unchanged.marker.identity, before.marker.identity)
            || !sameOptionalCapture(unchanged.customRules, before.customRules)) {
          return fail("SOURCE_DRIFT", "A bound non-project source changed during net-class materialization.");
        }
      } catch (error) {
        try { await rollbackProjectSettings(paths.projectSettings, nextIdentity, before.projectSettings); }
        catch (rollbackError) {
          if (rollbackError instanceof FreshClearanceEvidenceError && rollbackError.code === "ATOMIC_ROLLBACK_FAILED") throw rollbackError;
          return fail("ATOMIC_ROLLBACK_FAILED", "Project-settings preimage rollback failed.", rollbackError);
        }
        throw error;
      }
    } else {
      readProjectConfiguration(projectJson, options.project, options.compilationBundle, bindings);
    }
    await injectPreReceiptTestFault(paths);
    const after = await captureSourceSet(paths);
    const expectedProjectIdentity = changed ? nextIdentity : before.projectSettings.identity;
    if (!contentIdentitiesEqual(after.projectSettings.identity, expectedProjectIdentity)
        || !contentIdentitiesEqual(after.pcb.identity, before.pcb.identity)
        || !contentIdentitiesEqual(after.marker.identity, before.marker.identity)
        || !sameOptionalCapture(after.customRules, before.customRules)) {
      return fail("SOURCE_DRIFT", "A materialization source changed before the final receipt snapshot.");
    }
    await options.authenticateMarker(after.marker.bytes);
    (options.validateCustomRules ?? parseCustomRuleSource)(after.customRules);
    options.assertProjectSettings?.(strictProjectJson(after.projectSettings.bytes));
    const afterNativeTerminals=await options.qualifyNativeTerminals?.(after.pcb.bytes.toString("utf8"));
    parsePcbFacts(after.pcb.bytes, false, options.zones,afterNativeTerminals);
    readProjectConfiguration(
      strictProjectJson(after.projectSettings.bytes),
      options.project,
      options.compilationBundle,
      bindings,
    );
    await options.assertNativeTerminalSourcesCurrent?.();
    return build({ changed, kicad, before, after, bindings });
  });
}

export async function materializeFreshNetClasses(
  options: FreshClearanceOperationOptions,
): Promise<FreshNetClassMaterialization> {
  await sourcePaths(options.project);
  return materializeNetClassSources({ ...options, zones: "rejected",
    authenticateMarker: bytes => validateMarkerBinding(bytes, options.project, options.compilationBundle) }, ({ changed, kicad, before, after, bindings }) => {
    const payload = {
      schemaVersion: FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION,
      assignmentModel: FRESH_NETCLASS_ASSIGNMENT_MODEL,
      classification: "candidate-validation" as const,
      origin: "host" as const,
      fabricationAuthorized: false as const,
      qualificationEstablished: false as const,
      releaseAuthorized: false as const,
      changed,
      bundleIdentity: options.compilationBundle.identity,
      contractIdentity: options.compilationBundle.contract.identity,
      genericProjectBindingIdentity: options.project.genericBinding!.identity,
      freshMarkerContentIdentity: after.marker.identity,
      kicad,
      preimageProjectSettingsIdentity: before.projectSettings.identity,
      projectSettingsIdentity: after.projectSettings.identity,
      pcbIdentityAtMaterialization: after.pcb.identity,
      customRulesIdentity: after.customRules?.identity ?? null,
      netClasses: bindings,
    };
    return deepFreeze({
      ...payload,
      identity: canonicalIdentity(payload, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION),
    });
  });
}

/**
 * Re-read the complete materialized net-class semantics before authoring. The
 * PCB grammar is still audited for disallowed rule sources, but a final PCB
 * net inventory is deliberately not required and is not included in the
 * resulting stable identity.
 */
async function readNetClassSources(options: SharedNetClassOperationOptions) {
  const paths = await commonSourcePaths(options.project);
  const kicad = normalizedKicadIdentity(options.kicad);
  validateTwoLayerContract(options.compilationBundle.contract);
  const bindings = classBindings(options.compilationBundle);
  const first = await captureSourceSet(paths);
  await options.authenticateMarker(first.marker.bytes);
  (options.validateCustomRules ?? parseCustomRuleSource)(first.customRules);
  options.assertProjectSettings?.(strictProjectJson(first.projectSettings.bytes));
  const nativeTerminals=await options.qualifyNativeTerminals?.(first.pcb.bytes.toString("utf8"));
  const pcb = parsePcbFacts(first.pcb.bytes, false, options.zones,nativeTerminals);
  if (pcb.generatorVersion !== null) assertGeneratorMatchesKicad(pcb.generatorVersion, kicad);
  const configured = readProjectConfiguration(
    strictProjectJson(first.projectSettings.bytes),
    options.project,
    options.compilationBundle,
    bindings,
  );
  const second = await captureSourceSet(paths);
  if (!sourceSetsEqual(first, second)) {
    return fail("SOURCE_DRIFT", "Net-class semantic authority sources changed during readback.");
  }
  await options.assertNativeTerminalSourcesCurrent?.();
  const bindingByClassId = new Map(bindings.map(binding => [binding.contractNetClassId, binding]));
  const contractNetAssignments: FreshNetClassContractAssignment[] = [...options.compilationBundle.contract.nets]
    .sort((left, right) => compareText(left.name, right.name))
    .map(net => ({ netName: net.name, contractNetClassId: net.netClassId, kicadNetClassName: bindingByClassId.get(net.netClassId)!.kicadNetClassName }));
  return { kicad, sources: first, configured, netClasses: bindings.map(binding => generatedNetClass(binding, options.compilationBundle.contract)), contractNetAssignments };
}

export async function readFreshNetClassSemanticAuthority(
  options: FreshClearanceOperationOptions,
): Promise<FreshNetClassSemanticAuthority> {
  await sourcePaths(options.project);
  const result = await readNetClassSources({ ...options, zones: "rejected",
    authenticateMarker: bytes => validateMarkerBinding(bytes, options.project, options.compilationBundle) });
  return buildNetClassSemanticAuthority(options.project, options.compilationBundle, result.kicad, result.sources, result.configured);
}

/** Re-read all supported KiCad rule sources and derive pairwise/net effective clearance. */
export async function readFreshClearanceEvidence(
  options: FreshClearanceOperationOptions,
): Promise<FreshClearanceEvidenceReceipt> {
  const paths = await sourcePaths(options.project);
  const kicad = normalizedKicadIdentity(options.kicad);
  validateTwoLayerContract(options.compilationBundle.contract);
  const bindings = classBindings(options.compilationBundle);
  const first = await captureSourceSet(paths);
  await validateMarkerBinding(first.marker.bytes, options.project, options.compilationBundle);
  parseCustomRuleSource(first.customRules);
  const pcb = parsePcbFacts(first.pcb.bytes, true);
  assertGeneratorMatchesKicad(pcb.generatorVersion, kicad);
  assertExactPcbNets(pcb, options.compilationBundle.contract);
  const configured = readProjectConfiguration(
    strictProjectJson(first.projectSettings.bytes),
    options.project,
    options.compilationBundle,
    bindings,
  );
  const second = await captureSourceSet(paths);
  if (!sourceSetsEqual(first, second)) return fail("SOURCE_DRIFT", "Clearance rule sources changed during readback.");
  return buildEvidenceReceipt(options.project, options.compilationBundle, kicad, first, configured);
}

/** Convenience call for the normal post-PCB integration point. */
export async function materializeAndReadFreshClearanceEvidence(
  options: FreshClearanceOperationOptions,
): Promise<Readonly<{
  readonly materialization: FreshNetClassMaterialization;
  readonly evidence: FreshClearanceEvidenceReceipt;
}>> {
  const materialization = await materializeFreshNetClasses(options);
  const evidence = await readFreshClearanceEvidence(options);
  return deepFreeze({ materialization, evidence });
}

const KICAD_AUTHORITY_KEYS = [
  "kind",
  "version",
  "commit",
  "sha256",
  "sizeBytes",
  "capabilityHelpSha256",
  "confirmedCapabilities",
] as const;

const SEMANTIC_NET_CLASS_KEYS = [
  "bus_width",
  "clearance",
  "diff_pair_gap",
  "diff_pair_via_gap",
  "diff_pair_width",
  "line_style",
  "microvia_diameter",
  "microvia_drill",
  "name",
  "pcb_color",
  "priority",
  "schematic_color",
  "track_width",
  "tuning_profile",
  "via_diameter",
  "via_drill",
  "wire_width",
] as const;

const SEMANTIC_AUTHORITY_KEYS = [
  "schemaVersion",
  "classification",
  "origin",
  "fabricationAuthorized",
  "qualificationEstablished",
  "releaseAuthorized",
  "bundleIdentity",
  "contractIdentity",
  "genericProjectBindingIdentity",
  "freshMarkerContentIdentity",
  "kicad",
  "ruleResolution",
  "boardMinimumClearanceMm",
  "netClasses",
  "contractNetAssignments",
  "identity",
] as const;

const PREPARATION_EVIDENCE_KEYS = [
  "schemaVersion",
  "classification",
  "origin",
  "fabricationAuthorized",
  "qualificationEstablished",
  "releaseAuthorized",
  "bundleIdentity",
  "contractIdentity",
  "genericProjectBindingIdentity",
  "freshMarkerContentIdentity",
  "kicad",
  "materializationIdentity",
  "semanticAuthorityIdentity",
  "identity",
] as const;

const CLEARANCE_EVIDENCE_RECEIPT_KEYS = [
  "schemaVersion",
  "classification",
  "origin",
  "fabricationAuthorized",
  "qualificationEstablished",
  "releaseAuthorized",
  "bundleIdentity",
  "contractIdentity",
  "genericProjectBindingIdentity",
  "freshMarkerContentIdentity",
  "kicad",
  "sourceIdentities",
  "ruleResolution",
  "boardMinimumClearanceMm",
  "netClasses",
  "nets",
  "pairs",
  "acceptanceEvidence",
  "evidenceLimitations",
  "identity",
] as const;

const hardenedArtifact = (value: unknown, label: string): unknown => {
  try {
    return hardenPortableValue(value, {
      maxBytes: 8 * 1024 * 1024,
      maxDepth: 64,
      maxNodes: 100_000,
      maxArrayLength: 20_000,
      maxOwnKeys: 1_024,
      maxKeyBytes: 512,
      maxStringBytes: 512 * 1024,
    });
  } catch (error) {
    return fail("INVALID_INPUT", `${label} is not bounded plain JSON data.`, error);
  }
};

const validateBoundary = (
  value: JsonRecord,
  schemaVersion: string,
  label: string,
): void => {
  if (value.schemaVersion !== schemaVersion
      || value.classification !== "candidate-validation"
      || value.origin !== "host"
      || value.fabricationAuthorized !== false
      || value.qualificationEstablished !== false
      || value.releaseAuthorized !== false) {
    fail("INVALID_INPUT", `${label} has an invalid schema or candidate-only authority boundary.`);
  }
};

const validatePathFreeKicadAuthority = (
  value: unknown,
  label: string,
): FreshClearanceKicadIdentity => {
  const kicad = record(value, label, "INVALID_INPUT");
  exactKeys(kicad, KICAD_AUTHORITY_KEYS, label);
  let normalized: FreshClearanceKicadIdentity;
  try {
    normalized = normalizedKicadIdentity(kicad as unknown as KicadExecutableIdentity);
  } catch (error) {
    return fail("INVALID_INPUT", `${label} is not a valid path-free KiCad authority.`, error);
  }
  if (!canonicalValuesEqual(kicad, normalized)) {
    return fail("INVALID_INPUT", `${label} is not the exact path-free normalized KiCad authority.`);
  }
  return normalized;
};

const validateClearanceRuleResolution = (
  value: unknown,
  label: string,
): typeof CLEARANCE_RULE_RESOLUTION => {
  const resolution = record(value, label, "INVALID_INPUT");
  exactKeys(resolution, [
    "boardMinimum",
    "netClassConflict",
    "customRules",
    "localPadOrFootprintOverrides",
    "zones",
    "netClassPatterns",
    "derivedLabelAssignments",
    "contractNetAssignments",
  ], label);
  if (!canonicalValuesEqual(resolution, CLEARANCE_RULE_RESOLUTION)) {
    return fail("INVALID_INPUT", `${label} has an unsupported clearance-resolution model.`);
  }
  return resolution as unknown as typeof CLEARANCE_RULE_RESOLUTION;
};

const validateClearanceNetClassBindings = (
  value: unknown,
  label: string,
  bundleIdentity: CanonicalIdentity,
): readonly FreshClearanceNetClassBinding[] => {
  if (!Array.isArray(value)
      || value.length === 0
      || value.length > PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses) {
    return fail("INVALID_INPUT", `${label} has an invalid class-binding inventory.`);
  }
  let previousClassId: string | null = null;
  const classNames = new Set<string>();
  const assignedNets = new Set<string>();
  for (const [index, child] of value.entries()) {
    const bindingLabel = `${label}[${index}]`;
    const binding = record(child, bindingLabel, "INVALID_INPUT");
    exactKeys(binding, ["contractNetClassId", "kicadNetClassName", "traceWidthMm", "configuredClearanceMm", "netNames"], bindingLabel);
    boundedMillimetres(binding.traceWidthMm, `${bindingLabel}.traceWidthMm`, 0.05, 20);
    boundedMillimetres(binding.configuredClearanceMm, `${bindingLabel}.configuredClearanceMm`, 0.05, 10);
    const expectedManagedName = `${MANAGED_NETCLASS_PREFIX}${bundleIdentity.digest.slice(0, 12)}_C${String(index + 1).padStart(2, "0")}`;
    if (typeof binding.contractNetClassId !== "string" || !CONTRACT_IDENTIFIER.test(binding.contractNetClassId)
        || binding.kicadNetClassName !== expectedManagedName
        || classNames.has(binding.kicadNetClassName)
        || (previousClassId !== null && compareText(previousClassId, binding.contractNetClassId) >= 0)
        || !Array.isArray(binding.netNames)) {
      return fail("INVALID_INPUT", `${label} bindings are malformed, duplicated, or unsorted.`);
    }
    let previousNet: string | null = null;
    for (const netName of binding.netNames) {
      if (typeof netName !== "string" || !isContractNetName(netName)
          || assignedNets.has(netName)
          || (previousNet !== null && compareText(previousNet, netName) >= 0)) {
        return fail("INVALID_INPUT", `${label} net names must be globally unique and class-locally sorted.`);
      }
      assignedNets.add(netName);
      previousNet = netName;
    }
    previousClassId = binding.contractNetClassId;
    classNames.add(binding.kicadNetClassName);
  }
  if (assignedNets.size === 0 || assignedNets.size > PCB_DESIGN_CONTRACT_LIMITS.maxNets) {
    return fail("INVALID_INPUT", `${label} must bind between 1 and ${PCB_DESIGN_CONTRACT_LIMITS.maxNets} contract nets.`);
  }
  return value as unknown as readonly FreshClearanceNetClassBinding[];
};

const validateSemanticNetClass = (
  value: unknown,
  label: string,
): FreshNetClassSemanticDefinition => {
  const netClass = record(value, label, "INVALID_INPUT");
  exactKeys(netClass, SEMANTIC_NET_CLASS_KEYS, label);
  boundedMillimetres(netClass.clearance, `${label}.clearance`, 0.05, 10);
  boundedMillimetres(netClass.diff_pair_width, `${label}.diff_pair_width`, 0.05, 20);
  boundedMillimetres(netClass.track_width, `${label}.track_width`, 0.05, 20);
  const viaDiameter = boundedMillimetres(netClass.via_diameter, `${label}.via_diameter`, 0.2, 3);
  const viaDrill = boundedMillimetres(netClass.via_drill, `${label}.via_drill`, 0.1, 2);
  if (netClass.bus_width !== 12
      || netClass.diff_pair_gap !== 0.25
      || netClass.diff_pair_via_gap !== 0.25
      || netClass.line_style !== 0
      || netClass.microvia_diameter !== 0.3
      || netClass.microvia_drill !== 0.1
      || netClass.priority !== -1
      || netClass.wire_width !== 6
      || netClass.diff_pair_width !== netClass.track_width
      || viaDrill >= viaDiameter
      || typeof netClass.name !== "string" || !/^EVLEDA_[a-f0-9]{12}_C\d{2,3}$/u.test(netClass.name)
      || netClass.pcb_color !== "rgba(0, 0, 0, 0.000)"
      || netClass.schematic_color !== "rgba(0, 0, 0, 0.000)"
      || netClass.tuning_profile !== "") {
    return fail("INVALID_INPUT", `${label} is not a complete generated KiCad-10 managed class definition.`);
  }
  return netClass as unknown as FreshNetClassSemanticDefinition;
};

const semanticAuthorityBindingProjection = (
  definitions: readonly FreshNetClassSemanticDefinition[],
  assignments: readonly FreshNetClassContractAssignment[],
): readonly FreshClearanceNetClassBinding[] => {
  const contractClassToManagedName = new Map<string, string>();
  const assignmentsByManagedName = new Map<string, FreshNetClassContractAssignment[]>(
    definitions.map((definition) => [definition.name, []]),
  );
  const contractClassByManagedName = new Map<string, string>();
  for (const assignment of assignments) {
    const classAssignments = assignmentsByManagedName.get(assignment.kicadNetClassName);
    if (classAssignments === undefined) {
      return fail("INVALID_INPUT", `Semantic authority assignment ${assignment.netName} targets no managed class.`);
    }
    const existingContractClass = contractClassByManagedName.get(assignment.kicadNetClassName);
    const existingManagedName = contractClassToManagedName.get(assignment.contractNetClassId);
    if ((existingContractClass !== undefined && existingContractClass !== assignment.contractNetClassId)
        || (existingManagedName !== undefined && existingManagedName !== assignment.kicadNetClassName)) {
      return fail("INVALID_INPUT", "Semantic authority must bijectively map managed classes to contract class IDs.");
    }
    contractClassByManagedName.set(assignment.kicadNetClassName, assignment.contractNetClassId);
    contractClassToManagedName.set(assignment.contractNetClassId, assignment.kicadNetClassName);
    classAssignments.push(assignment);
  }
  if (contractClassByManagedName.size !== definitions.length
      || contractClassToManagedName.size !== definitions.length) {
    return fail("INVALID_INPUT", "Every semantic authority managed class must have one exhaustive contract-class assignment group.");
  }
  let previousContractClassId: string | null = null;
  return definitions.map((definition): FreshClearanceNetClassBinding => {
    const classAssignments = assignmentsByManagedName.get(definition.name)!;
    const contractNetClassId = contractClassByManagedName.get(definition.name);
    if (contractNetClassId === undefined || classAssignments.length === 0) {
      return fail("INVALID_INPUT", `Semantic authority managed class ${definition.name} is unused.`);
    }
    if (previousContractClassId !== null && compareText(previousContractClassId, contractNetClassId) >= 0) {
      return fail("INVALID_INPUT", "Semantic authority contract class IDs must increase strictly in managed-class order.");
    }
    previousContractClassId = contractNetClassId;
    return {
      contractNetClassId,
      kicadNetClassName: definition.name,
      traceWidthMm: definition.track_width,
      configuredClearanceMm: definition.clearance,
      netNames: classAssignments.map((entry) => entry.netName),
    };
  });
};

const validateCanonicalPayloadIdentity = (
  value: JsonRecord,
  schemaVersion: string,
  label: string,
): void => {
  const claimed = validateCanonicalIdentityShape(value.identity, `${label}.identity`, schemaVersion);
  const payload = Object.create(null) as JsonRecord;
  for (const [key, child] of Object.entries(value)) if (key !== "identity") payload[key] = child;
  const expected = canonicalIdentity(payload, schemaVersion);
  if (!canonicalValuesEqual(claimed, expected)) {
    fail("INVALID_INPUT", `${label} identity does not match its exact closed payload.`);
  }
};

const parseFreshNetClassSemanticAuthoritySnapshot = (
  value: unknown,
): FreshNetClassSemanticAuthority => {
  const authority = record(hardenedArtifact(value, "Fresh net-class semantic authority"), "Fresh net-class semantic authority", "INVALID_INPUT");
  exactKeys(authority, SEMANTIC_AUTHORITY_KEYS, "Fresh net-class semantic authority");
  validateBoundary(authority, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, "Fresh net-class semantic authority");
  const bundleIdentity = validateCanonicalIdentityShape(authority.bundleIdentity, "semanticAuthority.bundleIdentity", PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
  validateCanonicalIdentityShape(authority.contractIdentity, "semanticAuthority.contractIdentity", PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
  validateCanonicalIdentityShape(authority.genericProjectBindingIdentity, "semanticAuthority.genericProjectBindingIdentity", GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION);
  validateContentIdentityShape(authority.freshMarkerContentIdentity, "semanticAuthority.freshMarkerContentIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes);
  validatePathFreeKicadAuthority(authority.kicad, "semanticAuthority.kicad");
  const resolution = record(authority.ruleResolution, "semanticAuthority.ruleResolution", "INVALID_INPUT");
  exactKeys(resolution, [
    "boardMinimum",
    "netClassConflict",
    "customRules",
    "localPadOrFootprintOverrides",
    "zones",
    "netClassPatterns",
    "derivedLabelAssignments",
    "contractNetAssignments",
  ], "semanticAuthority.ruleResolution");
  if (resolution.boardMinimum !== "absolute-floor"
      || resolution.netClassConflict !== "larger-clearance"
      || resolution.customRules !== "absent-or-empty-only"
      || resolution.localPadOrFootprintOverrides !== "rejected"
      || resolution.zones !== "rejected"
      || resolution.netClassPatterns !== FRESH_NETCLASS_ASSIGNMENT_MODEL.netClassPatterns
      || resolution.derivedLabelAssignments !== "empty-only"
      || resolution.contractNetAssignments !== "exclusive") {
    return fail("INVALID_INPUT", "Fresh net-class semantic authority has an unsupported rule-resolution model.");
  }
  boundedMillimetres(authority.boardMinimumClearanceMm, "semanticAuthority.boardMinimumClearanceMm", 0, 10);
  if (!Array.isArray(authority.netClasses)
      || authority.netClasses.length === 0
      || authority.netClasses.length > PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses) {
    return fail("INVALID_INPUT", "Fresh net-class semantic authority has an invalid managed-class inventory.");
  }
  const managedNames = new Set<string>();
  const definitions: FreshNetClassSemanticDefinition[] = [];
  for (const [index, value] of authority.netClasses.entries()) {
    const netClass = validateSemanticNetClass(value, `semanticAuthority.netClasses[${index}]`);
    const expectedManagedName = `${MANAGED_NETCLASS_PREFIX}${bundleIdentity.digest.slice(0, 12)}_C${String(index + 1).padStart(2, "0")}`;
    if (netClass.name !== expectedManagedName || managedNames.has(netClass.name)) {
      return fail("INVALID_INPUT", "Fresh net-class semantic authority managed-class names do not match bundle-derived order.");
    }
    managedNames.add(netClass.name);
    definitions.push(netClass);
  }
  if (!Array.isArray(authority.contractNetAssignments)
      || authority.contractNetAssignments.length === 0
      || authority.contractNetAssignments.length > PCB_DESIGN_CONTRACT_LIMITS.maxNets) {
    return fail("INVALID_INPUT", "Fresh net-class semantic authority has an invalid contract-net assignment inventory.");
  }
  let previousNetName: string | null = null;
  const assignments: FreshNetClassContractAssignment[] = [];
  for (const [index, value] of authority.contractNetAssignments.entries()) {
    const assignment = record(value, `semanticAuthority.contractNetAssignments[${index}]`, "INVALID_INPUT");
    exactKeys(assignment, ["netName", "contractNetClassId", "kicadNetClassName"], `semanticAuthority.contractNetAssignments[${index}]`);
    if (typeof assignment.netName !== "string" || !isContractNetName(assignment.netName)
        || typeof assignment.contractNetClassId !== "string" || !CONTRACT_IDENTIFIER.test(assignment.contractNetClassId)
        || typeof assignment.kicadNetClassName !== "string" || !managedNames.has(assignment.kicadNetClassName)
        || (previousNetName !== null && compareText(previousNetName, assignment.netName) >= 0)) {
      return fail("INVALID_INPUT", "Fresh net-class semantic authority assignments must be unique, sorted, and target managed classes.");
    }
    previousNetName = assignment.netName;
    assignments.push(assignment as unknown as FreshNetClassContractAssignment);
  }
  semanticAuthorityBindingProjection(definitions, assignments);
  validateCanonicalPayloadIdentity(authority, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, "Fresh net-class semantic authority");
  return authority as unknown as FreshNetClassSemanticAuthority;
};

const parseFreshNetClassMaterializationSnapshot = (
  value: unknown,
): FreshNetClassMaterialization => {
  const materialization = record(hardenedArtifact(value, "Fresh net-class materialization"), "Fresh net-class materialization", "INVALID_INPUT");
  exactKeys(materialization, [
    "schemaVersion",
    "assignmentModel",
    "classification",
    "origin",
    "fabricationAuthorized",
    "qualificationEstablished",
    "releaseAuthorized",
    "changed",
    "bundleIdentity",
    "contractIdentity",
    "genericProjectBindingIdentity",
    "freshMarkerContentIdentity",
    "kicad",
    "preimageProjectSettingsIdentity",
    "projectSettingsIdentity",
    "pcbIdentityAtMaterialization",
    "customRulesIdentity",
    "netClasses",
    "identity",
  ], "Fresh net-class materialization");
  validateBoundary(materialization, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION, "Fresh net-class materialization");
  if (!canonicalValuesEqual(materialization.assignmentModel, FRESH_NETCLASS_ASSIGNMENT_MODEL)) {
    return fail("INVALID_INPUT", "Fresh net-class materialization has an unsupported authored-assignment model.");
  }
  if (typeof materialization.changed !== "boolean") return fail("INVALID_INPUT", "Fresh net-class materialization changed marker must be boolean.");
  const bundleIdentity = validateCanonicalIdentityShape(materialization.bundleIdentity, "materialization.bundleIdentity", PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
  validateCanonicalIdentityShape(materialization.contractIdentity, "materialization.contractIdentity", PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
  validateCanonicalIdentityShape(materialization.genericProjectBindingIdentity, "materialization.genericProjectBindingIdentity", GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION);
  validateContentIdentityShape(materialization.freshMarkerContentIdentity, "materialization.freshMarkerContentIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes);
  validatePathFreeKicadAuthority(materialization.kicad, "materialization.kicad");
  validateContentIdentityShape(materialization.preimageProjectSettingsIdentity, "materialization.preimageProjectSettingsIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes);
  validateContentIdentityShape(materialization.projectSettingsIdentity, "materialization.projectSettingsIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes);
  validateContentIdentityShape(materialization.pcbIdentityAtMaterialization, "materialization.pcbIdentityAtMaterialization", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumPcbBytes);
  if (materialization.customRulesIdentity !== null) {
    validateContentIdentityShape(materialization.customRulesIdentity, "materialization.customRulesIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumRulesBytes);
  }
  validateClearanceNetClassBindings(materialization.netClasses, "materialization.netClasses", bundleIdentity);
  validateCanonicalPayloadIdentity(materialization, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION, "Fresh net-class materialization");
  return materialization as unknown as FreshNetClassMaterialization;
};

/**
 * Build the neutral path-free bridge only from two self-consistent child
 * artifacts that agree on every common authority and managed assignment.
 */
export function createFreshNetClassPreparationEvidence(
  materializationInput: FreshNetClassMaterialization,
  semanticAuthorityInput: FreshNetClassSemanticAuthority,
): FreshNetClassPreparationEvidence {
  const materialization = parseFreshNetClassMaterializationSnapshot(materializationInput);
  const semanticAuthority = parseFreshNetClassSemanticAuthoritySnapshot(semanticAuthorityInput);
  const commonKeys = [
    "bundleIdentity",
    "contractIdentity",
    "genericProjectBindingIdentity",
    "freshMarkerContentIdentity",
    "kicad",
  ] as const;
  for (const key of commonKeys) {
    if (!canonicalValuesEqual(materialization[key], semanticAuthority[key])) {
      return fail("INVALID_INPUT", `Fresh preparation child artifacts disagree on ${key}.`);
    }
  }
  if (materialization.netClasses.length !== semanticAuthority.netClasses.length) {
    return fail("INVALID_INPUT", "Fresh preparation child artifacts disagree on the managed-class inventory.");
  }
  const semanticByName = new Map(semanticAuthority.netClasses.map((entry) => [entry.name, entry]));
  const expectedAssignments: FreshNetClassContractAssignment[] = [];
  for (const binding of materialization.netClasses) {
    const definition = semanticByName.get(binding.kicadNetClassName);
    if (definition === undefined
        || definition.clearance !== binding.configuredClearanceMm
        || definition.track_width !== binding.traceWidthMm
        || definition.diff_pair_width !== binding.traceWidthMm) {
      return fail("INVALID_INPUT", `Fresh preparation child artifacts disagree on managed class ${binding.contractNetClassId}.`);
    }
    for (const netName of binding.netNames) {
      expectedAssignments.push({
        netName,
        contractNetClassId: binding.contractNetClassId,
        kicadNetClassName: binding.kicadNetClassName,
      });
    }
  }
  expectedAssignments.sort((left, right) => compareText(left.netName, right.netName));
  if (!canonicalValuesEqual(expectedAssignments, semanticAuthority.contractNetAssignments)) {
    return fail("INVALID_INPUT", "Fresh preparation child artifacts disagree on exclusive contract-net assignments.");
  }
  const payload = {
    schemaVersion: FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION,
    classification: "candidate-validation" as const,
    origin: "host" as const,
    fabricationAuthorized: false as const,
    qualificationEstablished: false as const,
    releaseAuthorized: false as const,
    bundleIdentity: semanticAuthority.bundleIdentity,
    contractIdentity: semanticAuthority.contractIdentity,
    genericProjectBindingIdentity: semanticAuthority.genericProjectBindingIdentity,
    freshMarkerContentIdentity: semanticAuthority.freshMarkerContentIdentity,
    kicad: semanticAuthority.kicad,
    materializationIdentity: materialization.identity,
    semanticAuthorityIdentity: semanticAuthority.identity,
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION),
  });
}

/** Parse and independently rederive a closed preparation-evidence identity. */
export function parseFreshNetClassPreparationEvidence(
  evidenceInput: unknown,
): FreshNetClassPreparationEvidence {
  const evidence = record(hardenedArtifact(evidenceInput, "Fresh net-class preparation evidence"), "Fresh net-class preparation evidence", "INVALID_INPUT");
  exactKeys(evidence, PREPARATION_EVIDENCE_KEYS, "Fresh net-class preparation evidence");
  validateBoundary(evidence, FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION, "Fresh net-class preparation evidence");
  validateCanonicalIdentityShape(evidence.bundleIdentity, "preparationEvidence.bundleIdentity", PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
  validateCanonicalIdentityShape(evidence.contractIdentity, "preparationEvidence.contractIdentity", PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
  validateCanonicalIdentityShape(evidence.genericProjectBindingIdentity, "preparationEvidence.genericProjectBindingIdentity", GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION);
  validateContentIdentityShape(evidence.freshMarkerContentIdentity, "preparationEvidence.freshMarkerContentIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes);
  validatePathFreeKicadAuthority(evidence.kicad, "preparationEvidence.kicad");
  validateCanonicalIdentityShape(evidence.materializationIdentity, "preparationEvidence.materializationIdentity", FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
  validateCanonicalIdentityShape(evidence.semanticAuthorityIdentity, "preparationEvidence.semanticAuthorityIdentity", FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
  validateCanonicalPayloadIdentity(evidence, FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION, "Fresh net-class preparation evidence");
  return evidence as unknown as FreshNetClassPreparationEvidence;
}

/**
 * Reject malformed/re-minted authority claims and replay after any semantic
 * source drift by independently deriving the current authority again.
 */
export async function verifyFreshNetClassSemanticAuthority(
  authorityInput: unknown,
  options: FreshClearanceOperationOptions,
): Promise<FreshNetClassSemanticAuthority> {
  const authority = parseFreshNetClassSemanticAuthority(authorityInput);
  const current = await readFreshNetClassSemanticAuthority(options);
  if (!canonicalValuesEqual(authority, current)) {
    return fail("SOURCE_DRIFT", "Fresh net-class semantic authority is stale, replayed, or does not match current semantic sources.");
  }
  return current;
}

/** Purely parse and rederive a closed pre-authoring semantic authority. */
export function parseFreshNetClassSemanticAuthority(
  authorityInput: unknown,
): FreshNetClassSemanticAuthority {
  return parseFreshNetClassSemanticAuthoritySnapshot(authorityInput);
}

/**
 * Purely parse and rederive the complete closed receipt. This proves bounded
 * structural and internal semantic integrity only; source currency remains
 * the responsibility of verifyFreshClearanceEvidenceReceipt.
 */
export function parseFreshClearanceEvidenceReceipt(
  receiptInput: unknown,
): FreshClearanceEvidenceReceipt {
  const receipt = record(
    hardenedArtifact(receiptInput, "Clearance evidence receipt"),
    "Clearance evidence receipt",
    "INVALID_INPUT",
  );
  exactKeys(receipt, CLEARANCE_EVIDENCE_RECEIPT_KEYS, "Clearance evidence receipt");
  validateBoundary(receipt, FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION, "Clearance evidence receipt");
  const bundleIdentity = validateCanonicalIdentityShape(receipt.bundleIdentity, "clearanceReceipt.bundleIdentity", PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
  validateCanonicalIdentityShape(receipt.contractIdentity, "clearanceReceipt.contractIdentity", PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
  validateCanonicalIdentityShape(receipt.genericProjectBindingIdentity, "clearanceReceipt.genericProjectBindingIdentity", GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION);
  validateContentIdentityShape(receipt.freshMarkerContentIdentity, "clearanceReceipt.freshMarkerContentIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes);
  const kicad = validatePathFreeKicadAuthority(receipt.kicad, "clearanceReceipt.kicad");

  const sources = record(receipt.sourceIdentities, "clearanceReceipt.sourceIdentities", "INVALID_INPUT");
  exactKeys(sources, ["projectSettings", "customRules", "pcb", "ruleSourceSet"], "clearanceReceipt.sourceIdentities");
  const projectSettingsIdentity = validateContentIdentityShape(sources.projectSettings, "clearanceReceipt.sourceIdentities.projectSettings", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes);
  const customRulesIdentity = sources.customRules === null
    ? null
    : validateContentIdentityShape(sources.customRules, "clearanceReceipt.sourceIdentities.customRules", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumRulesBytes);
  const pcbIdentity = validateContentIdentityShape(sources.pcb, "clearanceReceipt.sourceIdentities.pcb", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumPcbBytes);
  const ruleSourceSetIdentity = validateCanonicalIdentityShape(
    sources.ruleSourceSet,
    "clearanceReceipt.sourceIdentities.ruleSourceSet",
    FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
  );
  const resolution = validateClearanceRuleResolution(receipt.ruleResolution, "clearanceReceipt.ruleResolution");
  const expectedRuleSourceSetIdentity = canonicalIdentity({
    schemaVersion: FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
    projectSettings: projectSettingsIdentity,
    customRules: customRulesIdentity,
    pcb: pcbIdentity,
    kicad,
    resolution,
  }, FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION);
  if (!canonicalValuesEqual(ruleSourceSetIdentity, expectedRuleSourceSetIdentity)) {
    return fail("INVALID_INPUT", "Clearance evidence rule-source-set identity does not match its closed child sources.");
  }

  const boardMinimumClearanceMm = boundedMillimetres(
    receipt.boardMinimumClearanceMm,
    "clearanceReceipt.boardMinimumClearanceMm",
    0,
    10,
  );
  const netClasses = validateClearanceNetClassBindings(receipt.netClasses, "clearanceReceipt.netClasses", bundleIdentity);
  const classById = new Map(netClasses.map((entry) => [entry.contractNetClassId, entry]));
  const classByKicadName = new Map(netClasses.map((entry) => [entry.kicadNetClassName, entry]));

  if (!Array.isArray(receipt.nets)
      || receipt.nets.length === 0
      || receipt.nets.length > PCB_DESIGN_CONTRACT_LIMITS.maxNets) {
    return fail("INVALID_INPUT", "Clearance evidence receipt has an invalid net inventory.");
  }
  const nets: FreshClearanceNetEvidence[] = [];
  let previousNetName: string | null = null;
  for (const [index, child] of receipt.nets.entries()) {
    const label = `clearanceReceipt.nets[${index}]`;
    const net = record(child, label, "INVALID_INPUT");
    exactKeys(net, [
      "name",
      "contractNetClassId",
      "kicadNetClassName",
      "configuredClearanceMm",
      "effectiveClearanceMm",
    ], label);
    const configuredClearanceMm = boundedMillimetres(net.configuredClearanceMm, `${label}.configuredClearanceMm`, 0.05, 10);
    const effectiveClearanceMm = boundedMillimetres(net.effectiveClearanceMm, `${label}.effectiveClearanceMm`, 0.05, 10);
    if (typeof net.name !== "string" || !isContractNetName(net.name)
        || typeof net.contractNetClassId !== "string" || !CONTRACT_IDENTIFIER.test(net.contractNetClassId)
        || typeof net.kicadNetClassName !== "string"
        || (previousNetName !== null && compareText(previousNetName, net.name) >= 0)) {
      return fail("INVALID_INPUT", "Clearance evidence receipt nets must be uniquely sorted closed-contract records.");
    }
    const contractClass = classById.get(net.contractNetClassId);
    const namedClass = classByKicadName.get(net.kicadNetClassName);
    if (contractClass === undefined
        || namedClass !== contractClass
        || configuredClearanceMm !== contractClass.configuredClearanceMm
        || !contractClass.netNames.includes(net.name)) {
      return fail("INVALID_INPUT", `Clearance evidence net ${net.name} disagrees with its class binding.`);
    }
    nets.push({
      name: net.name,
      contractNetClassId: net.contractNetClassId,
      kicadNetClassName: net.kicadNetClassName,
      configuredClearanceMm,
      effectiveClearanceMm,
    });
    previousNetName = net.name;
  }
  const boundNetNames = netClasses.flatMap((binding) => binding.netNames).sort(compareText);
  if (!canonicalValuesEqual(boundNetNames, nets.map((net) => net.name))) {
    return fail("INVALID_INPUT", "Clearance evidence net inventory does not exactly cover every bound contract net.");
  }

  if (!Array.isArray(receipt.pairs)
      || receipt.pairs.length > MAX_CLEARANCE_RECEIPT_PAIRS
      || receipt.pairs.length !== (nets.length * (nets.length - 1)) / 2) {
    return fail("INVALID_INPUT", "Clearance evidence pair inventory is incomplete or overcomplete.");
  }
  const pairValuesByNet = new Map<string, number[]>();
  let pairIndex = 0;
  for (let leftIndex = 0; leftIndex < nets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nets.length; rightIndex += 1) {
      const left = nets[leftIndex]!;
      const right = nets[rightIndex]!;
      const label = `clearanceReceipt.pairs[${pairIndex}]`;
      const pair = record(receipt.pairs[pairIndex], label, "INVALID_INPUT");
      exactKeys(pair, ["leftNet", "rightNet", "effectiveClearanceMm", "limitingSources"], label);
      const effectiveClearanceMm = Math.max(
        boardMinimumClearanceMm,
        left.configuredClearanceMm,
        right.configuredClearanceMm,
      );
      const expectedSources = [
        ...(Math.abs(boardMinimumClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? ["board.design_settings.rules.min_clearance"]
          : []),
        ...(Math.abs(left.configuredClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? [`netclass:${left.contractNetClassId}`]
          : []),
        ...(Math.abs(right.configuredClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? [`netclass:${right.contractNetClassId}`]
          : []),
      ];
      const expectedPair = {
        leftNet: left.name,
        rightNet: right.name,
        effectiveClearanceMm,
        limitingSources: [...new Set(expectedSources)].sort(compareText),
      };
      if (!canonicalValuesEqual(pair, expectedPair)) {
        return fail("INVALID_INPUT", `Clearance evidence pair ${left.name}/${right.name} is not the deterministic rule projection.`);
      }
      const leftValues = pairValuesByNet.get(left.name) ?? [];
      leftValues.push(effectiveClearanceMm);
      pairValuesByNet.set(left.name, leftValues);
      const rightValues = pairValuesByNet.get(right.name) ?? [];
      rightValues.push(effectiveClearanceMm);
      pairValuesByNet.set(right.name, rightValues);
      pairIndex += 1;
    }
  }
  for (const net of nets) {
    const pairValues = pairValuesByNet.get(net.name) ?? [];
    const expectedEffective = pairValues.length === 0
      ? Math.max(boardMinimumClearanceMm, net.configuredClearanceMm)
      : Math.min(...pairValues);
    if (net.effectiveClearanceMm !== expectedEffective) {
      return fail("INVALID_INPUT", `Clearance evidence net ${net.name} effective value disagrees with its pair projection.`);
    }
  }

  const acceptance = record(receipt.acceptanceEvidence, "clearanceReceipt.acceptanceEvidence", "INVALID_INPUT");
  exactKeys(acceptance, [
    "origin",
    "schemaVersion",
    "source",
    "pcbSha256",
    "rulesSourceSha256",
    "netClasses",
  ], "clearanceReceipt.acceptanceEvidence");
  if (!Array.isArray(acceptance.netClasses)) {
    return fail("INVALID_INPUT", "Clearance acceptance projection has an invalid class inventory.");
  }
  for (const [index, child] of acceptance.netClasses.entries()) {
    const label = `clearanceReceipt.acceptanceEvidence.netClasses[${index}]`;
    const netClass = record(child, label, "INVALID_INPUT");
    exactKeys(netClass, ["id", "configuredClearanceMm", "effectiveClearanceMm"], label);
    if (typeof netClass.id !== "string" || !CONTRACT_IDENTIFIER.test(netClass.id)) {
      return fail("INVALID_INPUT", "Clearance acceptance projection contains an invalid class identifier.");
    }
    boundedMillimetres(netClass.configuredClearanceMm, `${label}.configuredClearanceMm`, 0.05, 10);
    boundedMillimetres(netClass.effectiveClearanceMm, `${label}.effectiveClearanceMm`, 0.05, 10);
  }
  const expectedAcceptanceEvidence: FreshDesignClearanceEvidence = {
    origin: "host",
    schemaVersion: FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
    source: "kicad-effective-netclass-rules",
    pcbSha256: pcbIdentity.digest,
    rulesSourceSha256: ruleSourceSetIdentity.digest,
    netClasses: netClasses.map((binding) => {
      const classNets = nets.filter((net) => net.contractNetClassId === binding.contractNetClassId);
      if (classNets.length === 0) {
        return fail("INVALID_INPUT", `Clearance evidence class ${binding.contractNetClassId} has no bound net evidence.`);
      }
      return {
        id: binding.contractNetClassId,
        configuredClearanceMm: binding.configuredClearanceMm,
        effectiveClearanceMm: Math.min(...classNets.map((net) => net.effectiveClearanceMm)),
      };
    }),
  };
  if (!canonicalValuesEqual(acceptance, expectedAcceptanceEvidence)) {
    return fail("INVALID_INPUT", "Clearance acceptance evidence is not the exact receipt compatibility projection.");
  }
  if (!canonicalValuesEqual(receipt.evidenceLimitations, CLEARANCE_EVIDENCE_LIMITATIONS)) {
    return fail("INVALID_INPUT", "Clearance evidence limitations are not the exact closed V1 statement set.");
  }
  validateCanonicalPayloadIdentity(receipt, FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION, "Clearance evidence receipt");
  return receipt as unknown as FreshClearanceEvidenceReceipt;
}

/**
 * Pure restart boundary linking a structurally valid final receipt to the
 * exact approved pre-authoring semantic authority. Filesystem currency is
 * deliberately left to verifyFreshClearanceEvidenceReceipt.
 */
export function verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(
  receiptInput: unknown,
  authorityInput: unknown,
): FreshClearanceEvidenceReceipt {
  const receipt = parseFreshClearanceEvidenceReceipt(receiptInput);
  const authority = parseFreshNetClassSemanticAuthority(authorityInput);
  const commonKeys = [
    "bundleIdentity",
    "contractIdentity",
    "genericProjectBindingIdentity",
    "freshMarkerContentIdentity",
    "kicad",
  ] as const;
  for (const key of commonKeys) {
    if (!canonicalValuesEqual(receipt[key], authority[key])) {
      return fail("INVALID_INPUT", `Clearance receipt and semantic authority disagree on ${key}.`);
    }
  }
  const authorityReceiptResolution = {
    boardMinimum: authority.ruleResolution.boardMinimum,
    netClassConflict: authority.ruleResolution.netClassConflict,
    customRules: authority.ruleResolution.customRules,
    localPadOrFootprintOverrides: authority.ruleResolution.localPadOrFootprintOverrides,
    zones: authority.ruleResolution.zones,
    netClassPatterns: authority.ruleResolution.netClassPatterns,
    derivedLabelAssignments: authority.ruleResolution.derivedLabelAssignments,
    contractNetAssignments: authority.ruleResolution.contractNetAssignments,
  };
  if (!canonicalValuesEqual(receipt.ruleResolution, authorityReceiptResolution)
      || receipt.boardMinimumClearanceMm !== authority.boardMinimumClearanceMm) {
    return fail("INVALID_INPUT", "Clearance receipt and semantic authority disagree on rule resolution or board minimum.");
  }

  const authorityClassByName = new Map(authority.netClasses.map((entry) => [entry.name, entry]));
  const expectedBindings = semanticAuthorityBindingProjection(
    authority.netClasses,
    authority.contractNetAssignments,
  );
  if (!canonicalValuesEqual(receipt.netClasses, expectedBindings)) {
    return fail("INVALID_INPUT", "Clearance receipt managed-class bindings differ from the approved full class definitions.");
  }

  const baseNets = authority.contractNetAssignments.map((assignment) => {
    const definition = authorityClassByName.get(assignment.kicadNetClassName);
    if (definition === undefined) {
      return fail("INVALID_INPUT", `Semantic authority assignment ${assignment.netName} references no managed definition.`);
    }
    return {
      name: assignment.netName,
      contractNetClassId: assignment.contractNetClassId,
      kicadNetClassName: assignment.kicadNetClassName,
      configuredClearanceMm: definition.clearance,
    };
  });
  const expectedPairs: FreshClearancePairEvidence[] = [];
  const effectiveByNet = new Map<string, number[]>();
  for (let leftIndex = 0; leftIndex < baseNets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < baseNets.length; rightIndex += 1) {
      const left = baseNets[leftIndex]!;
      const right = baseNets[rightIndex]!;
      const effectiveClearanceMm = Math.max(
        authority.boardMinimumClearanceMm,
        left.configuredClearanceMm,
        right.configuredClearanceMm,
      );
      const limitingSources = [
        ...(Math.abs(authority.boardMinimumClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? ["board.design_settings.rules.min_clearance"]
          : []),
        ...(Math.abs(left.configuredClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? [`netclass:${left.contractNetClassId}`]
          : []),
        ...(Math.abs(right.configuredClearanceMm - effectiveClearanceMm) <= NUMERIC_EPSILON
          ? [`netclass:${right.contractNetClassId}`]
          : []),
      ];
      expectedPairs.push({
        leftNet: left.name,
        rightNet: right.name,
        effectiveClearanceMm,
        limitingSources: [...new Set(limitingSources)].sort(compareText),
      });
      const leftValues = effectiveByNet.get(left.name) ?? [];
      leftValues.push(effectiveClearanceMm);
      effectiveByNet.set(left.name, leftValues);
      const rightValues = effectiveByNet.get(right.name) ?? [];
      rightValues.push(effectiveClearanceMm);
      effectiveByNet.set(right.name, rightValues);
    }
  }
  const expectedNets: FreshClearanceNetEvidence[] = baseNets.map((net) => {
    const pairValues = effectiveByNet.get(net.name) ?? [];
    return {
      ...net,
      effectiveClearanceMm: pairValues.length === 0
        ? Math.max(authority.boardMinimumClearanceMm, net.configuredClearanceMm)
        : Math.min(...pairValues),
    };
  });
  if (!canonicalValuesEqual(receipt.nets, expectedNets)
      || !canonicalValuesEqual(receipt.pairs, expectedPairs)) {
    return fail("INVALID_INPUT", "Clearance receipt net assignments or effective-clearance projection differ from approved semantics.");
  }
  return receipt;
}

/**
 * Reject receipt tampering and replay after any project/PCB/rules/marker/KiCad
 * source drift by independently deriving the current receipt again.
 */
export async function verifyFreshClearanceEvidenceReceipt(
  receiptInput: unknown,
  options: FreshClearanceOperationOptions,
): Promise<FreshClearanceEvidenceReceipt> {
  const receipt = parseFreshClearanceEvidenceReceipt(receiptInput);
  const current = await readFreshClearanceEvidence(options);
  if (!canonicalValuesEqual(receipt, current)) {
    return fail("SOURCE_DRIFT", "Clearance evidence receipt is stale, replayed, or does not match current rule-source bytes.");
  }
  return current;
}

/**
 * Shared source/configuration mechanics for host-owned family producers only.
 * These functions do not stamp an evidence family or authenticate a supplied bundle.
 * V1 and V2 boundaries authenticate their own project/marker/bundle and build their
 * own closed outcomes; no V1 artifact is manufactured as an adapter for V2.
 */
export const freshNetClassPreparationMechanics = Object.freeze({
  classBindings,
  generatedNetClass,
  authoredPatternsForBindings,
  materialize: materializeNetClassSources,
  read: readNetClassSources,
  validateSemanticDefinition: validateSemanticNetClass,
  validateBindings: validateClearanceNetClassBindings,
  projectBindings: semanticAuthorityBindingProjection,
  validateKicadAuthority: validatePathFreeKicadAuthority,
  validateCanonicalIdentity: validateCanonicalIdentityShape,
  validateContentIdentity: validateContentIdentityShape,
  validatePayloadIdentity: validateCanonicalPayloadIdentity,
  snapshotArtifact: hardenedArtifact,
});
