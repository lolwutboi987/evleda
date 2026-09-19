import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

/**
 * Deterministic, analysis-only checks for native KiCad PCB routing geometry.
 *
 * Every electrical or fabrication threshold is supplied by the bound profile.
 * The implementation intentionally does not infer current capacity, impedance,
 * a universal trace-spacing multiple, or a universal per-via rating.
 */

export const PCB_PRACTICE_ANALYSIS_SCHEMA = "evleda.pcb-practice-analysis.v2" as const;
export const PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA = "evleda.pcb-practice-analysis-profile.v2" as const;
export const PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS = [20250316, 20260206] as const;

export type PcbPracticeSeverity = "advisory" | "warning" | "error";
export type PcbPracticeGate = "human-review" | "fabricator-confirmation";
export type PcbViaType = "through" | "blind" | "micro";

export interface PcbPoint {
  readonly x: number;
  readonly y: number;
}

export interface PcbRuleDisposition {
  readonly sourceRuleId: string;
  readonly severity: "warning" | "error";
  readonly gates?: readonly PcbPracticeGate[];
}

export interface PcbNetClassPracticePolicy extends PcbRuleDisposition {
  readonly id: string;
  readonly minimumTrackWidthMm: number;
  readonly minimumInteriorAngleDeg?: number;
  readonly interiorAngleDisposition?: PcbRuleDisposition;
  readonly minimumTraceToBoardEdgeMm?: number;
  readonly traceToBoardEdgeDisposition?: PcbRuleDisposition;
}

export interface PcbMinimumPracticeRule extends PcbRuleDisposition {
  readonly minimumMm: number;
}

export interface PcbLayerTransition {
  readonly startLayer: string;
  readonly endLayer: string;
}

export interface PcbViaPracticeRule extends PcbRuleDisposition {
  readonly id: string;
  readonly appliesTo?: {
    readonly netClassIds?: readonly string[];
    readonly netNames?: readonly string[];
    readonly viaTypes?: readonly PcbViaType[];
  };
  readonly minimumPadDiameterMm?: number;
  readonly minimumDrillDiameterMm?: number;
  readonly minimumAnnularRingMm?: number;
  readonly allowedLayerTransitions?: readonly PcbLayerTransition[];
}

export interface PcbFabricationPracticePolicy {
  /** Human-readable declaration identity; it is not treated as qualification. */
  readonly declarationId: string;
  readonly minimumTrackWidth?: PcbMinimumPracticeRule;
  readonly minimumTraceToBoardEdge?: PcbMinimumPracticeRule;
  readonly viaRules?: readonly PcbViaPracticeRule[];
}

export interface PcbPracticeAnalysisProfile {
  readonly schemaVersion: typeof PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA;
  readonly sourceValidation: {
    readonly mode: "production" | "fixture";
    readonly supportedBoardVersions: readonly number[];
  };
  readonly copperLayerOrder: readonly string[];
  readonly netClasses: readonly PcbNetClassPracticePolicy[];
  readonly netClassByNet: Readonly<Record<string, string>>;
  readonly defaultNetClassId?: string;
  readonly viaRules: readonly PcbViaPracticeRule[];
  readonly advisories: {
    readonly rightAngle: {
      readonly sourceRuleId: string;
      readonly toleranceDeg: number;
    };
    readonly reversal: {
      readonly sourceRuleId: string;
      readonly maximumInteriorAngleDeg: number;
    };
    readonly adjacentHairpin: {
      readonly sourceRuleId: string;
      readonly parallelToleranceDeg: number;
      readonly maximumLegEdgeGapMm: number;
      readonly minimumParallelOverlapMm: number;
      readonly maximumConnectorPathLengthMm: number;
    };
  };
  readonly diagnostics: {
    readonly invalidGeometrySourceRuleId: string;
    readonly unboundNetSourceRuleId: string;
    readonly unsupportedOutlineSourceRuleId: string;
    readonly unsupportedRoutingSourceRuleId: string;
    readonly junctionCoverageSourceRuleId: string;
    readonly containmentSourceRuleId: string;
    readonly duplicateTrackSourceRuleId: string;
  };
  readonly fabrication?: PcbFabricationPracticePolicy;
  /** Matching tolerance only; this is not an electrical/design threshold. */
  readonly coordinateToleranceMm?: number;
}

export interface PcbEvidenceLocation {
  readonly sourcePath: string;
  readonly form: string;
  readonly ordinal: number;
  readonly uuid: string | null;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface PcbFindingEvidence {
  readonly role: string;
  readonly location: PcbEvidenceLocation;
  readonly geometry: Readonly<Record<string, unknown>>;
}

export interface PcbPracticeFinding {
  readonly id: string;
  readonly code: string;
  readonly severity: PcbPracticeSeverity;
  readonly message: string;
  readonly sourceRuleIds: readonly string[];
  readonly evidence: readonly PcbFindingEvidence[];
  readonly observed: Readonly<Record<string, unknown>>;
  readonly required: Readonly<Record<string, unknown>>;
  readonly assumptions: readonly string[];
  readonly gates: readonly PcbPracticeGate[];
}

export interface PcbRoutedSegment {
  readonly ordinal: number;
  readonly uuid: string | null;
  readonly start: PcbPoint;
  readonly end: PcbPoint;
  readonly widthMm: number;
  readonly layer: string;
  readonly netName: string | null;
  readonly netClassId: string | null;
  readonly lengthMm: number;
  readonly clearanceToBoardEdgeMm: number | null;
  readonly evidence: PcbEvidenceLocation;
}

export interface PcbRoutedArc {
  readonly ordinal: number;
  readonly uuid: string | null;
  readonly start: PcbPoint;
  readonly mid: PcbPoint;
  readonly end: PcbPoint;
  readonly widthMm: number;
  readonly layer: string;
  readonly netName: string | null;
  readonly netClassId: string | null;
  readonly evidence: PcbEvidenceLocation;
}

export type PcbTurnClassification =
  | "reversal-candidate"
  | "right-angle"
  | "acute"
  | "obtuse"
  | "straight";

export interface PcbRoutedTurn {
  readonly vertex: PcbPoint;
  readonly netName: string;
  readonly netClassId: string | null;
  readonly layer: string;
  readonly segmentOrdinals: readonly [number, number];
  readonly interiorAngleDeg: number;
  readonly directionChangeDeg: number;
  readonly classification: PcbTurnClassification;
}

export interface PcbViaGeometry {
  readonly ordinal: number;
  readonly uuid: string | null;
  readonly at: PcbPoint;
  readonly type: PcbViaType;
  readonly padDiameterMm: number;
  readonly drillDiameterMm: number;
  readonly annularRingMm: number;
  readonly clearanceToBoardEdgeMm: number | null;
  readonly layers: readonly [string, string];
  readonly incidentSegmentLayers: readonly string[];
  readonly netName: string | null;
  readonly netClassId: string | null;
  readonly evidence: PcbEvidenceLocation;
}

export interface PcbObservedLayerTransition {
  readonly viaOrdinal: number;
  readonly viaType: PcbViaType;
  readonly netName: string | null;
  readonly netClassId: string | null;
  readonly startLayer: string;
  readonly endLayer: string;
  readonly incidentSegmentLayers: readonly string[];
  readonly evidence: PcbEvidenceLocation;
}

export interface PcbHairpinCandidate {
  readonly netName: string;
  readonly layer: string;
  readonly legSegmentOrdinals: readonly [number, number];
  readonly connectorSegmentOrdinals: readonly number[];
  readonly parallelAngleDifferenceDeg: number;
  readonly minimumCenterlineSeparationMm: number;
  readonly maximumCenterlineSeparationMm: number;
  readonly minimumEdgeGapMm: number;
  readonly maximumEdgeGapMm: number;
  readonly parallelOverlapMm: number;
  readonly connectorPathLengthMm: number;
}

export interface PcbBoardEdgePrimitive {
  readonly kind: "line" | "arc" | "circle";
  readonly start: PcbPoint | null;
  readonly end: PcbPoint | null;
  readonly center: PcbPoint | null;
  readonly radiusMm: number | null;
  readonly clockwise: boolean | null;
  readonly evidence: PcbEvidenceLocation;
}

export interface PcbPracticeAnalysis {
  readonly schemaVersion: typeof PCB_PRACTICE_ANALYSIS_SCHEMA;
  readonly profileSchemaVersion: string;
  readonly classification: "analysis-only";
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly outcome: "pass" | "review" | "fail";
  readonly summary: {
    readonly segmentCount: number;
    readonly routedArcCount: number;
    readonly viaCount: number;
    readonly turnCount: number;
    readonly layerTransitionCount: number;
    readonly hairpinCandidateCount: number;
    readonly boardEdgePrimitiveCount: number;
    readonly outlineComplete: boolean;
    readonly routingCoverageComplete: boolean;
    readonly completeBoardGeometryCoverage: false;
    readonly findingsBySeverity: Readonly<Record<PcbPracticeSeverity, number>>;
    readonly humanReviewRequired: boolean;
    readonly fabricatorConfirmationRequired: boolean;
  };
  readonly extracted: {
    readonly segments: readonly PcbRoutedSegment[];
    readonly routedArcs: readonly PcbRoutedArc[];
    readonly vias: readonly PcbViaGeometry[];
    readonly layerTransitions: readonly PcbObservedLayerTransition[];
    readonly turns: readonly PcbRoutedTurn[];
    readonly hairpinCandidates: readonly PcbHairpinCandidate[];
    readonly boardEdges: readonly PcbBoardEdgePrimitive[];
  };
  readonly findings: readonly PcbPracticeFinding[];
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
}

export class PcbPracticeAnalyzerError extends Error {
  readonly code: "INVALID_PROFILE" | "INVALID_KICAD_PCB";

  constructor(code: "INVALID_PROFILE" | "INVALID_KICAD_PCB", message: string) {
    super(message);
    this.name = "PcbPracticeAnalyzerError";
    this.code = code;
  }
}

interface LocatedForm {
  readonly name: string;
  readonly text: string;
  readonly node: SExpressionNode;
  readonly start: number;
  readonly end: number;
  readonly location: PcbEvidenceLocation;
}

interface SExpressionAtom {
  readonly value: string;
  readonly quoted: boolean;
  readonly start: number;
  readonly end: number;
}

interface SExpressionNode {
  readonly name: string;
  readonly values: readonly SExpressionAtom[];
  readonly children: readonly SExpressionNode[];
  readonly start: number;
  readonly end: number;
}

interface MutableFinding extends Omit<PcbPracticeFinding, "id"> {
  readonly sortOffset: number;
}

interface AtomicEdge {
  readonly kind: "line" | "arc" | "circle";
  readonly start: PcbPoint | null;
  readonly end: PcbPoint | null;
  readonly center: PcbPoint | null;
  readonly radiusMm: number | null;
  readonly clockwise: boolean | null;
  readonly evidence: PcbEvidenceLocation;
}

interface OrientedAtomicEdge {
  readonly edge: AtomicEdge;
  readonly reverse: boolean;
}

interface OutlineLoop {
  readonly edges: readonly OrientedAtomicEdge[];
  readonly polyline: readonly PcbPoint[];
}

interface OutlineModel {
  readonly edges: readonly AtomicEdge[];
  readonly loops: readonly OutlineLoop[];
  readonly complete: boolean;
}

interface WeightedRule {
  readonly sourceRuleId: string;
  readonly minimumMm: number;
  readonly severity: "warning" | "error";
  readonly gates: readonly PcbPracticeGate[];
}

const DEG_PER_RAD = 180 / Math.PI;
const DEFAULT_COORDINATE_TOLERANCE_MM = 1e-6;
const DECIMAL_TOKEN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const INTEGER_TOKEN = /^(?:0|[1-9]\d*)$/u;
const MAX_SOURCE_CHARACTERS = 64 * 1024 * 1024;
const MAX_S_EXPRESSION_NODES = 1_000_000;
const MAX_S_EXPRESSION_DEPTH = 256;
const MAX_TOKEN_CHARACTERS = 1_048_576;
const MAX_ABSOLUTE_GEOMETRY_MM = 10_000_000;
const MAX_FINDINGS = 100_000;
const MAX_ROUTED_OBJECTS_PER_KIND = 10_000;
const MAX_OUTLINE_ATOMIC_EDGES = 10_000;
const MAX_PAIRWISE_GEOMETRY_COMPARISONS = 5_000_000;
const MAX_VIA_RULE_APPLICATION_WORK = 1_000_000;
const DIMENSIONLESS_EPSILON = 1e-12;

class BoundedFindingList extends Array<MutableFinding> {
  override push(...items: MutableFinding[]): number {
    if (this.length + items.length > MAX_FINDINGS) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "PCB practice finding count exceeds the analysis limit.");
    }
    return super.push(...items);
  }
}

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = <T extends string>(values: readonly T[]): readonly T[] =>
  [...new Set(values)].sort(compareCodeUnits);

const compareSeverity = (left: PcbPracticeSeverity, right: PcbPracticeSeverity): number => {
  const weights: Readonly<Record<PcbPracticeSeverity, number>> = {
    advisory: 0,
    warning: 1,
    error: 2,
  };
  return weights[left] - weights[right];
};

const strongestSeverity = (values: readonly PcbPracticeSeverity[]): PcbPracticeSeverity =>
  values.reduce<PcbPracticeSeverity>(
    (strongest, candidate) => compareSeverity(candidate, strongest) > 0 ? candidate : strongest,
    "advisory",
  );

const finiteNonnegative = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= MAX_ABSOLUTE_GEOMETRY_MM;

function assertPairwiseBound(count: number, label: string): void {
  if (count * (count - 1) / 2 > MAX_PAIRWISE_GEOMETRY_COMPARISONS) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${label} exceeds the phase-1 pairwise analysis bound.`);
  }
}

function clonePlainData(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
  depth = 0,
  budget = { count: 0 },
): unknown {
  if (depth > 64) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} exceeds the profile depth limit.`);
  budget.count += 1;
  if (budget.count > 100_000) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Profile value count exceeds the limit.");
  if (typeof value === "string") {
    if (value.length > MAX_TOKEN_CHARACTERS) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} string is too long.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be finite.`);
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} is not plain data.`);
  if (nodeUtilTypes.isProxy(value)) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} cannot be a Proxy.`);
  if (seen.has(value)) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} array cannot contain symbol keys.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Readonly<
      Record<string, PropertyDescriptor | undefined>
    >;
    const lengthDescriptor = descriptors["length"];
    const lengthValue = lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (
      typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 || lengthValue > 100_000
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} array has an invalid length descriptor.`);
    }
    const length = lengthValue;
    const allowedKeys = new Set(["length", ...Array.from({ length }, (_unused, index) => String(index))]);
    if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} array has extra own properties.`);
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.get !== undefined || descriptor.set !== undefined
      ) {
        throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path}[${index}] must be a present enumerable data property.`);
      }
      copy.push(clonePlainData(descriptor.value, `${path}[${index}]`, seen, depth + 1, budget));
    }
    seen.delete(value);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} cannot contain symbol keys.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path}.${key} must be an enumerable data property.`);
    }
    copy[key] = clonePlainData(descriptor.value, `${path}.${key}`, seen, depth + 1, budget);
  }
  seen.delete(value);
  return copy;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function profileRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactProfileKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in record));
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new PcbPracticeAnalyzerError(
      "INVALID_PROFILE",
      `${path} has missing [${missing.join(", ")}] or unknown [${unknown.join(", ")}] keys.`,
    );
  }
}

function profileString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be a non-empty string.`);
  }
  return value;
}

function profileNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be a finite number.`);
  }
  return value;
}

function profileArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path} must be an array.`);
  return value;
}

function validateDispositionShape(record: Record<string, unknown>, path: string): void {
  profileString(record.sourceRuleId, `${path}.sourceRuleId`);
  if (record.severity !== "warning" && record.severity !== "error") {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path}.severity must be warning or error.`);
  }
  if (record.gates !== undefined) {
    for (const [index, gate] of profileArray(record.gates, `${path}.gates`).entries()) {
      if (gate !== "human-review" && gate !== "fabricator-confirmation") {
        throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path}.gates[${index}] is not a supported gate.`);
      }
    }
  }
}

function validateMinimumRuleShape(value: unknown, path: string): void {
  const record = profileRecord(value, path);
  exactProfileKeys(record, ["sourceRuleId", "severity", "minimumMm"], ["gates"], path);
  validateDispositionShape(record, path);
  profileNumber(record.minimumMm, `${path}.minimumMm`);
}

function validateViaRuleShape(value: unknown, path: string): void {
  const record = profileRecord(value, path);
  exactProfileKeys(
    record,
    ["id", "sourceRuleId", "severity"],
    [
      "gates", "appliesTo", "minimumPadDiameterMm", "minimumDrillDiameterMm",
      "minimumAnnularRingMm", "allowedLayerTransitions",
    ],
    path,
  );
  validateDispositionShape(record, path);
  profileString(record.id, `${path}.id`);
  for (const key of ["minimumPadDiameterMm", "minimumDrillDiameterMm", "minimumAnnularRingMm"] as const) {
    if (record[key] !== undefined) profileNumber(record[key], `${path}.${key}`);
  }
  if (record.appliesTo !== undefined) {
    const applies = profileRecord(record.appliesTo, `${path}.appliesTo`);
    exactProfileKeys(applies, [], ["netClassIds", "netNames", "viaTypes"], `${path}.appliesTo`);
    for (const key of ["netClassIds", "netNames"] as const) {
      if (applies[key] !== undefined) {
        profileArray(applies[key], `${path}.appliesTo.${key}`).forEach((entry, index) =>
          profileString(entry, `${path}.appliesTo.${key}[${index}]`));
      }
    }
    if (applies.viaTypes !== undefined) {
      profileArray(applies.viaTypes, `${path}.appliesTo.viaTypes`).forEach((entry, index) => {
        if (entry !== "through" && entry !== "blind" && entry !== "micro") {
          throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${path}.appliesTo.viaTypes[${index}] is invalid.`);
        }
      });
    }
  }
  if (record.allowedLayerTransitions !== undefined) {
    profileArray(record.allowedLayerTransitions, `${path}.allowedLayerTransitions`).forEach((entry, index) => {
      const transition = profileRecord(entry, `${path}.allowedLayerTransitions[${index}]`);
      exactProfileKeys(transition, ["startLayer", "endLayer"], [], `${path}.allowedLayerTransitions[${index}]`);
      profileString(transition.startLayer, `${path}.allowedLayerTransitions[${index}].startLayer`);
      profileString(transition.endLayer, `${path}.allowedLayerTransitions[${index}].endLayer`);
    });
  }
}

function validateProfileShape(value: unknown): asserts value is PcbPracticeAnalysisProfile {
  const record = profileRecord(value, "profile");
  exactProfileKeys(
    record,
    [
      "schemaVersion", "sourceValidation", "copperLayerOrder", "netClasses", "netClassByNet",
      "viaRules", "advisories", "diagnostics",
    ],
    ["defaultNetClassId", "fabrication", "coordinateToleranceMm"],
    "profile",
  );
  profileString(record.schemaVersion, "profile.schemaVersion");
  const sourceValidation = profileRecord(record.sourceValidation, "profile.sourceValidation");
  exactProfileKeys(sourceValidation, ["mode", "supportedBoardVersions"], [], "profile.sourceValidation");
  if (sourceValidation.mode !== "production" && sourceValidation.mode !== "fixture") {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "profile.sourceValidation.mode must be production or fixture.");
  }
  profileArray(sourceValidation.supportedBoardVersions, "profile.sourceValidation.supportedBoardVersions")
    .forEach((entry, index) => {
      const version = profileNumber(entry, `profile.sourceValidation.supportedBoardVersions[${index}]`);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Supported board versions must be positive safe integers.");
      }
    });
  profileArray(record.copperLayerOrder, "profile.copperLayerOrder").forEach((entry, index) =>
    profileString(entry, `profile.copperLayerOrder[${index}]`));
  if (record.defaultNetClassId !== undefined) profileString(record.defaultNetClassId, "profile.defaultNetClassId");
  if (record.coordinateToleranceMm !== undefined) profileNumber(record.coordinateToleranceMm, "profile.coordinateToleranceMm");
  const netClassByNet = profileRecord(record.netClassByNet, "profile.netClassByNet");
  for (const [netName, classId] of Object.entries(netClassByNet)) {
    if (netName.length === 0) throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "profile.netClassByNet has an empty key.");
    profileString(classId, `profile.netClassByNet.${netName}`);
  }
  profileArray(record.netClasses, "profile.netClasses").forEach((entry, index) => {
    const netClass = profileRecord(entry, `profile.netClasses[${index}]`);
    exactProfileKeys(
      netClass,
      ["id", "sourceRuleId", "severity", "minimumTrackWidthMm"],
      [
        "gates", "minimumInteriorAngleDeg", "interiorAngleDisposition",
        "minimumTraceToBoardEdgeMm", "traceToBoardEdgeDisposition",
      ],
      `profile.netClasses[${index}]`,
    );
    validateDispositionShape(netClass, `profile.netClasses[${index}]`);
    profileString(netClass.id, `profile.netClasses[${index}].id`);
    profileNumber(netClass.minimumTrackWidthMm, `profile.netClasses[${index}].minimumTrackWidthMm`);
    if (netClass.minimumInteriorAngleDeg !== undefined) {
      profileNumber(netClass.minimumInteriorAngleDeg, `profile.netClasses[${index}].minimumInteriorAngleDeg`);
      const disposition = profileRecord(netClass.interiorAngleDisposition, `profile.netClasses[${index}].interiorAngleDisposition`);
      exactProfileKeys(disposition, ["sourceRuleId", "severity"], ["gates"], `profile.netClasses[${index}].interiorAngleDisposition`);
      validateDispositionShape(disposition, `profile.netClasses[${index}].interiorAngleDisposition`);
    } else if (netClass.interiorAngleDisposition !== undefined) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "interiorAngleDisposition requires minimumInteriorAngleDeg.");
    }
    if (netClass.minimumTraceToBoardEdgeMm !== undefined) {
      profileNumber(netClass.minimumTraceToBoardEdgeMm, `profile.netClasses[${index}].minimumTraceToBoardEdgeMm`);
      const disposition = profileRecord(netClass.traceToBoardEdgeDisposition, `profile.netClasses[${index}].traceToBoardEdgeDisposition`);
      exactProfileKeys(disposition, ["sourceRuleId", "severity"], ["gates"], `profile.netClasses[${index}].traceToBoardEdgeDisposition`);
      validateDispositionShape(disposition, `profile.netClasses[${index}].traceToBoardEdgeDisposition`);
    } else if (netClass.traceToBoardEdgeDisposition !== undefined) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "traceToBoardEdgeDisposition requires minimumTraceToBoardEdgeMm.");
    }
  });
  profileArray(record.viaRules, "profile.viaRules").forEach((entry, index) =>
    validateViaRuleShape(entry, `profile.viaRules[${index}]`));
  const advisories = profileRecord(record.advisories, "profile.advisories");
  exactProfileKeys(advisories, ["rightAngle", "reversal", "adjacentHairpin"], [], "profile.advisories");
  const rightAngle = profileRecord(advisories.rightAngle, "profile.advisories.rightAngle");
  exactProfileKeys(rightAngle, ["sourceRuleId", "toleranceDeg"], [], "profile.advisories.rightAngle");
  profileString(rightAngle.sourceRuleId, "profile.advisories.rightAngle.sourceRuleId");
  profileNumber(rightAngle.toleranceDeg, "profile.advisories.rightAngle.toleranceDeg");
  const reversal = profileRecord(advisories.reversal, "profile.advisories.reversal");
  exactProfileKeys(reversal, ["sourceRuleId", "maximumInteriorAngleDeg"], [], "profile.advisories.reversal");
  profileString(reversal.sourceRuleId, "profile.advisories.reversal.sourceRuleId");
  profileNumber(reversal.maximumInteriorAngleDeg, "profile.advisories.reversal.maximumInteriorAngleDeg");
  const hairpin = profileRecord(advisories.adjacentHairpin, "profile.advisories.adjacentHairpin");
  exactProfileKeys(
    hairpin,
    [
      "sourceRuleId", "parallelToleranceDeg", "maximumLegEdgeGapMm",
      "minimumParallelOverlapMm", "maximumConnectorPathLengthMm",
    ],
    [],
    "profile.advisories.adjacentHairpin",
  );
  profileString(hairpin.sourceRuleId, "profile.advisories.adjacentHairpin.sourceRuleId");
  for (const key of [
    "parallelToleranceDeg", "maximumLegEdgeGapMm", "minimumParallelOverlapMm", "maximumConnectorPathLengthMm",
  ] as const) profileNumber(hairpin[key], `profile.advisories.adjacentHairpin.${key}`);
  const diagnostics = profileRecord(record.diagnostics, "profile.diagnostics");
  const diagnosticKeys = [
    "invalidGeometrySourceRuleId", "unboundNetSourceRuleId", "unsupportedOutlineSourceRuleId",
    "unsupportedRoutingSourceRuleId", "junctionCoverageSourceRuleId", "containmentSourceRuleId",
    "duplicateTrackSourceRuleId",
  ] as const;
  exactProfileKeys(diagnostics, diagnosticKeys, [], "profile.diagnostics");
  diagnosticKeys.forEach((key) => profileString(diagnostics[key], `profile.diagnostics.${key}`));
  if (record.fabrication !== undefined) {
    const fabrication = profileRecord(record.fabrication, "profile.fabrication");
    exactProfileKeys(
      fabrication,
      ["declarationId"],
      ["minimumTrackWidth", "minimumTraceToBoardEdge", "viaRules"],
      "profile.fabrication",
    );
    profileString(fabrication.declarationId, "profile.fabrication.declarationId");
    if (fabrication.minimumTrackWidth !== undefined) {
      validateMinimumRuleShape(fabrication.minimumTrackWidth, "profile.fabrication.minimumTrackWidth");
    }
    if (fabrication.minimumTraceToBoardEdge !== undefined) {
      validateMinimumRuleShape(fabrication.minimumTraceToBoardEdge, "profile.fabrication.minimumTraceToBoardEdge");
    }
    if (fabrication.viaRules !== undefined) {
      profileArray(fabrication.viaRules, "profile.fabrication.viaRules").forEach((entry, index) =>
        validateViaRuleShape(entry, `profile.fabrication.viaRules[${index}]`));
    }
  }
}

export function validateAndSnapshotPcbPracticeAnalysisProfile(
  value: PcbPracticeAnalysisProfile,
): PcbPracticeAnalysisProfile {
  const snapshot = clonePlainData(value, "profile");
  validateProfileShape(snapshot);
  validateProfile(snapshot);
  return deepFreeze(snapshot);
}

function validateProfile(profile: PcbPracticeAnalysisProfile): void {
  if (profile.schemaVersion !== PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA) {
    throw new PcbPracticeAnalyzerError(
      "INVALID_PROFILE",
      `schemaVersion must be ${PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA}.`,
    );
  }
  const supportedVersions = profile.sourceValidation.supportedBoardVersions;
  const analyzerSupportedVersions = new Set<number>(PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS);
  if (
    new Set(supportedVersions).size !== supportedVersions.length ||
    supportedVersions.some((version) => !analyzerSupportedVersions.has(version)) ||
    (profile.sourceValidation.mode === "production" && supportedVersions.length === 0)
  ) {
    throw new PcbPracticeAnalyzerError(
      "INVALID_PROFILE",
      "supportedBoardVersions must be a unique, non-empty production subset of analyzer-owned versions.",
    );
  }
  const coordinateTolerance = profile.coordinateToleranceMm ?? DEFAULT_COORDINATE_TOLERANCE_MM;
  if (!(Number.isFinite(coordinateTolerance) && coordinateTolerance > 0 && coordinateTolerance <= MAX_ABSOLUTE_GEOMETRY_MM)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "coordinateToleranceMm must be positive and finite.");
  }
  const layerSet = new Set(profile.copperLayerOrder);
  if (profile.copperLayerOrder.length < 2 || layerSet.size !== profile.copperLayerOrder.length) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "copperLayerOrder must contain at least two unique layers.");
  }
  const classIds = profile.netClasses.map((netClass) => netClass.id);
  if (
    classIds.length === 0 || classIds.length > 1_000 ||
    new Set(classIds).size !== classIds.length || classIds.some((id) => id.length === 0)
  ) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Net-class IDs must be non-empty and unique.");
  }
  const classIdSet = new Set(classIds);
  if (profile.defaultNetClassId !== undefined && !classIdSet.has(profile.defaultNetClassId)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "defaultNetClassId does not identify a bound net class.");
  }
  for (const [netName, classId] of Object.entries(profile.netClassByNet)) {
    if (netName.length === 0 || !classIdSet.has(classId)) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "netClassByNet contains an empty net or unknown class ID.");
    }
  }
  for (const netClass of profile.netClasses) {
    if (!finiteNonnegative(netClass.minimumTrackWidthMm)) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `Net class ${netClass.id} has an invalid minimumTrackWidthMm.`);
    }
    if (
      netClass.minimumInteriorAngleDeg !== undefined &&
      !(netClass.minimumInteriorAngleDeg >= 0 && netClass.minimumInteriorAngleDeg <= 180)
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `Net class ${netClass.id} has an invalid minimumInteriorAngleDeg.`);
    }
    if (
      netClass.minimumTraceToBoardEdgeMm !== undefined &&
      !finiteNonnegative(netClass.minimumTraceToBoardEdgeMm)
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `Net class ${netClass.id} has an invalid edge minimum.`);
    }
  }
  const boundRules: readonly PcbRuleDisposition[] = [
    ...profile.netClasses,
    ...profile.viaRules,
    ...(profile.fabrication?.viaRules ?? []),
    ...(
      profile.fabrication?.minimumTrackWidth === undefined
        ? []
        : [profile.fabrication.minimumTrackWidth]
    ),
    ...(
      profile.fabrication?.minimumTraceToBoardEdge === undefined
        ? []
        : [profile.fabrication.minimumTraceToBoardEdge]
    ),
  ];
  if (boundRules.some((rule) => rule.sourceRuleId.trim().length === 0)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Every enforceable rule must bind a source-rule ID.");
  }
  const viaRuleIds = [...profile.viaRules, ...(profile.fabrication?.viaRules ?? [])].map((rule) => rule.id);
  if (viaRuleIds.length > 1_000 || new Set(viaRuleIds).size !== viaRuleIds.length || viaRuleIds.some((id) => id.length === 0)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Via-rule IDs must be non-empty and unique across design and fabrication rules.");
  }
  if (profile.fabrication !== undefined && profile.fabrication.declarationId.trim().length === 0) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "fabrication.declarationId must be non-empty.");
  }
  const sourceRuleIds = [
    profile.advisories.rightAngle.sourceRuleId,
    profile.advisories.reversal.sourceRuleId,
    profile.advisories.adjacentHairpin.sourceRuleId,
    profile.diagnostics.invalidGeometrySourceRuleId,
    profile.diagnostics.unboundNetSourceRuleId,
    profile.diagnostics.unsupportedOutlineSourceRuleId,
    profile.diagnostics.unsupportedRoutingSourceRuleId,
    profile.diagnostics.junctionCoverageSourceRuleId,
    profile.diagnostics.containmentSourceRuleId,
    profile.diagnostics.duplicateTrackSourceRuleId,
  ];
  if (sourceRuleIds.some((id) => id.length === 0)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "Every diagnostic/advisory must bind a source-rule ID.");
  }
  const rightAngle = profile.advisories.rightAngle;
  const reversal = profile.advisories.reversal;
  const hairpin = profile.advisories.adjacentHairpin;
  if (!(rightAngle.toleranceDeg >= 0 && rightAngle.toleranceDeg < 45)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "rightAngle.toleranceDeg must be in [0, 45)." );
  }
  if (!(reversal.maximumInteriorAngleDeg >= 0 && reversal.maximumInteriorAngleDeg < 90)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "reversal.maximumInteriorAngleDeg must be in [0, 90)." );
  }
  if (!(hairpin.parallelToleranceDeg >= 0 && hairpin.parallelToleranceDeg < 90)) {
    throw new PcbPracticeAnalyzerError("INVALID_PROFILE", "adjacentHairpin.parallelToleranceDeg must be in [0, 90)." );
  }
  for (const [label, value] of Object.entries({
    parallelToleranceDeg: hairpin.parallelToleranceDeg,
    maximumLegEdgeGapMm: hairpin.maximumLegEdgeGapMm,
    minimumParallelOverlapMm: hairpin.minimumParallelOverlapMm,
    maximumConnectorPathLengthMm: hairpin.maximumConnectorPathLengthMm,
  })) {
    if (!finiteNonnegative(value)) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `adjacentHairpin.${label} must be finite and nonnegative.`);
    }
  }
  for (const rule of [...profile.viaRules, ...(profile.fabrication?.viaRules ?? [])]) {
    if (rule.appliesTo?.netClassIds?.some((id) => !classIdSet.has(id)) === true) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `Via rule ${rule.id} references an unknown net class.`);
    }
    if (
      rule.minimumPadDiameterMm === undefined &&
      rule.minimumDrillDiameterMm === undefined &&
      rule.minimumAnnularRingMm === undefined &&
      rule.allowedLayerTransitions === undefined
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `Via rule ${rule.id} does not declare a check.`);
    }
    for (const [label, value] of Object.entries({
      minimumPadDiameterMm: rule.minimumPadDiameterMm,
      minimumDrillDiameterMm: rule.minimumDrillDiameterMm,
      minimumAnnularRingMm: rule.minimumAnnularRingMm,
    })) {
      if (value !== undefined && !finiteNonnegative(value)) {
        throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `${rule.id}.${label} must be finite and nonnegative.`);
      }
    }
    for (const transition of rule.allowedLayerTransitions ?? []) {
      if (
        transition.startLayer === transition.endLayer ||
        !layerSet.has(transition.startLayer) ||
        !layerSet.has(transition.endLayer)
      ) {
        throw new PcbPracticeAnalyzerError(
          "INVALID_PROFILE",
          `Via rule ${rule.id} contains an invalid or unknown layer transition.`,
        );
      }
    }
  }
  for (const [label, rule] of Object.entries({
    minimumTrackWidth: profile.fabrication?.minimumTrackWidth,
    minimumTraceToBoardEdge: profile.fabrication?.minimumTraceToBoardEdge,
  })) {
    if (rule !== undefined && !finiteNonnegative(rule.minimumMm)) {
      throw new PcbPracticeAnalyzerError("INVALID_PROFILE", `fabrication.${label}.minimumMm must be finite and nonnegative.`);
    }
  }
}

function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineColumn(starts: readonly number[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - starts[lineIndex]! + 1 };
}

function parseSExpressionDocument(source: string): SExpressionNode {
  if (source.length > MAX_SOURCE_CHARACTERS) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB source exceeds the parser size limit.");
  }
  let cursor = 0;
  let nodeCount = 0;
  const skipWhitespace = (): void => {
    while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  };
  const parseAtom = (): SExpressionAtom => {
    const start = cursor;
    if (source[cursor] === '"') {
      cursor += 1;
      let value = "";
      let closed = false;
      while (cursor < source.length) {
        const character = source[cursor]!;
        cursor += 1;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (cursor >= source.length) break;
          const escaped = source[cursor]!;
          cursor += 1;
          const decodedEscapes: Readonly<Record<string, string>> = {
            "\\": "\\",
            '"': '"',
            n: "\n",
            r: "\r",
            t: "\t",
          };
          const decoded = decodedEscapes[escaped];
          if (decoded === undefined) {
            throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Unsupported escape in KiCad string token.");
          }
          value += decoded;
        } else value += character;
        if (value.length > MAX_TOKEN_CHARACTERS) {
          throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad string token exceeds the parser limit.");
        }
      }
      if (!closed) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Unterminated KiCad string token.");
      return { value, quoted: true, start, end: cursor };
    }
    while (cursor < source.length && !/[\s()]/u.test(source[cursor]!)) {
      cursor += 1;
      if (cursor - start > MAX_TOKEN_CHARACTERS) {
        throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad atom token exceeds the parser limit.");
      }
    }
    if (cursor === start) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Expected a KiCad atom token.");
    return { value: source.slice(start, cursor), quoted: false, start, end: cursor };
  };
  const parseNode = (depth: number): SExpressionNode => {
    if (depth > MAX_S_EXPRESSION_DEPTH) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB nesting exceeds the parser limit.");
    }
    if (source[cursor] !== "(") throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Expected an opening parenthesis.");
    const start = cursor;
    cursor += 1;
    skipWhitespace();
    if (cursor >= source.length || source[cursor] === ")" || source[cursor] === "(") {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad form is missing its token name.");
    }
    const name = parseAtom();
    if (name.quoted) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad form token names cannot be quoted.");
    nodeCount += 1;
    if (nodeCount > MAX_S_EXPRESSION_NODES) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB form count exceeds the parser limit.");
    }
    const values: SExpressionAtom[] = [];
    const children: SExpressionNode[] = [];
    while (true) {
      skipWhitespace();
      if (cursor >= source.length) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `Unterminated ${name.value} form.`);
      if (source[cursor] === ")") {
        cursor += 1;
        return { name: name.value, values, children, start, end: cursor };
      }
      if (source[cursor] === "(") children.push(parseNode(depth + 1));
      else values.push(parseAtom());
    }
  };
  skipWhitespace();
  if (source[cursor] !== "(") throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB must contain one root S-expression.");
  const root = parseNode(1);
  skipWhitespace();
  if (cursor !== source.length) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Trailing content follows the KiCad PCB root S-expression.");
  }
  if (root.name !== "kicad_pcb") {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Root S-expression is not kicad_pcb.");
  }
  if (root.values.length !== 0) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB root contains unexpected positional atoms.");
  }
  for (const critical of ["version", "generator", "general", "layers", "setup"] as const) {
    if (root.children.filter((child) => child.name === critical).length > 1) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `KiCad PCB root contains duplicate ${critical} forms.`);
    }
  }
  return root;
}

function validateNativeSourceBinding(root: SExpressionNode, profile: PcbPracticeAnalysisProfile): void {
  const versionNode = childrenNamed(root, "version")[0];
  if (profile.sourceValidation.mode === "production" && root.children[0]?.name !== "version") {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Production KiCad PCB version header must be the first child form.");
  }
  if (versionNode === undefined) {
    if (profile.sourceValidation.mode === "production") {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Production KiCad PCB source is missing its version form.");
    }
  } else {
    if (
      versionNode.children.length !== 0 || versionNode.values.length !== 1 || versionNode.values[0]!.quoted ||
      !INTEGER_TOKEN.test(versionNode.values[0]!.value)
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB version form is malformed.");
    }
    const version = Number(versionNode.values[0]!.value);
    if (!Number.isSafeInteger(version) || !profile.sourceValidation.supportedBoardVersions.includes(version)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "KiCad PCB source version is outside the explicitly supported set.");
    }
  }
  const layersNode = childrenNamed(root, "layers")[0];
  if (layersNode === undefined) {
    if (profile.sourceValidation.mode === "production") {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Production KiCad PCB source is missing its native layer table.");
    }
    return;
  }
  if (layersNode.values.length !== 0) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native layer table contains unexpected scalar values.");
  }
  const ordinals = new Set<number>();
  const names = new Set<string>();
  const copperLayers: string[] = [];
  for (const layer of layersNode.children) {
    if (!INTEGER_TOKEN.test(layer.name) || layer.values.length < 2 || !layer.values[0]!.quoted) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native layer-table row is malformed.");
    }
    const ordinal = Number(layer.name);
    const name = layer.values[0]!.value;
    if (!Number.isSafeInteger(ordinal) || ordinals.has(ordinal) || names.has(name)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native layer table contains an unsafe or duplicate layer identity.");
    }
    ordinals.add(ordinal);
    names.add(name);
    if (name.endsWith(".Cu")) copperLayers.push(name);
  }
  if (
    copperLayers.length !== profile.copperLayerOrder.length ||
    copperLayers.some((layer, index) => layer !== profile.copperLayerOrder[index])
  ) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native copper-layer table does not equal the bound profile stack order.");
  }
}

const childrenNamed = (node: SExpressionNode, name: string): readonly SExpressionNode[] =>
  node.children.filter((child) => child.name === name);

function assertUniqueCriticalChildren(node: SExpressionNode, names: readonly string[], label: string): void {
  for (const name of names) {
    if (childrenNamed(node, name).length > 1) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${label} contains duplicate ${name} fields.`);
    }
  }
}

function childValue(node: SExpressionNode, field: string): SExpressionAtom | null {
  const child = childrenNamed(node, field)[0];
  return child !== undefined && child.values.length === 1 && child.children.length === 0
    ? child.values[0]!
    : null;
}

function numberField(node: SExpressionNode, field: string): number | null {
  const atom = childValue(node, field);
  if (atom === null || atom.quoted || !DECIMAL_TOKEN.test(atom.value)) return null;
  const value = Number(atom.value);
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_GEOMETRY_MM ? value : null;
}

function pointField(node: SExpressionNode, field: string): PcbPoint | null {
  const child = childrenNamed(node, field)[0];
  if (child === undefined || child.children.length !== 0 || child.values.length !== 2) return null;
  if (child.values.some((atom) => atom.quoted || !DECIMAL_TOKEN.test(atom.value))) return null;
  const [x, y] = child.values.map((atom) => Number(atom.value));
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) &&
    Math.abs(x) <= MAX_ABSOLUTE_GEOMETRY_MM && Math.abs(y) <= MAX_ABSOLUTE_GEOMETRY_MM
    ? { x, y }
    : null;
}

function pointNode(node: SExpressionNode): PcbPoint | null {
  if (node.children.length !== 0 || node.values.length !== 2) return null;
  if (node.values.some((atom) => atom.quoted || !DECIMAL_TOKEN.test(atom.value))) return null;
  const x = Number(node.values[0]!.value);
  const y = Number(node.values[1]!.value);
  return Number.isFinite(x) && Number.isFinite(y) &&
    Math.abs(x) <= MAX_ABSOLUTE_GEOMETRY_MM && Math.abs(y) <= MAX_ABSOLUTE_GEOMETRY_MM
    ? { x, y }
    : null;
}

function layerField(node: SExpressionNode): string | null {
  const atom = childValue(node, "layer");
  return atom?.value ?? null;
}

function identifierField(node: SExpressionNode): string | null {
  assertUniqueCriticalChildren(node, ["uuid", "tstamp"], node.name);
  const uuidNode = childrenNamed(node, "uuid")[0];
  const timestampNode = childrenNamed(node, "tstamp")[0];
  const uuid = childValue(node, "uuid")?.value;
  const timestamp = childValue(node, "tstamp")?.value;
  if ((uuidNode !== undefined && uuid === undefined) || (timestampNode !== undefined && timestamp === undefined)) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${node.name} contains a malformed identity field.`);
  }
  if (uuid !== undefined && timestamp !== undefined) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${node.name} contains both uuid and legacy tstamp identities.`);
  }
  const identity = uuid ?? timestamp;
  if (identity !== undefined && identity.length === 0) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${node.name} contains an empty identity field.`);
  }
  return identity ?? null;
}

function assertAnalyzedIdentityUniqueness(root: SExpressionNode): void {
  const analyzedRootNames = new Set([
    "segment", "arc", "via", "gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly", "bezier", "gr_curve",
  ]);
  const nodes = [
    ...root.children.filter((node) => analyzedRootNames.has(node.name)),
    ...descendantNodes(root).filter((node) => node.name.startsWith("fp_") && layerField(node) === "Edge.Cuts"),
  ].sort((left, right) => left.start - right.start);
  const seen = new Map<string, SExpressionNode>();
  for (const node of nodes) {
    const identity = identifierField(node);
    if (identity === null) continue;
    if (seen.has(identity)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `Analyzed native items contain duplicate identity ${identity}.`);
    }
    seen.set(identity, node);
  }
}

function scanForms(
  root: SExpressionNode,
  source: string,
  name: string,
  sourcePath: string,
  starts: readonly number[],
): readonly LocatedForm[] {
  return childrenNamed(root, name).map((node, index) => {
    const position = lineColumn(starts, node.start);
    return {
      name,
      text: source.slice(node.start, node.end),
      node,
      start: node.start,
      end: node.end,
      location: {
        sourcePath,
        form: name,
        ordinal: index + 1,
        uuid: identifierField(node),
        startOffset: node.start,
        endOffset: node.end,
        line: position.line,
        column: position.column,
      },
    };
  });
}

function descendantNodes(root: SExpressionNode): readonly SExpressionNode[] {
  const result: SExpressionNode[] = [];
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return result;
}

function locatedFormsFromNodes(
  nodes: readonly SExpressionNode[],
  source: string,
  sourcePath: string,
  starts: readonly number[],
): readonly LocatedForm[] {
  const ordinals = new Map<string, number>();
  return [...nodes]
    .sort((left, right) => left.start - right.start)
    .map((node) => {
      const ordinal = (ordinals.get(node.name) ?? 0) + 1;
      ordinals.set(node.name, ordinal);
      const position = lineColumn(starts, node.start);
      return {
        name: node.name,
        text: source.slice(node.start, node.end),
        node,
        start: node.start,
        end: node.end,
        location: {
          sourcePath,
          form: node.name,
          ordinal,
          uuid: identifierField(node),
          startOffset: node.start,
          endOffset: node.end,
          line: position.line,
          column: position.column,
        },
      };
    });
}

function netNameFromForm(node: SExpressionNode, numericNets: ReadonlyMap<number, string>): string | null {
  const atom = childValue(node, "net");
  if (atom === null || atom.value.length === 0) return null;
  if (atom.quoted) return atom.value;
  if (!INTEGER_TOKEN.test(atom.value)) return null;
  const id = Number(atom.value);
  if (!Number.isSafeInteger(id)) return null;
  const resolved = numericNets.get(id);
  return resolved === undefined || resolved.length === 0 ? null : resolved;
}

function assertNetReferenceSyntax(node: SExpressionNode, label: string): void {
  const net = childrenNamed(node, "net")[0];
  if (net === undefined) return;
  if (net.children.length !== 0 || net.values.length !== 1) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${label} has malformed net reference syntax.`);
  }
  const atom = net.values[0]!;
  if (!atom.quoted && !INTEGER_TOKEN.test(atom.value)) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${label} net ordinal must be an unsigned decimal integer.`);
  }
  if (!atom.quoted && !Number.isSafeInteger(Number(atom.value))) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${label} net ordinal exceeds the safe integer range.`);
  }
}

function evidence(
  role: string,
  location: PcbEvidenceLocation,
  geometry: Readonly<Record<string, unknown>>,
): PcbFindingEvidence {
  return { role, location, geometry };
}

const distance = (left: PcbPoint, right: PcbPoint): number =>
  Math.hypot(right.x - left.x, right.y - left.y);

const subtract = (left: PcbPoint, right: PcbPoint): PcbPoint =>
  ({ x: left.x - right.x, y: left.y - right.y });

const dot = (left: PcbPoint, right: PcbPoint): number => left.x * right.x + left.y * right.y;

const cross = (left: PcbPoint, right: PcbPoint): number => left.x * right.y - left.y * right.x;

function clampedPointOnSegment(point: PcbPoint, start: PcbPoint, end: PcbPoint): PcbPoint {
  const vector = subtract(end, start);
  const lengthSquared = dot(vector, vector);
  if (lengthSquared === 0) return start;
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), vector) / lengthSquared));
  return { x: start.x + t * vector.x, y: start.y + t * vector.y };
}

function pointToSegmentDistance(point: PcbPoint, start: PcbPoint, end: PcbPoint): number {
  return distance(point, clampedPointOnSegment(point, start, end));
}

function segmentsIntersect(a: PcbPoint, b: PcbPoint, c: PcbPoint, d: PcbPoint, tolerance: number): boolean {
  const first = subtract(b, a);
  const second = subtract(d, c);
  const denominator = cross(first, second);
  const scale = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
  if (scale === 0) return distance(a, c) <= tolerance;
  if (Math.abs(denominator) > DIMENSIONLESS_EPSILON * scale) {
    const fromFirst = subtract(c, a);
    const t = cross(fromFirst, second) / denominator;
    const u = cross(fromFirst, first) / denominator;
    return t >= -DIMENSIONLESS_EPSILON && t <= 1 + DIMENSIONLESS_EPSILON &&
      u >= -DIMENSIONLESS_EPSILON && u <= 1 + DIMENSIONLESS_EPSILON;
  }
  return pointToSegmentDistance(a, c, d) <= tolerance ||
    pointToSegmentDistance(b, c, d) <= tolerance ||
    pointToSegmentDistance(c, a, b) <= tolerance ||
    pointToSegmentDistance(d, a, b) <= tolerance;
}

function segmentToSegmentDistance(a: PcbPoint, b: PcbPoint, c: PcbPoint, d: PcbPoint, tolerance: number): number {
  if (segmentsIntersect(a, b, c, d, tolerance)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  );
}

interface PointClusters {
  readonly clusterByIndex: readonly number[];
  readonly clusters: readonly {
    readonly id: number;
    readonly point: PcbPoint;
    readonly memberIndices: readonly number[];
  }[];
}

function clusterPoints(points: readonly PcbPoint[], tolerance: number): PointClusters {
  const parents = points.map((_point, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parents[rightRoot] = leftRoot;
    else parents[leftRoot] = rightRoot;
  };
  const grid = new Map<string, number[]>();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const cellX = Math.floor(point.x / tolerance);
    const cellY = Math.floor(point.y / tolerance);
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        for (const candidate of grid.get(`${cellX + xOffset},${cellY + yOffset}`) ?? []) {
          if (distance(point, points[candidate]!) <= tolerance) unite(index, candidate);
        }
      }
    }
    const key = `${cellX},${cellY}`;
    const bucket = grid.get(key) ?? [];
    bucket.push(index);
    grid.set(key, bucket);
  }
  const membersByRoot = new Map<number, number[]>();
  for (let index = 0; index < points.length; index += 1) {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(index);
    membersByRoot.set(root, members);
  }
  const sortedGroups = [...membersByRoot.values()].sort((left, right) => left[0]! - right[0]!);
  const clusterByIndex = Array.from({ length: points.length }, () => -1);
  const clusters = sortedGroups.map((members, id) => {
    const point = {
      x: members.reduce((sum, index) => sum + points[index]!.x, 0) / members.length,
      y: members.reduce((sum, index) => sum + points[index]!.y, 0) / members.length,
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Endpoint clustering produced a non-finite representative.");
    }
    for (const member of members) clusterByIndex[member] = id;
    return { id, point, memberIndices: members };
  });
  return { clusterByIndex, clusters };
}

const normalizeRadians = (value: number): number => {
  const full = Math.PI * 2;
  return ((value % full) + full) % full;
};

const ccwDelta = (from: number, to: number): number =>
  normalizeRadians(to - from);

function angleOnArc(angle: number, startAngle: number, endAngle: number, clockwise: boolean, toleranceRad = 1e-10): boolean {
  return clockwise
    ? ccwDelta(endAngle, angle) <= ccwDelta(endAngle, startAngle) + toleranceRad
    : ccwDelta(startAngle, angle) <= ccwDelta(startAngle, endAngle) + toleranceRad;
}

function pointOnCircle(center: PcbPoint, radius: number, angle: number): PcbPoint {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

function pointToArcDistance(point: PcbPoint, edge: AtomicEdge): number {
  const center = edge.center!;
  const radius = edge.radiusMm!;
  if (edge.kind === "circle") return Math.abs(distance(point, center) - radius);
  const pointAngle = Math.atan2(point.y - center.y, point.x - center.x);
  const startAngle = Math.atan2(edge.start!.y - center.y, edge.start!.x - center.x);
  const endAngle = Math.atan2(edge.end!.y - center.y, edge.end!.x - center.x);
  if (angleOnArc(pointAngle, startAngle, endAngle, edge.clockwise!)) {
    return Math.abs(distance(point, center) - radius);
  }
  return Math.min(distance(point, edge.start!), distance(point, edge.end!));
}

function segmentToArcDistance(start: PcbPoint, end: PcbPoint, edge: AtomicEdge, tolerance: number): number {
  const center = edge.center!;
  const radius = edge.radiusMm!;
  const candidates = [pointToArcDistance(start, edge), pointToArcDistance(end, edge)];
  if (edge.kind === "arc") {
    candidates.push(pointToSegmentDistance(edge.start!, start, end), pointToSegmentDistance(edge.end!, start, end));
  }
  const vector = subtract(end, start);
  const vectorLength = Math.hypot(vector.x, vector.y);
  if (vectorLength > 0) {
    const a = dot(vector, vector);
    const fromCenter = subtract(start, center);
    const b = 2 * dot(fromCenter, vector);
    const c = dot(fromCenter, fromCenter) - radius * radius;
    const discriminant = b * b - 4 * a * c;
    const discriminantError = Number.EPSILON * 64 * (Math.abs(b * b) + Math.abs(4 * a * c) + 1);
    if (discriminant >= -discriminantError) {
      const root = Math.sqrt(Math.max(0, discriminant));
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t >= -DIMENSIONLESS_EPSILON && t <= 1 + DIMENSIONLESS_EPSILON) {
          const intersection = { x: start.x + t * vector.x, y: start.y + t * vector.y };
          const angle = Math.atan2(intersection.y - center.y, intersection.x - center.x);
          if (edge.kind === "circle" || angleOnArc(
            angle,
            Math.atan2(edge.start!.y - center.y, edge.start!.x - center.x),
            Math.atan2(edge.end!.y - center.y, edge.end!.x - center.x),
            edge.clockwise!,
          )) return 0;
        }
      }
    }
    const normal = { x: -vector.y / vectorLength, y: vector.x / vectorLength };
    for (const sign of [-1, 1] as const) {
      const circlePoint = {
        x: center.x + sign * normal.x * radius,
        y: center.y + sign * normal.y * radius,
      };
      const projected = clampedPointOnSegment(circlePoint, start, end);
      const projectionIsInterior = distance(projected, start) > tolerance && distance(projected, end) > tolerance;
      const angle = Math.atan2(circlePoint.y - center.y, circlePoint.x - center.x);
      if (projectionIsInterior && (edge.kind === "circle" || angleOnArc(
        angle,
        Math.atan2(edge.start!.y - center.y, edge.start!.x - center.x),
        Math.atan2(edge.end!.y - center.y, edge.end!.x - center.x),
        edge.clockwise!,
      ))) candidates.push(distance(circlePoint, projected));
    }
  }
  return Math.min(...candidates);
}

function circumcircle(start: PcbPoint, middle: PcbPoint, end: PcbPoint, tolerance: number): {
  readonly center: PcbPoint;
  readonly radius: number;
  readonly clockwise: boolean;
} | null {
  const toMiddle = subtract(middle, start);
  const toEnd = subtract(end, start);
  const scale = Math.hypot(toMiddle.x, toMiddle.y) * Math.hypot(toEnd.x, toEnd.y);
  const determinant = 2 * cross(toMiddle, toEnd);
  if (!Number.isFinite(scale) || scale <= tolerance * tolerance ||
      Math.abs(determinant) <= DIMENSIONLESS_EPSILON * scale) return null;
  const middleSquared = dot(toMiddle, toMiddle);
  const endSquared = dot(toEnd, toEnd);
  const center = {
    x: start.x + (middleSquared * toEnd.y - endSquared * toMiddle.y) / determinant,
    y: start.y + (toMiddle.x * endSquared - toEnd.x * middleSquared) / determinant,
  };
  const radius = distance(center, start);
  if (
    !Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(radius) ||
    Math.abs(center.x) > MAX_ABSOLUTE_GEOMETRY_MM || Math.abs(center.y) > MAX_ABSOLUTE_GEOMETRY_MM ||
    !(radius > tolerance) || radius > MAX_ABSOLUTE_GEOMETRY_MM
  ) return null;
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const middleAngle = Math.atan2(middle.y - center.y, middle.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const clockwise = ccwDelta(startAngle, middleAngle) > ccwDelta(startAngle, endAngle);
  return { center, radius, clockwise };
}

function orientedEdgeSamples(oriented: OrientedAtomicEdge): readonly PcbPoint[] {
  const edge = oriented.edge;
  if (edge.kind === "line") return oriented.reverse ? [edge.end!, edge.start!] : [edge.start!, edge.end!];
  const center = edge.center!;
  const radius = edge.radiusMm!;
  if (edge.kind === "circle") {
    const points: PcbPoint[] = [];
    for (let index = 0; index <= 72; index += 1) {
      points.push(pointOnCircle(center, radius, 2 * Math.PI * index / 72));
    }
    return points;
  }
  const start = oriented.reverse ? edge.end! : edge.start!;
  const end = oriented.reverse ? edge.start! : edge.end!;
  const clockwise = oriented.reverse ? !edge.clockwise! : edge.clockwise!;
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = clockwise ? -ccwDelta(endAngle, startAngle) : ccwDelta(startAngle, endAngle);
  const steps = Math.max(1, Math.min(720, Math.ceil(Math.abs(sweep) / (Math.PI / 36))));
  return Array.from({ length: steps + 1 }, (_unused, index) =>
    pointOnCircle(center, radius, startAngle + sweep * index / steps));
}

function circleBoundaryIntersectsEdge(circle: AtomicEdge, other: AtomicEdge, tolerance: number): boolean {
  const center = circle.center!;
  const radius = circle.radiusMm!;
  if (other.kind === "circle") {
    const centerDistance = distance(center, other.center!);
    const radiusSum = radius + other.radiusMm!;
    const radiusDifference = Math.abs(radius - other.radiusMm!);
    return centerDistance <= radiusSum + tolerance && centerDistance >= radiusDifference - tolerance;
  }
  if (other.kind === "line") {
    const minimumDistance = pointToSegmentDistance(center, other.start!, other.end!);
    const maximumEndpointDistance = Math.max(distance(center, other.start!), distance(center, other.end!));
    return minimumDistance <= radius + tolerance && maximumEndpointDistance >= radius - tolerance;
  }
  // Arc-outline topology is independently hard-marked incomplete in phase 1.
  return false;
}

function assembleOutlineLoops(
  edges: readonly AtomicEdge[],
  tolerance: number,
): {
  readonly loops: readonly OutlineLoop[];
  readonly invalidEndpoint: { readonly point: PcbPoint; readonly degree: number; readonly evidence: PcbEvidenceLocation } | null;
  readonly invalidReason: string | null;
} {
  const loops: OutlineLoop[] = [];
  assertPairwiseBound(edges.length, "Outline analytic topology analysis");
  for (let left = 0; left < edges.length; left += 1) {
    for (let right = left + 1; right < edges.length; right += 1) {
      const first = edges[left]!;
      const second = edges[right]!;
      if (
        (first.kind === "circle" && circleBoundaryIntersectsEdge(first, second, tolerance)) ||
        (second.kind === "circle" && circleBoundaryIntersectsEdge(second, first, tolerance))
      ) {
        return { loops: [], invalidEndpoint: null, invalidReason: "Circular outline boundaries intersect, overlap, or touch another boundary." };
      }
    }
  }
  const nonCircleIndices = edges.flatMap((edge, index) => edge.kind === "circle" ? [] : [index]);
  const endpointPoints = nonCircleIndices.flatMap((index) => [edges[index]!.start!, edges[index]!.end!]);
  const clusters = clusterPoints(endpointPoints, tolerance);
  const edgeClusters = new Map<number, readonly [number, number]>();
  const adjacency = new Map<number, number[]>();
  for (let position = 0; position < nonCircleIndices.length; position += 1) {
    const edgeIndex = nonCircleIndices[position]!;
    const pair: readonly [number, number] = [
      clusters.clusterByIndex[position * 2]!,
      clusters.clusterByIndex[position * 2 + 1]!,
    ];
    edgeClusters.set(edgeIndex, pair);
    for (const cluster of pair) {
      const incident = adjacency.get(cluster) ?? [];
      incident.push(edgeIndex);
      adjacency.set(cluster, incident);
    }
  }
  const invalidCluster = clusters.clusters.find((cluster) => (adjacency.get(cluster.id)?.length ?? 0) !== 2);
  if (invalidCluster !== undefined) {
    const edgeIndex = adjacency.get(invalidCluster.id)?.[0] ?? nonCircleIndices[0];
    return {
      loops: [],
      invalidEndpoint: {
        point: invalidCluster.point,
        degree: adjacency.get(invalidCluster.id)?.length ?? 0,
        evidence: edges[edgeIndex!]!.evidence,
      },
      invalidReason: null,
    };
  }
  const unvisited = new Set(nonCircleIndices);
  while (unvisited.size > 0) {
    let firstEdgeIndex = Number.POSITIVE_INFINITY;
    for (const edgeIndex of unvisited) firstEdgeIndex = Math.min(firstEdgeIndex, edgeIndex);
    const initialCluster = edgeClusters.get(firstEdgeIndex)![0];
    let currentCluster = initialCluster;
    let currentEdgeIndex = firstEdgeIndex;
    const orientedEdges: OrientedAtomicEdge[] = [];
    while (true) {
      if (!unvisited.has(currentEdgeIndex)) {
        return { loops: [], invalidEndpoint: null, invalidReason: "Outline traversal revisited an edge before closing." };
      }
      unvisited.delete(currentEdgeIndex);
      const pair = edgeClusters.get(currentEdgeIndex)!;
      const reverse = pair[1] === currentCluster;
      if (!reverse && pair[0] !== currentCluster) {
        return { loops: [], invalidEndpoint: null, invalidReason: "Outline traversal lost endpoint connectivity." };
      }
      orientedEdges.push({ edge: edges[currentEdgeIndex]!, reverse });
      currentCluster = reverse ? pair[0] : pair[1];
      if (currentCluster === initialCluster) break;
      const next = (adjacency.get(currentCluster) ?? []).find((edgeIndex) => unvisited.has(edgeIndex));
      if (next === undefined) {
        return { loops: [], invalidEndpoint: null, invalidReason: "Outline traversal ended before closing." };
      }
      currentEdgeIndex = next;
    }
    const polyline: PcbPoint[] = [];
    for (const oriented of orientedEdges) {
      const samples = orientedEdgeSamples(oriented);
      if (polyline.length === 0) polyline.push(...samples);
      else polyline.push(...samples.slice(1));
    }
    if (polyline.length < 4 || distance(polyline[0]!, polyline.at(-1)!) > tolerance) {
      return { loops: [], invalidEndpoint: null, invalidReason: "Outline loop did not produce a closed finite polyline." };
    }
    polyline[polyline.length - 1] = polyline[0]!;
    loops.push({ edges: orientedEdges, polyline });
  }
  for (const edge of edges) {
    if (edge.kind === "circle") loops.push({ edges: [{ edge, reverse: false }], polyline: orientedEdgeSamples({ edge, reverse: false }) });
  }
  if (loops.reduce((sum, loop) => sum + loop.polyline.length, 0) > 100_000) {
    return { loops: [], invalidEndpoint: null, invalidReason: "Flattened outline exceeds the phase-1 complexity bound." };
  }
  for (const loop of loops) {
    let twiceArea = 0;
    for (let index = 0; index < loop.polyline.length - 1; index += 1) {
      twiceArea += cross(loop.polyline[index]!, loop.polyline[index + 1]!);
    }
    if (!Number.isFinite(twiceArea) || Math.abs(twiceArea) <= tolerance * tolerance * 2) {
      return { loops: [], invalidEndpoint: null, invalidReason: "Outline contains a zero-area or numerically invalid loop." };
    }
  }
  const flattenedSegments = loops.flatMap((loop, loopIndex) =>
    loop.polyline.slice(0, -1).map((start, segmentIndex) => ({
      start,
      end: loop.polyline[segmentIndex + 1]!,
      loopIndex,
      segmentIndex,
      segmentCount: loop.polyline.length - 1,
    }))
  );
  const comparisonCount = flattenedSegments.length * (flattenedSegments.length - 1) / 2;
  if (comparisonCount > 5_000_000) {
    return { loops: [], invalidEndpoint: null, invalidReason: "Outline intersection analysis exceeds the phase-1 comparison bound." };
  }
  for (let left = 0; left < flattenedSegments.length; left += 1) {
    const first = flattenedSegments[left]!;
    for (let right = left + 1; right < flattenedSegments.length; right += 1) {
      const second = flattenedSegments[right]!;
      if (first.loopIndex === second.loopIndex) {
        const difference = Math.abs(first.segmentIndex - second.segmentIndex);
        if (difference === 1 || difference === first.segmentCount - 1) continue;
      }
      if (segmentsIntersect(first.start, first.end, second.start, second.end, tolerance)) {
        return { loops: [], invalidEndpoint: null, invalidReason: "Outline loops self-intersect, overlap, or touch another loop." };
      }
    }
  }
  return { loops, invalidEndpoint: null, invalidReason: null };
}

function parseEdges(
  root: SExpressionNode,
  source: string,
  sourcePath: string,
  starts: readonly number[],
  tolerance: number,
  findings: MutableFinding[],
  profile: PcbPracticeAnalysisProfile,
): OutlineModel {
  const edges: AtomicEdge[] = [];
  let complete = true;
  const invalid = (form: LocatedForm, message: string): void => {
    complete = false;
    findings.push({
      sortOffset: form.start,
      code: "BOARD_OUTLINE_GEOMETRY_INVALID",
      severity: "error",
      message,
      sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
      evidence: [evidence("outline", form.location, {})],
      observed: {},
      required: { nativeEdgeGeometry: "finite and analyzable" },
      assumptions: [],
      gates: ["human-review", "fabricator-confirmation"],
    });
  };
  const allowedEdgeChildren: Readonly<Record<string, ReadonlySet<string>>> = {
    gr_line: new Set(["start", "end", "stroke", "width", "layer", "locked", "uuid", "tstamp"]),
    gr_arc: new Set(["start", "mid", "end", "stroke", "width", "layer", "locked", "uuid", "tstamp"]),
    gr_circle: new Set(["center", "end", "stroke", "width", "layer", "fill", "locked", "uuid", "tstamp"]),
    gr_rect: new Set(["start", "end", "stroke", "width", "layer", "fill", "locked", "uuid", "tstamp"]),
    gr_poly: new Set(["pts", "stroke", "width", "layer", "fill", "locked", "uuid", "tstamp"]),
  };
  for (const name of ["gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly"] as const) {
    for (const form of scanForms(root, source, name, sourcePath, starts)) {
      if (layerField(form.node) !== "Edge.Cuts") continue;
      if (form.node.values.length !== 0) {
        throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${name} contains unexpected positional atoms.`);
      }
      if (form.node.children.some((child) => !allowedEdgeChildren[name]!.has(child.name))) {
        throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${name} contains an unknown direct child form.`);
      }
      if (name === "gr_line") {
        assertUniqueCriticalChildren(form.node, ["start", "end", "layer"], "Edge.Cuts line");
        const start = pointField(form.node, "start");
        const end = pointField(form.node, "end");
        if (start === null || end === null || distance(start, end) <= tolerance) {
          invalid(form, "Edge.Cuts line is missing distinct finite endpoints.");
        } else edges.push({ kind: "line", start, end, center: null, radiusMm: null, clockwise: null, evidence: form.location });
      } else if (name === "gr_arc") {
        assertUniqueCriticalChildren(form.node, ["start", "mid", "end", "layer"], "Edge.Cuts arc");
        const start = pointField(form.node, "start");
        const middle = pointField(form.node, "mid");
        const end = pointField(form.node, "end");
        const circle = start !== null && middle !== null && end !== null
          ? circumcircle(start, middle, end, tolerance)
          : null;
        if (start === null || end === null || circle === null || !(circle.radius > tolerance)) {
          invalid(form, "Edge.Cuts arc is missing a non-collinear start/mid/end geometry.");
        } else {
          edges.push({
            kind: "arc",
            start,
            end,
            center: circle.center,
            radiusMm: circle.radius,
            clockwise: circle.clockwise,
            evidence: form.location,
          });
          complete = false;
          findings.push({
            sortOffset: form.start,
            code: "BOARD_OUTLINE_ARC_TOPOLOGY_UNSUPPORTED",
            severity: "error",
            message: "Arc Edge.Cuts distance is extracted, but phase-1 analytic arc-to-arc topology validation is incomplete.",
            sourceRuleIds: [profile.diagnostics.unsupportedOutlineSourceRuleId],
            evidence: [evidence("outline-arc", form.location, { start, mid: middle, end })],
            observed: { arcOutline: true },
            required: { completeAnalyticOutlineTopology: true },
            assumptions: ["No closed-outline or containment pass is inferred from tessellated arc topology."],
            gates: ["human-review", "fabricator-confirmation"],
          });
        }
      } else if (name === "gr_circle") {
        assertUniqueCriticalChildren(form.node, ["center", "end", "layer"], "Edge.Cuts circle");
        const center = pointField(form.node, "center");
        const end = pointField(form.node, "end");
        const radius = center !== null && end !== null ? distance(center, end) : 0;
        if (center === null || end === null || !Number.isFinite(radius) || radius <= tolerance || radius > MAX_ABSOLUTE_GEOMETRY_MM) {
          invalid(form, "Edge.Cuts circle is missing a positive finite radius.");
        } else edges.push({ kind: "circle", start: null, end: null, center, radiusMm: radius, clockwise: null, evidence: form.location });
      } else if (name === "gr_rect") {
        assertUniqueCriticalChildren(form.node, ["start", "end", "layer"], "Edge.Cuts rectangle");
        const start = pointField(form.node, "start");
        const end = pointField(form.node, "end");
        if (start === null || end === null || Math.abs(start.x - end.x) <= tolerance || Math.abs(start.y - end.y) <= tolerance) {
          invalid(form, "Edge.Cuts rectangle is missing a positive two-dimensional extent.");
        } else {
          const points = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
          for (let index = 0; index < points.length; index += 1) {
            edges.push({
              kind: "line",
              start: points[index]!,
              end: points[(index + 1) % points.length]!,
              center: null,
              radiusMm: null,
              clockwise: null,
              evidence: form.location,
            });
          }
        }
      } else {
        assertUniqueCriticalChildren(form.node, ["pts", "layer"], "Edge.Cuts polygon");
        const pointsNode = childrenNamed(form.node, "pts")[0];
        const points = pointsNode?.children.filter((child) => child.name === "xy").map(pointNode) ?? [];
        if (
          pointsNode === undefined || pointsNode.values.length !== 0 ||
          pointsNode.children.some((child) => child.name !== "xy") ||
          points.length < 3 || points.some((point) => point === null)
        ) {
          invalid(form, "Edge.Cuts polygon has fewer than three finite vertices.");
        } else {
          const finitePoints = points as PcbPoint[];
          if (finitePoints.length > MAX_OUTLINE_ATOMIC_EDGES) {
            throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Edge.Cuts polygon exceeds the phase-1 vertex bound.");
          }
          for (let index = 0; index < finitePoints.length; index += 1) {
            edges.push({
              kind: "line",
              start: finitePoints[index]!,
              end: finitePoints[(index + 1) % finitePoints.length]!,
              center: null,
              radiusMm: null,
              clockwise: null,
              evidence: form.location,
            });
          }
        }
      }
    }
  }
  if (edges.length > MAX_OUTLINE_ATOMIC_EDGES) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Atomic Edge.Cuts count exceeds the phase-1 bound.");
  }
  const supportedRootNames = new Set(["gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly"]);
  const unsupportedNodes = [
    ...root.children.filter((node) => layerField(node) === "Edge.Cuts" && !supportedRootNames.has(node.name)),
    ...descendantNodes(root).filter((node) => node.name.startsWith("fp_") && layerField(node) === "Edge.Cuts"),
  ];
  const uniqueUnsupported = [...new Map(unsupportedNodes.map((node) => [node.start, node])).values()];
  for (const form of locatedFormsFromNodes(uniqueUnsupported, source, sourcePath, starts)) {
    complete = false;
    findings.push({
      sortOffset: form.start,
      code: "BOARD_OUTLINE_GEOMETRY_UNSUPPORTED",
      severity: "error",
      message: `${form.name} on Edge.Cuts is outside the phase-1 native outline parser; edge-clearance and containment conclusions are incomplete.`,
      sourceRuleIds: [profile.diagnostics.unsupportedOutlineSourceRuleId],
      evidence: [evidence("unsupported-outline", form.location, { form: form.name })],
      observed: { form: form.name },
      required: { supportedRootForms: ["gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly"] },
      assumptions: ["Footprint-local geometry requires footprint rotation/translation before distance checks."],
      gates: ["human-review", "fabricator-confirmation"],
    });
  }
  if (edges.length === 0) {
    complete = false;
    findings.push({
      sortOffset: 0,
      code: "BOARD_OUTLINE_MISSING",
      severity: "error",
      message: "No supported Edge.Cuts boundary primitive was found; trace-to-edge clearance cannot pass.",
      sourceRuleIds: [profile.diagnostics.unsupportedOutlineSourceRuleId],
      evidence: [],
      observed: { edgePrimitiveCount: 0 },
      required: { closedNativeBoardOutline: true },
      assumptions: [],
      gates: ["human-review", "fabricator-confirmation"],
    });
  }
  const assembly = assembleOutlineLoops(edges, tolerance);
  if (assembly.invalidEndpoint !== null) {
    complete = false;
    const first = assembly.invalidEndpoint;
    findings.push({
      sortOffset: first.evidence.startOffset,
      code: "BOARD_OUTLINE_NOT_CLOSED",
      severity: "error",
      message: "Supported Edge.Cuts endpoints do not form only closed, degree-two boundary loops.",
      sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
      evidence: [evidence("outline-endpoint", first.evidence, { point: first.point, degree: first.degree })],
      observed: { point: first.point, degree: first.degree },
      required: { endpointDegree: 2 },
      assumptions: ["Endpoints are clustered only after a Euclidean distance check against the profile tolerance."],
      gates: ["human-review", "fabricator-confirmation"],
    });
  }
  if (assembly.invalidReason !== null) {
    complete = false;
    const firstEdge = edges[0];
    findings.push({
      sortOffset: firstEdge?.evidence.startOffset ?? 0,
      code: "BOARD_OUTLINE_TOPOLOGY_INVALID",
      severity: "error",
      message: assembly.invalidReason,
      sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
      evidence: firstEdge === undefined ? [] : [evidence("outline", firstEdge.evidence, {})],
      observed: { simpleClosedLoops: false },
      required: { finiteNonzeroAreaSimpleClosedLoops: true },
      assumptions: ["Closed loops must not self-intersect, overlap, or touch one another."],
      gates: ["human-review", "fabricator-confirmation"],
    });
  }
  return { edges, loops: complete ? assembly.loops : [], complete };
}

function resolveNetClass(
  netName: string | null,
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
): PcbNetClassPracticePolicy | null {
  if (netName === null) return null;
  const id = Object.hasOwn(profile.netClassByNet, netName)
    ? profile.netClassByNet[netName]
    : profile.defaultNetClassId;
  return id === undefined ? null : classes.get(id) ?? null;
}

function parseSegments(
  root: SExpressionNode,
  source: string,
  sourcePath: string,
  starts: readonly number[],
  numericNets: ReadonlyMap<number, string>,
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  tolerance: number,
  findings: MutableFinding[],
): PcbRoutedSegment[] {
  const result: PcbRoutedSegment[] = [];
  const forms = scanForms(root, source, "segment", sourcePath, starts);
  if (forms.length > MAX_ROUTED_OBJECTS_PER_KIND) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Routed segment count exceeds the phase-1 bound.");
  }
  for (const form of forms) {
    if (form.node.values.length !== 0) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "segment contains unexpected positional atoms.");
    }
    assertUniqueCriticalChildren(form.node, ["start", "end", "width", "layer", "net"], "segment");
    assertNetReferenceSyntax(form.node, "segment");
    const supportedSegmentChildren = new Set(["start", "end", "width", "layer", "locked", "net", "uuid", "tstamp"]);
    const unsupportedChildren = form.node.children.filter((child) => !supportedSegmentChildren.has(child.name));
    if (unsupportedChildren.length > 0) {
      findings.push({
        sortOffset: form.start,
        code: "ROUTED_SEGMENT_GEOMETRY_UNSUPPORTED",
        severity: "error",
        message: "Routed segment contains geometry-affecting or future fields outside the phase-1 allowlist.",
        sourceRuleIds: [profile.diagnostics.unsupportedRoutingSourceRuleId],
        evidence: [evidence("segment", form.location, {
          unsupportedForms: unsupportedChildren.map((child) => child.name),
        })],
        observed: { unsupportedForms: unsupportedChildren.map((child) => child.name) },
        required: { completeSegmentGeometryAnalysis: true },
        assumptions: [],
        gates: ["human-review", "fabricator-confirmation"],
      });
    }
    const start = pointField(form.node, "start");
    const end = pointField(form.node, "end");
    const width = numberField(form.node, "width");
    const layer = layerField(form.node);
    const netName = netNameFromForm(form.node, numericNets);
    if (
      start === null || end === null || width === null || layer === null || width <= 0 ||
      !profile.copperLayerOrder.includes(layer) || distance(start, end) <= tolerance
    ) {
      findings.push({
        sortOffset: form.start,
        code: "ROUTED_SEGMENT_GEOMETRY_INVALID",
        severity: "error",
        message: "Routed segment is missing a positive width, distinct endpoints, layer, or resolvable geometry.",
        sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
        evidence: [evidence("segment", form.location, { start, end, widthMm: width, layer })],
        observed: { start, end, widthMm: width, layer },
        required: { finitePositiveGeometry: true, layerInBoundCopperStack: true },
        assumptions: [],
        gates: ["human-review"],
      });
      continue;
    }
    const netClass = resolveNetClass(netName, profile, classes);
    result.push({
      ordinal: form.location.ordinal,
      uuid: form.location.uuid,
      start,
      end,
      widthMm: width,
      layer,
      netName,
      netClassId: netClass?.id ?? null,
      lengthMm: distance(start, end),
      clearanceToBoardEdgeMm: null,
      evidence: form.location,
    });
  }
  return result;
}

function parseRoutedArcs(
  root: SExpressionNode,
  source: string,
  sourcePath: string,
  starts: readonly number[],
  numericNets: ReadonlyMap<number, string>,
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  tolerance: number,
  findings: MutableFinding[],
): PcbRoutedArc[] {
  const arcs: PcbRoutedArc[] = [];
  const forms = scanForms(root, source, "arc", sourcePath, starts);
  if (forms.length > MAX_ROUTED_OBJECTS_PER_KIND) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Routed arc count exceeds the phase-1 bound.");
  }
  for (const form of forms) {
    if (form.node.values.length !== 0) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "routed arc contains unexpected positional atoms.");
    }
    const supportedArcChildren = new Set([
      "start", "mid", "end", "width", "layer", "locked", "net", "uuid", "tstamp",
    ]);
    if (form.node.children.some((child) => !supportedArcChildren.has(child.name))) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "routed arc contains an unknown direct child form.");
    }
    assertUniqueCriticalChildren(form.node, ["start", "mid", "end", "width", "layer", "net"], "routed arc");
    assertNetReferenceSyntax(form.node, "routed arc");
    const start = pointField(form.node, "start");
    const mid = pointField(form.node, "mid");
    const end = pointField(form.node, "end");
    const width = numberField(form.node, "width");
    const layer = layerField(form.node);
    const netName = netNameFromForm(form.node, numericNets);
    const circle = start !== null && mid !== null && end !== null
      ? circumcircle(start, mid, end, tolerance)
      : null;
    if (
      start === null || mid === null || end === null || width === null || width <= 0 ||
      layer === null || !profile.copperLayerOrder.includes(layer) || circle === null
    ) {
      findings.push({
        sortOffset: form.start,
        code: "ROUTED_ARC_GEOMETRY_INVALID",
        severity: "error",
        message: "Routed arc is missing finite non-collinear geometry, positive width, or a bound copper layer.",
        sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
        evidence: [evidence("routed-arc", form.location, { start, mid, end, widthMm: width, layer, netName })],
        observed: { start, mid, end, widthMm: width, layer, netName },
        required: { finiteNonCollinearGeometry: true, positiveWidth: true, layerInBoundCopperStack: true },
        assumptions: [],
        gates: ["human-review"],
      });
      continue;
    }
    const netClass = resolveNetClass(netName, profile, classes);
    const arc: PcbRoutedArc = {
      ordinal: form.location.ordinal,
      uuid: form.location.uuid,
      start,
      mid,
      end,
      widthMm: width,
      layer,
      netName,
      netClassId: netClass?.id ?? null,
      evidence: form.location,
    };
    arcs.push(arc);
    findings.push({
      sortOffset: form.start,
      code: "ROUTED_ARC_ANALYSIS_UNSUPPORTED",
      severity: "error",
      message: "Native routed arc was extracted, but phase-1 bend, containment, and edge-clearance coverage is incomplete.",
      sourceRuleIds: [profile.diagnostics.unsupportedRoutingSourceRuleId],
      evidence: [evidence("routed-arc", form.location, { start, mid, end, widthMm: width, layer, netName })],
      observed: { routedArc: true, netClassId: arc.netClassId },
      required: { completeRoutedArcAnalysis: true },
      assumptions: ["No pass is inferred from linear-segment checks when routed arcs are present."],
      gates: ["human-review", "fabricator-confirmation"],
    });
    if (netClass === null) {
      findings.push({
        sortOffset: form.start,
        code: "ROUTED_ARC_NET_CLASS_UNBOUND",
        severity: "error",
        message: "A routed arc has no resolvable exact/default net-class binding.",
        sourceRuleIds: [profile.diagnostics.unboundNetSourceRuleId],
        evidence: [evidence("routed-arc", form.location, { netName, layer })],
        observed: { netName, netClassId: null },
        required: { exactOrDefaultNetClassBinding: true },
        assumptions: [],
        gates: ["human-review"],
      });
    }
  }
  return arcs;
}

function analyzeUnsupportedCopperGraphics(
  root: SExpressionNode,
  source: string,
  sourcePath: string,
  starts: readonly number[],
  profile: PcbPracticeAnalysisProfile,
  findings: MutableFinding[],
): void {
  const graphicNames = new Set([
    "gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly", "bezier", "gr_curve", "gr_text", "gr_text_box",
  ]);
  const forms = locatedFormsFromNodes(
    root.children.filter((node) =>
      graphicNames.has(node.name) &&
      profile.copperLayerOrder.includes(layerField(node) ?? "")
    ),
    source,
    sourcePath,
    starts,
  );
  for (const form of forms) {
    findings.push({
      sortOffset: form.start,
      code: "COPPER_GRAPHIC_ROUTING_UNSUPPORTED",
      severity: "error",
      message: "A root graphic lies on a copper layer; phase-1 routed segment/via analysis does not cover graphic copper.",
      sourceRuleIds: [profile.diagnostics.unsupportedRoutingSourceRuleId],
      evidence: [evidence("copper-graphic", form.location, {
        form: form.name,
        layer: layerField(form.node),
        hasNetField: childrenNamed(form.node, "net").length > 0,
      })],
      observed: { form: form.name, layer: layerField(form.node) },
      required: { completeGraphicCopperAnalysis: true },
      assumptions: ["No electrical connectivity or clearance is inferred for graphic copper."],
      gates: ["human-review", "fabricator-confirmation"],
    });
  }
}

function effectiveGates(rule: PcbRuleDisposition, fabrication: boolean): readonly PcbPracticeGate[] {
  return uniqueSorted([
    ...(rule.gates ?? []),
    ...(fabrication ? ["fabricator-confirmation" as const] : []),
  ]);
}

function analyzeWidths(
  segments: readonly PcbRoutedSegment[],
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  findings: MutableFinding[],
): void {
  const reportedUnboundNets = new Set<string>();
  for (const segment of segments) {
    const netKey = segment.netName ?? "<unresolved>";
    if (segment.netClassId === null) {
      if (!reportedUnboundNets.has(netKey)) {
        reportedUnboundNets.add(netKey);
        findings.push({
          sortOffset: segment.evidence.startOffset,
          code: "ROUTED_NET_CLASS_UNBOUND",
          severity: "error",
          message: "A routed net has no exact/default net-class binding; width and bend compliance fail closed.",
          sourceRuleIds: [profile.diagnostics.unboundNetSourceRuleId],
          evidence: [evidence("first-segment-on-unbound-net", segment.evidence, {
            netName: segment.netName,
            layer: segment.layer,
          })],
          observed: { netName: segment.netName, netClassId: null },
          required: { exactOrDefaultNetClassBinding: true },
          assumptions: ["An unresolved numeric KiCad net ID is treated as unbound, not as an unnamed safe net."],
          gates: ["human-review"],
        });
      }
      continue;
    }
    const netClass = classes.get(segment.netClassId)!;
    const rules: WeightedRule[] = [{
      sourceRuleId: netClass.sourceRuleId,
      minimumMm: netClass.minimumTrackWidthMm,
      severity: netClass.severity,
      gates: effectiveGates(netClass, false),
    }];
    const fabRule = profile.fabrication?.minimumTrackWidth;
    if (fabRule !== undefined) rules.push({
      sourceRuleId: fabRule.sourceRuleId,
      minimumMm: fabRule.minimumMm,
      severity: fabRule.severity,
      gates: effectiveGates(fabRule, true),
    });
    const violated = rules.filter((rule) => segment.widthMm + 1e-12 < rule.minimumMm);
    if (violated.length === 0) continue;
    findings.push({
      sortOffset: segment.evidence.startOffset,
      code: "TRACK_WIDTH_BELOW_BOUND_MINIMUM",
      severity: strongestSeverity(violated.map((rule) => rule.severity)),
      message: "Routed segment width is below at least one bound net-class or fabricator-declared minimum.",
      sourceRuleIds: uniqueSorted(violated.map((rule) => rule.sourceRuleId)),
      evidence: [evidence("segment", segment.evidence, {
        start: segment.start,
        end: segment.end,
        widthMm: segment.widthMm,
        layer: segment.layer,
        netName: segment.netName,
      })],
      observed: { widthMm: segment.widthMm, netClassId: segment.netClassId },
      required: { minimumWidthMm: Math.max(...violated.map((rule) => rule.minimumMm)) },
      assumptions: [],
      gates: uniqueSorted(violated.flatMap((rule) => rule.gates)),
    });
  }
}

interface TrackOverlapAnalysis {
  readonly overlapPairs: ReadonlySet<string>;
  readonly duplicateOrdinals: ReadonlySet<number>;
}

const segmentPairKey = (left: PcbRoutedSegment, right: PcbRoutedSegment): string =>
  left.ordinal < right.ordinal ? `${left.ordinal}:${right.ordinal}` : `${right.ordinal}:${left.ordinal}`;

function analyzeOverlappingTracks(
  segments: readonly PcbRoutedSegment[],
  profile: PcbPracticeAnalysisProfile,
  tolerance: number,
  findings: MutableFinding[],
): TrackOverlapAnalysis {
  assertPairwiseBound(segments.length, "Routed segment overlap analysis");
  const overlapPairs = new Set<string>();
  const duplicateOrdinals = new Set<number>();
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]!;
    if (left.netName === null) continue;
    const leftVector = subtract(left.end, left.start);
    const leftLength = left.lengthMm;
    const unit = { x: leftVector.x / leftLength, y: leftVector.y / leftLength };
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex]!;
      if (left.netName !== right.netName || left.layer !== right.layer) continue;
      const rightVector = subtract(right.end, right.start);
      const angularCross = Math.abs(cross(leftVector, rightVector)) / (leftLength * right.lengthMm);
      if (angularCross > Math.max(DIMENSIONLESS_EPSILON, tolerance / Math.min(leftLength, right.lengthMm))) continue;
      const lineDistance = Math.max(
        Math.abs(cross(unit, subtract(right.start, left.start))),
        Math.abs(cross(unit, subtract(right.end, left.start))),
      );
      if (lineDistance > tolerance) continue;
      const leftInterval = [dot(left.start, unit), dot(left.end, unit)].sort((a, b) => a - b);
      const rightInterval = [dot(right.start, unit), dot(right.end, unit)].sort((a, b) => a - b);
      const overlapMm = Math.min(leftInterval[1]!, rightInterval[1]!) - Math.max(leftInterval[0]!, rightInterval[0]!);
      if (overlapMm <= tolerance) continue;
      const key = segmentPairKey(left, right);
      overlapPairs.add(key);
      const sameEndpoints =
        distance(left.start, right.start) <= tolerance && distance(left.end, right.end) <= tolerance ||
        distance(left.start, right.end) <= tolerance && distance(left.end, right.start) <= tolerance;
      if (sameEndpoints) duplicateOrdinals.add(right.ordinal);
      findings.push({
        sortOffset: Math.min(left.evidence.startOffset, right.evidence.startOffset),
        code: sameEndpoints ? "DUPLICATE_ROUTED_TRACK" : "OVERLAPPING_ROUTED_TRACKS",
        severity: "error",
        message: sameEndpoints
          ? "Two routed segments duplicate the same centerline geometry; duplicate geometry is excluded from bend/hairpin inference."
          : "Two routed segments overlap collinearly; the ambiguous overlap is excluded from bend/hairpin inference.",
        sourceRuleIds: [profile.diagnostics.duplicateTrackSourceRuleId],
        evidence: [left, right].map((segment) => evidence("overlapping-segment", segment.evidence, {
          start: segment.start, end: segment.end, widthMm: segment.widthMm,
        })),
        observed: { overlapMm, exactEndpointDuplicate: sameEndpoints },
        required: { uniqueNonoverlappingRoutedCenterlines: true },
        assumptions: ["Overlap comparison is limited to segments on the same resolved net and copper layer."],
        gates: ["human-review"],
      });
    }
  }
  return { overlapPairs, duplicateOrdinals };
}

function analyzeTurns(
  segments: readonly PcbRoutedSegment[],
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  tolerance: number,
  overlaps: TrackOverlapAnalysis,
  findings: MutableFinding[],
): PcbRoutedTurn[] {
  interface EndpointMember {
    readonly point: PcbPoint;
    readonly other: PcbPoint;
    readonly segment: PcbRoutedSegment;
  }
  const networks = new Map<string, EndpointMember[]>();
  for (const segment of segments) {
    if (segment.netName === null || overlaps.duplicateOrdinals.has(segment.ordinal)) continue;
    const key = `${segment.netName}\u0000${segment.layer}`;
    const members = networks.get(key) ?? [];
    members.push({ point: segment.start, other: segment.end, segment });
    members.push({ point: segment.end, other: segment.start, segment });
    networks.set(key, members);
  }
  const turns: PcbRoutedTurn[] = [];
  const unresolvedJunctionPairs = new Set<string>();
  const emitUnresolvedJunction = (
    junctionSegments: readonly PcbRoutedSegment[],
    observed: Readonly<Record<string, unknown>>,
  ): void => {
    const netClass = junctionSegments[0]!.netClassId === null
      ? null
      : classes.get(junctionSegments[0]!.netClassId) ?? null;
    if (netClass?.minimumInteriorAngleDeg === undefined) return;
    const disposition = netClass.interiorAngleDisposition!;
    findings.push({
      sortOffset: junctionSegments.reduce(
        (minimum, segment) => Math.min(minimum, segment.evidence.startOffset),
        Number.POSITIVE_INFINITY,
      ),
      code: "TURN_JUNCTION_COVERAGE_UNRESOLVED",
      severity: disposition.severity,
      message: "A tee, crossing, or multi-segment junction is not reducible to one sequential bend under the hard bend rule.",
      sourceRuleIds: uniqueSorted([disposition.sourceRuleId, profile.diagnostics.junctionCoverageSourceRuleId]),
      evidence: [...junctionSegments]
        .sort((left, right) => left.evidence.startOffset - right.evidence.startOffset)
        .map((segment) => evidence("junction-segment", segment.evidence, {
          start: segment.start, end: segment.end, netName: segment.netName, layer: segment.layer,
        })),
      observed,
      required: { fullyResolvedSequentialBends: true, minimumInteriorAngleDeg: netClass.minimumInteriorAngleDeg },
      assumptions: ["No compliant angle is inferred at a branched or interior-intersection junction."],
      gates: effectiveGates(disposition, false),
    });
  };
  for (const members of networks.values()) {
    assertPairwiseBound(members.length, "Routed endpoint clustering");
    const clustered = clusterPoints(members.map((member) => member.point), tolerance);
    for (const cluster of clustered.clusters) {
      const nodeMembers = cluster.memberIndices.map((index) => members[index]!);
      const uniqueMembers = [...new Map(nodeMembers.map((member) => [member.segment.ordinal, member])).values()];
      if (uniqueMembers.length > 2) {
        emitUnresolvedJunction(uniqueMembers.map((member) => member.segment), {
          vertex: cluster.point,
          connectedSegmentCount: uniqueMembers.length,
          kind: "endpoint-junction",
        });
        continue;
      }
      if (uniqueMembers.length !== 2) continue;
      const [firstMember, secondMember] = uniqueMembers as [EndpointMember, EndpointMember];
      const first = firstMember.segment;
      const second = secondMember.segment;
      if (overlaps.overlapPairs.has(segmentPairKey(first, second))) continue;
      const firstVector = subtract(firstMember.other, firstMember.point);
      const secondVector = subtract(secondMember.other, secondMember.point);
      const denominator = Math.hypot(firstVector.x, firstVector.y) * Math.hypot(secondVector.x, secondVector.y);
      if (denominator <= tolerance * tolerance) continue;
      // atan2 avoids acos amplifying roundoff near a straight continuation.
      // Endpoint vectors point outward, hence the negated dot for the turn.
    const directionChangeDeg = Math.atan2(Math.abs(cross(firstVector, secondVector)), -dot(firstVector, secondVector)) * DEG_PER_RAD;
    const interiorAngleDeg = 180 - directionChangeDeg;
    const classification: PcbTurnClassification =
      interiorAngleDeg <= profile.advisories.reversal.maximumInteriorAngleDeg + 1e-9
        ? "reversal-candidate"
        : Math.abs(interiorAngleDeg - 90) <= profile.advisories.rightAngle.toleranceDeg + 1e-9
          ? "right-angle"
          : interiorAngleDeg < 90
            ? "acute"
            : interiorAngleDeg < 180 - 1e-9
              ? "obtuse"
              : "straight";
    const netName = first.netName!;
    const netClass = first.netClassId === null ? null : classes.get(first.netClassId) ?? null;
    const turn: PcbRoutedTurn = {
      vertex: cluster.point,
      netName,
      netClassId: netClass?.id ?? null,
      layer: first.layer,
      segmentOrdinals: first.ordinal < second.ordinal
        ? [first.ordinal, second.ordinal]
        : [second.ordinal, first.ordinal],
      interiorAngleDeg,
      directionChangeDeg,
      classification,
    };
    turns.push(turn);
    const turnEvidence = [first, second]
      .sort((left, right) => left.evidence.startOffset - right.evidence.startOffset)
      .map((segment) => evidence("connected-segment", segment.evidence, {
        start: segment.start,
        end: segment.end,
        netName: segment.netName,
        layer: segment.layer,
      }));
    if (
      netClass?.minimumInteriorAngleDeg !== undefined &&
      interiorAngleDeg + 1e-9 < netClass.minimumInteriorAngleDeg
    ) {
      findings.push({
        sortOffset: Math.min(first.evidence.startOffset, second.evidence.startOffset),
        code: "TURN_BELOW_NET_CLASS_MINIMUM",
        severity: netClass.interiorAngleDisposition!.severity,
        message: "Connected routed segments form an interior bend below the bound net-class minimum.",
        sourceRuleIds: [netClass.interiorAngleDisposition!.sourceRuleId],
        evidence: turnEvidence,
        observed: { interiorAngleDeg, directionChangeDeg, classification, vertex: cluster.point },
        required: { minimumInteriorAngleDeg: netClass.minimumInteriorAngleDeg },
        assumptions: ["Only a degree-two, coincident endpoint on the same net and layer is classified as a sequential bend."],
        gates: effectiveGates(netClass.interiorAngleDisposition!, false),
      });
    } else if (classification === "right-angle") {
      findings.push({
        sortOffset: Math.min(first.evidence.startOffset, second.evidence.startOffset),
        code: "RIGHT_ANGLE_TURN_ADVISORY",
        severity: "advisory",
        message: "Connected routed segments form a nominal 90-degree interior turn; no hard failure is inferred without a stricter bound net-class rule.",
        sourceRuleIds: [profile.advisories.rightAngle.sourceRuleId],
        evidence: turnEvidence,
        observed: { interiorAngleDeg, directionChangeDeg, vertex: cluster.point },
        required: { disposition: "human review unless a bound class rule is stricter" },
        assumptions: ["The geometric classification alone does not establish an electrical or fabrication defect."],
        gates: ["human-review"],
      });
    } else if (classification === "reversal-candidate") {
      findings.push({
        sortOffset: Math.min(first.evidence.startOffset, second.evidence.startOffset),
        code: "CONNECTED_REVERSAL_CANDIDATE",
        severity: "advisory",
        message: "A true degree-two sequential route node reverses direction or overlaps; inspect for a hairpin or duplicate geometry.",
        sourceRuleIds: [profile.advisories.reversal.sourceRuleId],
        evidence: turnEvidence,
        observed: { interiorAngleDeg, directionChangeDeg, vertex: cluster.point },
        required: { maximumCandidateInteriorAngleDeg: profile.advisories.reversal.maximumInteriorAngleDeg },
        assumptions: ["Connectivity is established only by coincident same-net, same-layer segment endpoints."],
        gates: ["human-review"],
      });
      }
    }
  }
  const activeSegments = segments.filter((segment) =>
    segment.netName !== null && !overlaps.duplicateOrdinals.has(segment.ordinal)
  );
  assertPairwiseBound(activeSegments.length, "Routed interior-junction analysis");
  for (let leftIndex = 0; leftIndex < activeSegments.length; leftIndex += 1) {
    const left = activeSegments[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < activeSegments.length; rightIndex += 1) {
      const right = activeSegments[rightIndex]!;
      if (left.netName !== right.netName || left.layer !== right.layer ||
          overlaps.overlapPairs.has(segmentPairKey(left, right))) continue;
      const pairKey = segmentPairKey(left, right);
      const endpoints = [left.start, left.end];
      const endpointOnInterior = endpoints.some((point) =>
        pointToSegmentDistance(point, right.start, right.end) <= tolerance &&
        distance(point, right.start) > tolerance && distance(point, right.end) > tolerance
      ) || [right.start, right.end].some((point) =>
        pointToSegmentDistance(point, left.start, left.end) <= tolerance &&
        distance(point, left.start) > tolerance && distance(point, left.end) > tolerance
      );
      const endpointsCoincide = endpoints.some((point) =>
        distance(point, right.start) <= tolerance || distance(point, right.end) <= tolerance
      );
      const interiorCrossing = !endpointsCoincide && segmentsIntersect(
        left.start, left.end, right.start, right.end, tolerance,
      );
      if ((endpointOnInterior || interiorCrossing) && !unresolvedJunctionPairs.has(pairKey)) {
        unresolvedJunctionPairs.add(pairKey);
        emitUnresolvedJunction([left, right], {
          kind: endpointOnInterior ? "endpoint-on-segment-interior" : "interior-crossing",
        });
      }
    }
  }
  return turns.sort((left, right) =>
    left.segmentOrdinals[0] - right.segmentOrdinals[0] || left.segmentOrdinals[1] - right.segmentOrdinals[1]
  );
}

function viaType(node: SExpressionNode): PcbViaType | null {
  if (node.values.length === 0) return "through";
  if (node.values.length !== 1 || node.values[0]!.quoted) return null;
  const token = node.values[0]!.value;
  return token === "micro" || token === "blind" ? token : null;
}

function viaLayers(node: SExpressionNode): readonly [string, string] | null {
  const layers = childrenNamed(node, "layers")[0];
  return layers !== undefined && layers.children.length === 0 && layers.values.length === 2
    ? [layers.values[0]!.value, layers.values[1]!.value]
    : null;
}

function ruleAppliesToVia(rule: PcbViaPracticeRule, via: PcbViaGeometry): boolean {
  const applies = rule.appliesTo;
  if (applies === undefined) return true;
  if (applies.viaTypes !== undefined && !applies.viaTypes.includes(via.type)) return false;
  if (applies.netNames !== undefined && (via.netName === null || !applies.netNames.includes(via.netName))) return false;
  if (
    applies.netClassIds !== undefined &&
    (via.netClassId === null || !applies.netClassIds.includes(via.netClassId))
  ) return false;
  return true;
}

function sameLayerTransition(left: PcbLayerTransition, right: readonly [string, string]): boolean {
  return left.startLayer === right[0] && left.endLayer === right[1] ||
    left.startLayer === right[1] && left.endLayer === right[0];
}

function parseAndAnalyzeVias(
  root: SExpressionNode,
  source: string,
  sourcePath: string,
  starts: readonly number[],
  numericNets: ReadonlyMap<number, string>,
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  segments: readonly PcbRoutedSegment[],
  tolerance: number,
  findings: MutableFinding[],
): PcbViaGeometry[] {
  const vias: PcbViaGeometry[] = [];
  const allRules = [
    ...profile.viaRules.map((rule) => ({ rule, fabrication: false })),
    ...(profile.fabrication?.viaRules ?? []).map((rule) => ({ rule, fabrication: true })),
  ];
  const viaForms = scanForms(root, source, "via", sourcePath, starts);
  if (viaForms.length > MAX_ROUTED_OBJECTS_PER_KIND) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Via count exceeds the phase-1 bound.");
  }
  if (viaForms.length * Math.max(1, segments.length) > MAX_PAIRWISE_GEOMETRY_COMPARISONS) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Via-to-segment incidence analysis exceeds the phase-1 bound.");
  }
  const perViaRuleWork = allRules.reduce((sum, { rule }) => sum + 1 +
    (rule.appliesTo?.netClassIds?.length ?? 0) +
    (rule.appliesTo?.netNames?.length ?? 0) +
    (rule.appliesTo?.viaTypes?.length ?? 0) +
    (rule.allowedLayerTransitions?.length ?? 0), 0);
  if (viaForms.length * Math.max(1, perViaRuleWork) > MAX_VIA_RULE_APPLICATION_WORK) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Via rule application exceeds the phase-1 work bound.");
  }
  for (const form of viaForms) {
    assertUniqueCriticalChildren(form.node, ["at", "size", "drill", "layers", "net", "padstack"], "via");
    assertNetReferenceSyntax(form.node, "via");
    const at = pointField(form.node, "at");
    const pad = numberField(form.node, "size");
    const drill = numberField(form.node, "drill");
    const layers = viaLayers(form.node);
    const netName = netNameFromForm(form.node, numericNets);
    const parsedType = viaType(form.node);
    if (
      at === null || pad === null || drill === null || layers === null || parsedType === null ||
      pad <= 0 || drill <= 0
    ) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_GEOMETRY_INVALID",
        severity: "error",
        message: "Via is missing a positive circular pad/drill, position, or two-layer span.",
        sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
        evidence: [evidence("via", form.location, {
          at, padDiameterMm: pad, drillDiameterMm: drill, layers, viaType: parsedType,
        })],
        observed: { at, padDiameterMm: pad, drillDiameterMm: drill, layers, viaType: parsedType },
        required: { finitePositiveCircularGeometry: true, recognizedViaType: true, layerCount: 2 },
        assumptions: ["Phase 1 supports circular KiCad via size/drill geometry."],
        gates: ["human-review", "fabricator-confirmation"],
      });
      continue;
    }
    const type = parsedType;
    const netClass = resolveNetClass(netName, profile, classes);
    const layerIndices = layers.map((layer) => profile.copperLayerOrder.indexOf(layer));
    const incidentSegmentLayers = uniqueSorted(segments.filter((segment) =>
      segment.netName === netName &&
      (distance(segment.start, at) <= tolerance || distance(segment.end, at) <= tolerance)
    ).map((segment) => segment.layer));
    const via: PcbViaGeometry = {
      ordinal: form.location.ordinal,
      uuid: form.location.uuid,
      at,
      type,
      padDiameterMm: pad,
      drillDiameterMm: drill,
      annularRingMm: (pad - drill) / 2,
      clearanceToBoardEdgeMm: null,
      layers,
      incidentSegmentLayers,
      netName,
      netClassId: netClass?.id ?? null,
      evidence: form.location,
    };
    vias.push(via);
    const supportedViaChildren = new Set([
      "at", "size", "drill", "layers", "net", "uuid", "tstamp", "locked", "free",
    ]);
    const unsupportedViaGeometry = form.node.children.filter((child) => !supportedViaChildren.has(child.name));
    if (unsupportedViaGeometry.length > 0) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_GEOMETRY_UNSUPPORTED",
        severity: "error",
        message: "Extended per-layer/backdrill via geometry is present; top-level diameter/span cannot establish complete geometry.",
        sourceRuleIds: [profile.diagnostics.unsupportedRoutingSourceRuleId],
        evidence: [evidence("via", form.location, {
          at, type, layers, unsupportedForms: unsupportedViaGeometry.map((child) => child.name),
        })],
        observed: { unsupportedForms: unsupportedViaGeometry.map((child) => child.name) },
        required: { completePerLayerViaGeometryAnalysis: true },
        assumptions: ["No top-level pad diameter is substituted for a smaller inner-layer pad."],
        gates: ["human-review", "fabricator-confirmation"],
      });
    }
    if (netClass === null) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_NET_CLASS_UNBOUND",
        severity: "error",
        message: "A via has no resolvable exact/default net-class binding; net-specific geometry checks fail closed.",
        sourceRuleIds: [profile.diagnostics.unboundNetSourceRuleId],
        evidence: [evidence("via", form.location, { at, type, layers, netName })],
        observed: { netName, netClassId: null },
        required: { exactOrDefaultNetClassBinding: true },
        assumptions: ["An unresolved numeric KiCad net ID is treated as unbound, not as an unnamed safe net."],
        gates: ["human-review"],
      });
    }
    if (pad + 1e-12 < drill || layers[0] === layers[1] || layerIndices.some((index) => index < 0)) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_GEOMETRY_INVALID",
        severity: "error",
        message: "Via drill exceeds its pad or its declared span references a layer absent from the bound stack order.",
        sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
        evidence: [evidence("via", form.location, {
          at, padDiameterMm: pad, drillDiameterMm: drill, annularRingMm: via.annularRingMm, layers,
        })],
        observed: { padDiameterMm: pad, drillDiameterMm: drill, layers },
        required: {
          padNotSmallerThanDrill: true,
          distinctLayerEndpoints: true,
          layersPresentInBoundStack: true,
        },
        assumptions: ["Annular ring is calculated as (circular pad diameter - circular drill diameter) / 2."],
        gates: ["human-review", "fabricator-confirmation"],
      });
    }
    if (layerIndices.every((index) => index >= 0)) {
      const minimumIndex = Math.min(...layerIndices);
      const maximumIndex = Math.max(...layerIndices);
      const spannedLayers = new Set(profile.copperLayerOrder.slice(minimumIndex, maximumIndex + 1));
      const outsideLayers = incidentSegmentLayers.filter((layer) => !spannedLayers.has(layer));
      if (outsideLayers.length > 0) {
        findings.push({
          sortOffset: form.start,
          code: "VIA_INCIDENT_LAYER_OUTSIDE_SPAN",
          severity: "error",
          message: "A segment terminating at the via uses a copper layer outside the declared via span.",
          sourceRuleIds: [profile.diagnostics.invalidGeometrySourceRuleId],
          evidence: [evidence("via", form.location, { at, layers, incidentSegmentLayers })],
          observed: { outsideLayers, incidentSegmentLayers },
          required: { segmentLayersWithinViaSpan: [...spannedLayers] },
          assumptions: ["Copper layers between the two declared endpoints are derived from copperLayerOrder."],
          gates: ["human-review"],
        });
      }
    }
    const matching = allRules.filter(({ rule }) => ruleAppliesToVia(rule, via));
    if (matching.length === 0) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_RULE_UNBOUND",
        severity: "error",
        message: "No via geometry/transition rule applies to this via; phase-1 via checks fail closed.",
        sourceRuleIds: [profile.diagnostics.unboundNetSourceRuleId],
        evidence: [evidence("via", form.location, { at, type, layers, netName, netClassId: via.netClassId })],
        observed: { type, netName, netClassId: via.netClassId },
        required: { applicableViaRule: true },
        assumptions: [],
        gates: ["human-review", "fabricator-confirmation"],
      });
    }
    const metricRules = [
      { name: "padDiameterMm", observed: pad, key: "minimumPadDiameterMm" as const },
      { name: "drillDiameterMm", observed: drill, key: "minimumDrillDiameterMm" as const },
      { name: "annularRingMm", observed: via.annularRingMm, key: "minimumAnnularRingMm" as const },
    ];
    const geometryViolations: { readonly name: string; readonly observed: number; readonly minimum: number; readonly sourceRuleId: string; readonly severity: "warning" | "error"; readonly gates: readonly PcbPracticeGate[] }[] = [];
    for (const metric of metricRules) {
      for (const binding of matching) {
        const minimum = binding.rule[metric.key];
        if (minimum !== undefined && metric.observed + 1e-12 < minimum) {
          geometryViolations.push({
            name: metric.name,
            observed: metric.observed,
            minimum,
            sourceRuleId: binding.rule.sourceRuleId,
            severity: binding.rule.severity,
            gates: effectiveGates(binding.rule, binding.fabrication),
          });
        }
      }
    }
    if (geometryViolations.length > 0) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_GEOMETRY_BELOW_BOUND_MINIMUM",
        severity: strongestSeverity(geometryViolations.map((violation) => violation.severity)),
        message: "Via pad, drill, or annular geometry is below at least one applicable bound rule.",
        sourceRuleIds: uniqueSorted(geometryViolations.map((violation) => violation.sourceRuleId)),
        evidence: [evidence("via", form.location, {
          at, type, padDiameterMm: pad, drillDiameterMm: drill, annularRingMm: via.annularRingMm, layers,
        })],
        observed: Object.fromEntries(geometryViolations.map((violation) => [violation.name, violation.observed])),
        required: Object.fromEntries(metricRules.flatMap((metric) => {
          const minima = geometryViolations.filter((violation) => violation.name === metric.name).map((violation) => violation.minimum);
          return minima.length === 0 ? [] : [[`minimum${metric.name[0]!.toUpperCase()}${metric.name.slice(1)}`, Math.max(...minima)]];
        })),
        assumptions: ["Annular ring is calculated from circular nominal pad and drill diameters; plating/tolerance is not inferred."],
        gates: uniqueSorted(geometryViolations.flatMap((violation) => violation.gates)),
      });
    }
    const transitionViolations = matching.filter(({ rule }) =>
      rule.allowedLayerTransitions !== undefined &&
      !rule.allowedLayerTransitions.some((allowed) => sameLayerTransition(allowed, layers))
    );
    if (transitionViolations.length > 0) {
      findings.push({
        sortOffset: form.start,
        code: "VIA_LAYER_TRANSITION_NOT_ALLOWED",
        severity: strongestSeverity(transitionViolations.map(({ rule }) => rule.severity)),
        message: "Via type/layer span is outside at least one applicable bound transition rule.",
        sourceRuleIds: uniqueSorted(transitionViolations.map(({ rule }) => rule.sourceRuleId)),
        evidence: [evidence("via", form.location, { at, type, layers, netName })],
        observed: { type, layers },
        required: {
          allowedLayerTransitions: transitionViolations.flatMap(({ rule }) => rule.allowedLayerTransitions ?? []),
        },
        assumptions: ["Layer transition endpoints are compared without direction; stack inclusion is derived separately."],
        gates: uniqueSorted(transitionViolations.flatMap(({ rule, fabrication }) => effectiveGates(rule, fabrication))),
      });
    }
  }
  return vias;
}

interface ConnectorPath {
  readonly lengthMm: number;
  readonly segmentOrdinals: readonly number[];
  readonly firstEndpointIndex: 0 | 1;
  readonly secondEndpointIndex: 0 | 1;
}

function shortestConnectorPath(
  segments: readonly PcbRoutedSegment[],
  first: PcbRoutedSegment,
  second: PcbRoutedSegment,
  tolerance: number,
  maximumLengthMm: number,
  overlaps: TrackOverlapAnalysis,
  consumeWork: (units?: number) => void,
): ConnectorPath | null {
  consumeWork(segments.length);
  const candidates = segments.filter((segment) =>
    segment.netName === first.netName && segment.layer === first.layer &&
    segment.ordinal !== first.ordinal && segment.ordinal !== second.ordinal &&
    !overlaps.duplicateOrdinals.has(segment.ordinal)
  );
  const points = [
    first.start, first.end, second.start, second.end,
    ...candidates.flatMap((segment) => [segment.start, segment.end]),
  ];
  const clustered = clusterPoints(points, tolerance);
  const adjacency = new Map<number, { readonly next: number; readonly segment: PcbRoutedSegment }[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    consumeWork();
    const segment = candidates[index]!;
    const startCluster = clustered.clusterByIndex[4 + index * 2]!;
    const endCluster = clustered.clusterByIndex[4 + index * 2 + 1]!;
    const startEdges = adjacency.get(startCluster) ?? [];
    startEdges.push({ next: endCluster, segment });
    adjacency.set(startCluster, startEdges);
    const endEdges = adjacency.get(endCluster) ?? [];
    endEdges.push({ next: startCluster, segment });
    adjacency.set(endCluster, endEdges);
  }
  const targetByCluster = new Map<number, 0 | 1>();
  targetByCluster.set(clustered.clusterByIndex[2]!, 0);
  targetByCluster.set(clustered.clusterByIndex[3]!, 1);
  const best = new Map<string, number>();
  const queue = ([0, 1] as const).map((endpointIndex) => ({
    cluster: clustered.clusterByIndex[endpointIndex]!,
    firstEndpointIndex: endpointIndex,
    lengthMm: 0,
    ordinals: [] as readonly number[],
  }));
  for (const entry of queue) best.set(`${entry.firstEndpointIndex}:${entry.cluster}`, 0);
  while (queue.length > 0) {
    queue.sort((left, right) => left.lengthMm - right.lengthMm || left.cluster - right.cluster);
    const current = queue.shift()!;
    if (current.lengthMm > maximumLengthMm + 1e-12) continue;
    const secondEndpointIndex = targetByCluster.get(current.cluster);
    if (secondEndpointIndex !== undefined && current.ordinals.length > 0 && current.lengthMm > tolerance) {
      return {
        lengthMm: current.lengthMm,
        segmentOrdinals: current.ordinals,
        firstEndpointIndex: current.firstEndpointIndex,
        secondEndpointIndex,
      };
    }
    const bestKey = `${current.firstEndpointIndex}:${current.cluster}`;
    if (current.lengthMm > (best.get(bestKey) ?? Number.POSITIVE_INFINITY) + 1e-12) continue;
    for (const edge of adjacency.get(current.cluster) ?? []) {
      consumeWork();
      const nextLength = current.lengthMm + edge.segment.lengthMm;
      if (nextLength > maximumLengthMm + 1e-12) continue;
      const nextKey = `${current.firstEndpointIndex}:${edge.next}`;
      const prior = best.get(nextKey) ?? Number.POSITIVE_INFINITY;
      if (nextLength + 1e-12 < prior) {
        const ordinals = [...current.ordinals, edge.segment.ordinal];
        best.set(nextKey, nextLength);
        queue.push({
          cluster: edge.next,
          firstEndpointIndex: current.firstEndpointIndex,
          lengthMm: nextLength,
          ordinals,
        });
      }
    }
  }
  return null;
}

function analyzeHairpins(
  segments: readonly PcbRoutedSegment[],
  profile: PcbPracticeAnalysisProfile,
  tolerance: number,
  overlaps: TrackOverlapAnalysis,
  findings: MutableFinding[],
): PcbHairpinCandidate[] {
  assertPairwiseBound(segments.length, "Adjacent hairpin analysis");
  let remainingWork = MAX_PAIRWISE_GEOMETRY_COMPARISONS;
  const consumeWork = (units = 1): void => {
    remainingWork -= units;
    if (remainingWork < 0) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Adjacent hairpin graph analysis exceeds the phase-1 work bound.");
    }
  };
  const policy = profile.advisories.adjacentHairpin;
  const candidates: PcbHairpinCandidate[] = [];
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]!;
    if (left.netName === null) continue;
    const leftVector = subtract(left.end, left.start);
    const leftLength = left.lengthMm;
    const unit = { x: leftVector.x / leftLength, y: leftVector.y / leftLength };
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      consumeWork();
      const right = segments[rightIndex]!;
      if (
        right.netName !== left.netName || right.layer !== left.layer ||
        overlaps.duplicateOrdinals.has(left.ordinal) || overlaps.duplicateOrdinals.has(right.ordinal) ||
        overlaps.overlapPairs.has(segmentPairKey(left, right))
      ) continue;
      const rightVector = subtract(right.end, right.start);
      const rightLength = right.lengthMm;
      const rawCosine = dot(leftVector, rightVector) / (leftLength * rightLength);
      const unsignedAngle = Math.acos(Math.max(-1, Math.min(1, Math.abs(rawCosine)))) * DEG_PER_RAD;
      if (unsignedAngle > policy.parallelToleranceDeg + 1e-9) continue;
      const leftInterval = [dot(left.start, unit), dot(left.end, unit)].sort((a, b) => a - b);
      const rightInterval = [dot(right.start, unit), dot(right.end, unit)].sort((a, b) => a - b);
      const overlap = Math.min(leftInterval[1]!, rightInterval[1]!) - Math.max(leftInterval[0]!, rightInterval[0]!);
      if (overlap + 1e-12 < policy.minimumParallelOverlapMm) continue;
      const normal = { x: -unit.y, y: unit.x };
      const rightProjectionDelta = dot(rightVector, unit);
      if (Math.abs(rightProjectionDelta) <= tolerance) continue;
      const separations = [
        Math.max(leftInterval[0]!, rightInterval[0]!),
        Math.min(leftInterval[1]!, rightInterval[1]!),
      ].map((projection) => {
        const leftPoint = {
          x: left.start.x + unit.x * (projection - dot(left.start, unit)),
          y: left.start.y + unit.y * (projection - dot(left.start, unit)),
        };
        const rightParameter = (projection - dot(right.start, unit)) / rightProjectionDelta;
        const rightPoint = {
          x: right.start.x + rightVector.x * rightParameter,
          y: right.start.y + rightVector.y * rightParameter,
        };
        return Math.abs(dot(subtract(rightPoint, leftPoint), normal));
      });
      const minimumCenterlineSeparation = Math.min(...separations);
      const maximumCenterlineSeparation = Math.max(...separations);
      const halfWidthSum = (left.widthMm + right.widthMm) / 2;
      const minimumEdgeGap = minimumCenterlineSeparation - halfWidthSum;
      const maximumEdgeGap = maximumCenterlineSeparation - halfWidthSum;
      if (minimumEdgeGap <= tolerance || maximumEdgeGap > policy.maximumLegEdgeGapMm + 1e-12) continue;
      const connector = shortestConnectorPath(
        segments,
        left,
        right,
        tolerance,
        policy.maximumConnectorPathLengthMm,
        overlaps,
        consumeWork,
      );
      if (connector === null) continue;
      const leftEndpoints = [left.start, left.end] as const;
      const rightEndpoints = [right.start, right.end] as const;
      const leftConnected = leftEndpoints[connector.firstEndpointIndex];
      const rightConnected = rightEndpoints[connector.secondEndpointIndex];
      const leftOther = leftEndpoints[connector.firstEndpointIndex === 0 ? 1 : 0];
      const rightOther = rightEndpoints[connector.secondEndpointIndex === 0 ? 1 : 0];
      const leftOut = subtract(leftOther, leftConnected);
      const rightOut = subtract(rightOther, rightConnected);
      const outwardCosine = dot(leftOut, rightOut) /
        (Math.hypot(leftOut.x, leftOut.y) * Math.hypot(rightOut.x, rightOut.y));
      if (outwardCosine < Math.cos(policy.parallelToleranceDeg / DEG_PER_RAD) - DIMENSIONLESS_EPSILON) continue;
      const leftConnectedProjection = dot(leftConnected, unit);
      const rightConnectedProjection = dot(rightConnected, unit);
      const leftSide = Math.abs(leftConnectedProjection - leftInterval[0]!) <= tolerance ? "low" : "high";
      const rightSide = Math.abs(rightConnectedProjection - rightInterval[0]!) <= tolerance ? "low" : "high";
      if (leftSide !== rightSide) continue;
      const candidate: PcbHairpinCandidate = {
        netName: left.netName,
        layer: left.layer,
        legSegmentOrdinals: [left.ordinal, right.ordinal],
        connectorSegmentOrdinals: connector.segmentOrdinals,
        parallelAngleDifferenceDeg: unsignedAngle,
        minimumCenterlineSeparationMm: minimumCenterlineSeparation,
        maximumCenterlineSeparationMm: maximumCenterlineSeparation,
        minimumEdgeGapMm: minimumEdgeGap,
        maximumEdgeGapMm: maximumEdgeGap,
        parallelOverlapMm: overlap,
        connectorPathLengthMm: connector.lengthMm,
      };
      candidates.push(candidate);
      const byOrdinal = new Map(segments.map((segment) => [segment.ordinal, segment]));
      const evidenceSegments = [left, right, ...connector.segmentOrdinals.map((ordinal) => byOrdinal.get(ordinal)!)];
      findings.push({
        sortOffset: Math.min(left.evidence.startOffset, right.evidence.startOffset),
        code: "ADJACENT_PARALLEL_HAIRPIN_CANDIDATE",
        severity: "advisory",
        message: "Connected same-net parallel legs match the profile's explicit adjacent-hairpin candidate envelope.",
        sourceRuleIds: [policy.sourceRuleId],
        evidence: evidenceSegments.map((segment, index) => evidence(
          index < 2 ? "parallel-leg" : "connector-segment",
          segment.evidence,
          { start: segment.start, end: segment.end, widthMm: segment.widthMm },
        )),
        observed: { ...candidate },
        required: {
          maximumLegEdgeGapMm: policy.maximumLegEdgeGapMm,
          minimumParallelOverlapMm: policy.minimumParallelOverlapMm,
          maximumConnectorPathLengthMm: policy.maximumConnectorPathLengthMm,
        },
        assumptions: [
          "Candidate status requires a same-net, same-layer connector path excluding both legs.",
          "No universal trace-width spacing multiple or electrical impact is inferred from this geometry.",
        ],
        gates: ["human-review"],
      });
    }
  }
  return candidates;
}

function pointInOutlineLoop(point: PcbPoint, loop: OutlineLoop, tolerance: number): boolean {
  if (loop.edges.length === 1 && loop.edges[0]!.edge.kind === "circle") {
    const circle = loop.edges[0]!.edge;
    return distance(point, circle.center!) < circle.radiusMm! - tolerance;
  }
  const endpointYs = loop.edges.flatMap((oriented) =>
    oriented.edge.kind === "circle" ? [] : [oriented.edge.start!.y, oriented.edge.end!.y]
  );
  let rayY = point.y;
  for (let attempt = 0; attempt < 4 && endpointYs.some((y) => Math.abs(y - rayY) <= tolerance / 16); attempt += 1) {
    rayY += tolerance * (0.3125 + attempt * 0.125);
  }
  let crossings = 0;
  for (const oriented of loop.edges) {
    const edge = oriented.edge;
    if (edge.kind === "line") {
      const start = oriented.reverse ? edge.end! : edge.start!;
      const end = oriented.reverse ? edge.start! : edge.end!;
      if ((start.y > rayY) !== (end.y > rayY)) {
        const intersectionX = start.x + (rayY - start.y) * (end.x - start.x) / (end.y - start.y);
        if (intersectionX > point.x) crossings += 1;
      }
      continue;
    }
    if (edge.kind === "circle") continue;
    const center = edge.center!;
    const radius = edge.radiusMm!;
    const normalizedY = (rayY - center.y) / radius;
    if (normalizedY < -1 || normalizedY > 1) continue;
    const base = Math.asin(Math.max(-1, Math.min(1, normalizedY)));
    const candidateAngles = [normalizeRadians(base), normalizeRadians(Math.PI - base)];
    const start = oriented.reverse ? edge.end! : edge.start!;
    const end = oriented.reverse ? edge.start! : edge.end!;
    const clockwise = oriented.reverse ? !edge.clockwise! : edge.clockwise!;
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    for (const angle of candidateAngles) {
      if (Math.abs(Math.cos(angle)) <= DIMENSIONLESS_EPSILON) continue;
      if (angleOnArc(angle, startAngle, endAngle, clockwise)) {
        const intersectionX = center.x + radius * Math.cos(angle);
        if (intersectionX > point.x) crossings += 1;
      }
    }
  }
  return crossings % 2 === 1;
}

function pointInBoardMaterial(point: PcbPoint, outline: OutlineModel, tolerance: number): boolean {
  let containingLoopCount = 0;
  for (const loop of outline.loops) {
    if (pointInOutlineLoop(point, loop, tolerance)) containingLoopCount += 1;
  }
  return containingLoopCount % 2 === 1;
}

function pointToEdgeDistance(point: PcbPoint, edge: AtomicEdge): number {
  return edge.kind === "line"
    ? pointToSegmentDistance(point, edge.start!, edge.end!)
    : pointToArcDistance(point, edge);
}

function analyzeEdgeClearance(
  segments: readonly PcbRoutedSegment[],
  outline: OutlineModel,
  profile: PcbPracticeAnalysisProfile,
  classes: ReadonlyMap<string, PcbNetClassPracticePolicy>,
  tolerance: number,
  findings: MutableFinding[],
): PcbRoutedSegment[] {
  if (segments.length * Math.max(1, outline.edges.length) > MAX_PAIRWISE_GEOMETRY_COMPARISONS) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Trace-to-outline analysis exceeds the phase-1 bound.");
  }
  return segments.map((segment) => {
    let nearest: AtomicEdge | null = null;
    let centerlineDistance = Number.POSITIVE_INFINITY;
    for (const edge of outline.edges) {
      const candidate = edge.kind === "line"
        ? segmentToSegmentDistance(segment.start, segment.end, edge.start!, edge.end!, tolerance)
        : segmentToArcDistance(segment.start, segment.end, edge, tolerance);
      if (candidate < centerlineDistance) {
        centerlineDistance = candidate;
        nearest = edge;
      }
    }
    if (nearest === null) return segment;
    const clearance = centerlineDistance - segment.widthMm / 2;
    const updated: PcbRoutedSegment = { ...segment, clearanceToBoardEdgeMm: clearance };
    if (outline.complete) {
      const midpoint = {
        x: (segment.start.x + segment.end.x) / 2,
        y: (segment.start.y + segment.end.y) / 2,
      };
      const samplesInside = [segment.start, midpoint, segment.end].every((point) =>
        pointInBoardMaterial(point, outline, tolerance)
      );
      if (!samplesInside || centerlineDistance <= tolerance || clearance <= DIMENSIONLESS_EPSILON) {
        findings.push({
          sortOffset: segment.evidence.startOffset,
          code: "TRACE_OUTSIDE_BOARD_MATERIAL",
          severity: "error",
          message: "Routed trace centerline or copper envelope lies outside board material or crosses an outline/cutout.",
          sourceRuleIds: [profile.diagnostics.containmentSourceRuleId],
          evidence: [
            evidence("segment", segment.evidence, {
              start: segment.start, end: segment.end, widthMm: segment.widthMm, netName: segment.netName,
            }),
            evidence("nearest-board-edge", nearest.evidence, {
              kind: nearest.kind, start: nearest.start, end: nearest.end,
              center: nearest.center, radiusMm: nearest.radiusMm,
            }),
          ],
          observed: { samplesInsideBoardMaterial: samplesInside, centerlineDistanceMm: centerlineDistance, copperClearanceMm: clearance },
          required: { entireCopperEnvelopeInsideBoardMaterial: true },
          assumptions: ["Board material is classified by even-odd nesting of validated simple Edge.Cuts loops."],
          gates: ["human-review", "fabricator-confirmation"],
        });
      }
    }
    const rules: WeightedRule[] = [];
    const netClass = segment.netClassId === null ? null : classes.get(segment.netClassId) ?? null;
    if (netClass?.minimumTraceToBoardEdgeMm !== undefined) {
      const disposition = netClass.traceToBoardEdgeDisposition!;
      rules.push({
      sourceRuleId: disposition.sourceRuleId,
      minimumMm: netClass.minimumTraceToBoardEdgeMm,
      severity: disposition.severity,
      gates: effectiveGates(disposition, false),
      });
    }
    const fabRule = profile.fabrication?.minimumTraceToBoardEdge;
    if (fabRule !== undefined) rules.push({
      sourceRuleId: fabRule.sourceRuleId,
      minimumMm: fabRule.minimumMm,
      severity: fabRule.severity,
      gates: effectiveGates(fabRule, true),
    });
    const violated = rules.filter((rule) => clearance + 1e-12 < rule.minimumMm);
    if (violated.length > 0) findings.push({
      sortOffset: segment.evidence.startOffset,
      code: "TRACE_TO_BOARD_EDGE_BELOW_BOUND_MINIMUM",
      severity: strongestSeverity(violated.map((rule) => rule.severity)),
      message: outline.complete
        ? "Trace copper clearance to the native board outline is below a bound minimum."
        : "Known trace-to-edge clearance is below a bound minimum, and the incomplete outline independently prevents a pass.",
      sourceRuleIds: uniqueSorted(violated.map((rule) => rule.sourceRuleId)),
      evidence: [
        evidence("segment", segment.evidence, {
          start: segment.start, end: segment.end, widthMm: segment.widthMm, netName: segment.netName,
        }),
        evidence("nearest-board-edge", nearest.evidence, {
          kind: nearest.kind, start: nearest.start, end: nearest.end, center: nearest.center, radiusMm: nearest.radiusMm,
        }),
      ],
      observed: { centerlineDistanceMm: centerlineDistance, copperClearanceMm: clearance },
      required: { minimumCopperClearanceMm: Math.max(...violated.map((rule) => rule.minimumMm)) },
      assumptions: [
        "Copper clearance is centerline-to-outline distance minus half the routed width.",
        "Edge.Cuts drawing stroke width is not treated as physical board material.",
      ],
      gates: uniqueSorted(violated.flatMap((rule) => rule.gates)),
    });
    return updated;
  });
}

function analyzeViaContainment(
  vias: readonly PcbViaGeometry[],
  outline: OutlineModel,
  profile: PcbPracticeAnalysisProfile,
  tolerance: number,
  findings: MutableFinding[],
): PcbViaGeometry[] {
  if (outline.edges.length === 0) return [...vias];
  return vias.map((via) => {
    let nearest: AtomicEdge | null = null;
    let centerDistance = Number.POSITIVE_INFINITY;
    for (const edge of outline.edges) {
      const candidate = pointToEdgeDistance(via.at, edge);
      if (candidate < centerDistance) {
        centerDistance = candidate;
        nearest = edge;
      }
    }
    if (nearest === null || !Number.isFinite(centerDistance)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Via containment produced an invalid distance.");
    }
    const clearance = centerDistance - via.padDiameterMm / 2;
    const updated: PcbViaGeometry = { ...via, clearanceToBoardEdgeMm: clearance };
    if (outline.complete && (
      !pointInBoardMaterial(via.at, outline, tolerance) || clearance <= DIMENSIONLESS_EPSILON
    )) {
      findings.push({
        sortOffset: via.evidence.startOffset,
        code: "VIA_OUTSIDE_BOARD_MATERIAL",
        severity: "error",
        message: "Via center or pad envelope lies outside board material or inside an Edge.Cuts cutout.",
        sourceRuleIds: [profile.diagnostics.containmentSourceRuleId],
        evidence: [
          evidence("via", via.evidence, {
            at: via.at, padDiameterMm: via.padDiameterMm, netName: via.netName,
          }),
          evidence("nearest-board-edge", nearest.evidence, {
            kind: nearest.kind, start: nearest.start, end: nearest.end,
            center: nearest.center, radiusMm: nearest.radiusMm,
          }),
        ],
        observed: {
          centerInsideBoardMaterial: pointInBoardMaterial(via.at, outline, tolerance),
          centerDistanceMm: centerDistance,
          padClearanceMm: clearance,
        },
        required: { entireViaPadEnvelopeInsideBoardMaterial: true },
        assumptions: ["Board material is classified by even-odd nesting of validated simple Edge.Cuts loops."],
        gates: ["human-review", "fabricator-confirmation"],
      });
    }
    return updated;
  });
}

function publicEdges(edges: readonly AtomicEdge[]): readonly PcbBoardEdgePrimitive[] {
  return edges.map((edge) => ({
    kind: edge.kind,
    start: edge.start,
    end: edge.end,
    center: edge.center,
    radiusMm: edge.radiusMm,
    clockwise: edge.clockwise,
    evidence: edge.evidence,
  }));
}

function finalizeFindings(findings: readonly MutableFinding[]): readonly PcbPracticeFinding[] {
  if (findings.length > MAX_FINDINGS) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "PCB practice finding count exceeds the analysis limit.");
  }
  const sorted = [...findings].sort((left, right) =>
    left.sortOffset - right.sortOffset ||
    compareSeverity(right.severity, left.severity) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.sourceRuleIds.join("\u0000"), right.sourceRuleIds.join("\u0000"))
  );
  const digestCounts = new Map<string, number>();
  return sorted.map(({ sortOffset: _sortOffset, ...finding }) => {
    const preimage = JSON.stringify({
      code: finding.code,
      sourceRuleIds: finding.sourceRuleIds,
      evidence: finding.evidence.map((entry) => ({
        role: entry.role,
        sourcePath: entry.location.sourcePath,
        form: entry.location.form,
        identity: entry.location.uuid === null
          ? {
              ordinal: entry.location.ordinal,
              startOffset: entry.location.startOffset,
              endOffset: entry.location.endOffset,
            }
          : { uuid: entry.location.uuid },
      })),
    });
    const digest = createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 24);
    const collisionIndex = (digestCounts.get(digest) ?? 0) + 1;
    digestCounts.set(digest, collisionIndex);
    return {
      ...finding,
      id: `PCB-PRACTICE-${digest}${collisionIndex === 1 ? "" : `-${collisionIndex}`}`,
    };
  });
}

function assertFiniteAnalysisValue(value: unknown, path = "analysis", depth = 0, budget = { count: 0 }): void {
  if (depth > 128) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${path} exceeds result depth bounds.`);
  budget.count += 1;
  if (budget.count > 2_000_000) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "PCB practice result exceeds the value-count bound.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", `${path} contains a non-finite computed value.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteAnalysisValue(entry, `${path}[${index}]`, depth + 1, budget));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertFiniteAnalysisValue(entry, `${path}.${key}`, depth + 1, budget);
    }
  }
}

/** Analyze native .kicad_pcb source without claiming electrical/fabrication qualification. */
export function analyzeKicadPcbPractices(
  input: string | Uint8Array,
  profile: PcbPracticeAnalysisProfile,
  options: { readonly sourcePath?: string } = {},
): PcbPracticeAnalysis {
  profile = validateAndSnapshotPcbPracticeAnalysisProfile(profile);
  let source: string;
  try {
    source = typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    throw new PcbPracticeAnalyzerError(
      "INVALID_KICAD_PCB",
      `Native KiCad PCB bytes are not valid UTF-8${error instanceof Error ? "." : ""}`,
    );
  }
  const root = parseSExpressionDocument(source);
  validateNativeSourceBinding(root, profile);
  assertAnalyzedIdentityUniqueness(root);
  const sourcePath = options.sourcePath ?? "<native.kicad_pcb>";
  const starts = lineStarts(source);
  const tolerance = profile.coordinateToleranceMm ?? DEFAULT_COORDINATE_TOLERANCE_MM;
  const classes = new Map(profile.netClasses.map((netClass) => [netClass.id, netClass]));
  const numericNets = new Map<number, string>();
  const numericNetNames = new Set<string>();
  for (const net of childrenNamed(root, "net")) {
    if (
      net.children.length !== 0 || net.values.length !== 2 || net.values[0]!.quoted ||
      !INTEGER_TOKEN.test(net.values[0]!.value) || !net.values[1]!.quoted
    ) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Top-level net declaration has invalid ordinal/name syntax.");
    }
    const id = Number(net.values[0]!.value);
    const name = net.values[1]!.value;
    if (!Number.isSafeInteger(id)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Top-level net ordinal exceeds the safe integer range.");
    }
    if (numericNets.has(id) || numericNetNames.has(name)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Top-level net declarations contain a duplicate ordinal or name.");
    }
    numericNets.set(id, name);
    numericNetNames.add(name);
  }
  const mutableFindings: MutableFinding[] = new BoundedFindingList();
  const parsedSegments = parseSegments(
    root, source, sourcePath, starts, numericNets, profile, classes, tolerance, mutableFindings,
  );
  const routedArcs = parseRoutedArcs(
    root, source, sourcePath, starts, numericNets, profile, classes, tolerance, mutableFindings,
  );
  analyzeUnsupportedCopperGraphics(root, source, sourcePath, starts, profile, mutableFindings);
  const outline = parseEdges(root, source, sourcePath, starts, tolerance, mutableFindings, profile);
  const segments = analyzeEdgeClearance(
    parsedSegments, outline, profile, classes, tolerance, mutableFindings,
  );
  analyzeWidths(segments, profile, classes, mutableFindings);
  const overlaps = analyzeOverlappingTracks(segments, profile, tolerance, mutableFindings);
  const turns = analyzeTurns(segments, profile, classes, tolerance, overlaps, mutableFindings);
  const parsedVias = parseAndAnalyzeVias(
    root, source, sourcePath, starts, numericNets, profile, classes, segments, tolerance, mutableFindings,
  );
  const vias = analyzeViaContainment(parsedVias, outline, profile, tolerance, mutableFindings);
  const layerTransitions: readonly PcbObservedLayerTransition[] = vias.map((via) => ({
    viaOrdinal: via.ordinal,
    viaType: via.type,
    netName: via.netName,
    netClassId: via.netClassId,
    startLayer: via.layers[0],
    endLayer: via.layers[1],
    incidentSegmentLayers: via.incidentSegmentLayers,
    evidence: via.evidence,
  }));
  const hairpinCandidates = analyzeHairpins(segments, profile, tolerance, overlaps, mutableFindings);
  const findings = finalizeFindings(mutableFindings);
  const findingsBySeverity: Record<PcbPracticeSeverity, number> = { advisory: 0, warning: 0, error: 0 };
  for (const finding of findings) findingsBySeverity[finding.severity] += 1;
  const humanReviewRequired = findings.some((finding) => finding.gates.includes("human-review"));
  const fabricatorConfirmationRequired = findings.some((finding) =>
    finding.gates.includes("fabricator-confirmation")
  );
  const routingCoverageIncompleteCodes = new Set([
    "ROUTED_ARC_ANALYSIS_UNSUPPORTED",
    "ROUTED_ARC_GEOMETRY_INVALID",
    "ROUTED_SEGMENT_GEOMETRY_INVALID",
    "ROUTED_SEGMENT_GEOMETRY_UNSUPPORTED",
    "COPPER_GRAPHIC_ROUTING_UNSUPPORTED",
    "VIA_GEOMETRY_INVALID",
    "VIA_GEOMETRY_UNSUPPORTED",
    "TURN_JUNCTION_COVERAGE_UNRESOLVED",
  ]);
  const routingCoverageComplete = !findings.some((finding) => routingCoverageIncompleteCodes.has(finding.code));
  const outcome: PcbPracticeAnalysis["outcome"] = findingsBySeverity.error > 0
    ? "fail"
    : findingsBySeverity.warning > 0 || findingsBySeverity.advisory > 0
      ? "review"
      : "pass";
  const result: PcbPracticeAnalysis = {
    schemaVersion: PCB_PRACTICE_ANALYSIS_SCHEMA,
    profileSchemaVersion: profile.schemaVersion,
    classification: "analysis-only",
    qualificationEstablished: false,
    releaseAuthorized: false,
    outcome,
    summary: {
      segmentCount: segments.length,
      routedArcCount: routedArcs.length,
      viaCount: vias.length,
      turnCount: turns.length,
      layerTransitionCount: layerTransitions.length,
      hairpinCandidateCount: hairpinCandidates.length,
      boardEdgePrimitiveCount: outline.edges.length,
      outlineComplete: outline.complete,
      routingCoverageComplete,
      completeBoardGeometryCoverage: false,
      findingsBySeverity,
      humanReviewRequired,
      fabricatorConfirmationRequired,
    },
    extracted: {
      segments,
      routedArcs,
      vias,
      layerTransitions,
      turns,
      hairpinCandidates,
      boardEdges: publicEdges(outline.edges),
    },
    findings,
    assumptions: [
      `Endpoint coincidence uses a ${tolerance} mm coordinate tolerance.`,
      "Net-class selection uses exact net names plus an explicit default class when supplied.",
      "Fabricator values are input declarations, not evidence of current process capability or yield.",
    ],
    limitations: [
      "This report does not establish release readiness or fabrication qualification.",
      "Geometry checks do not establish impedance, current capacity, thermal performance, EMC, creepage, clearance safety, or reliability.",
      "Pads, zones, teardrops, routed-arc validation, and footprint-local Edge.Cuts transforms are outside complete phase-1 coverage.",
      "completeBoardGeometryCoverage is always false in phase 1; routingCoverageComplete covers only recognized top-level routed objects.",
      "Finding IDs use native UUID/tstamp identity when present and positional source identity otherwise.",
      ...(profile.fabrication === undefined
        ? ["No fabricator capability profile was bound; fabrication feasibility remains unconfirmed."]
        : [`Fabricator declaration ${profile.fabrication.declarationId} is treated only as a declared constraint set.`]),
    ],
  };
  assertFiniteAnalysisValue(result);
  return deepFreeze(result);
}

/** Geometry extraction only: no width, via, stackup suitability or fabrication policy is inferred. */
export function extractKicadPcbTurnGeometry(input: Uint8Array, sourcePath: string) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const root = parseSExpressionDocument(source);
  const layers = childrenNamed(root, "layers")[0];
  const copperLayerOrder = (layers?.children ?? []).map(layer => layer.values[0]?.value ?? "").filter(name => name.endsWith(".Cu"));
  if (copperLayerOrder.length < 2) throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native PCB must declare at least two copper layers.");
  // This internal context enables the existing topology diagnostics only. It is
  // never passed to width/via analysis or returned as a reviewed design profile.
  const diagnostic = { sourceRuleId: "toolbox.geometry", severity: "error" as const };
  const context: PcbPracticeAnalysisProfile = {
    schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: { mode: "production", supportedBoardVersions: PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS },
    copperLayerOrder, netClasses: [{ id: "geometry-only", ...diagnostic, minimumTrackWidthMm: 0,
      minimumInteriorAngleDeg: 0, interiorAngleDisposition: diagnostic }],
    netClassByNet: {}, defaultNetClassId: "geometry-only", viaRules: [],
    advisories: { rightAngle: { sourceRuleId: "toolbox.geometry", toleranceDeg: 0 },
      reversal: { sourceRuleId: "toolbox.geometry", maximumInteriorAngleDeg: 0 },
      adjacentHairpin: { sourceRuleId: "toolbox.geometry", parallelToleranceDeg: 0, maximumLegEdgeGapMm: 0,
        minimumParallelOverlapMm: 0, maximumConnectorPathLengthMm: 0 } },
    diagnostics: { invalidGeometrySourceRuleId: "toolbox.geometry", unboundNetSourceRuleId: "toolbox.geometry",
      unsupportedOutlineSourceRuleId: "toolbox.geometry", unsupportedRoutingSourceRuleId: "toolbox.geometry",
      junctionCoverageSourceRuleId: "toolbox.geometry", containmentSourceRuleId: "toolbox.geometry", duplicateTrackSourceRuleId: "toolbox.geometry" },
  };
  validateNativeSourceBinding(root, context);
  assertAnalyzedIdentityUniqueness(root);
  const numericNets = new Map<number, string>();
  const names = new Set<string>();
  for (const net of childrenNamed(root, "net")) {
    const [ordinal, name] = net.values;
    if (net.children.length !== 0 || net.values.length !== 2 || ordinal!.quoted || !INTEGER_TOKEN.test(ordinal!.value)
        || !name!.quoted || !Number.isSafeInteger(Number(ordinal!.value)) || numericNets.has(Number(ordinal!.value)) || names.has(name!.value)) {
      throw new PcbPracticeAnalyzerError("INVALID_KICAD_PCB", "Native net declaration is malformed or duplicated.");
    }
    numericNets.set(Number(ordinal!.value), name!.value); names.add(name!.value);
  }
  const findings: MutableFinding[] = new BoundedFindingList();
  const starts = lineStarts(source);
  const classes = new Map(context.netClasses.map(entry => [entry.id, entry]));
  const segments = parseSegments(root, source, sourcePath, starts, numericNets, context, classes, DEFAULT_COORDINATE_TOLERANCE_MM, findings);
  const arcs = parseRoutedArcs(root, source, sourcePath, starts, numericNets, context, classes, DEFAULT_COORDINATE_TOLERANCE_MM, findings);
  analyzeUnsupportedCopperGraphics(root, source, sourcePath, starts, context, findings);
  const overlaps = analyzeOverlappingTracks(segments, context, DEFAULT_COORDINATE_TOLERANCE_MM, findings);
  const turns = analyzeTurns(segments, context, classes, DEFAULT_COORDINATE_TOLERANCE_MM, overlaps, findings);
  return deepFreeze({ turns: turns.map(turn => ({ ...turn, netClassId: null })),
    findings: finalizeFindings(findings), segmentCount: segments.length, routedArcCount: arcs.length,
    unresolvedNetSegmentCount: segments.filter(segment => segment.netName === null).length,
    coordinateToleranceMm: DEFAULT_COORDINATE_TOLERANCE_MM,
    limitations: ["Only top-level straight segments with resolved nets and degree-two same-layer endpoints have sequential turn measurements.",
      "Geometry-only extraction does not check widths, vias, electrical stackup, current capacity, impedance, clearance or fabrication suitability."] });
}
