import { createHash } from "node:crypto";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import {
  PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  analyzeKicadPcbPractices,
  type PcbPracticeAnalysis,
  type PcbPracticeAnalysisProfile,
  type PcbRoutedSegment,
  type PcbViaGeometry,
} from "../integrations/pcb-practice-analyzer.js";
import { verifyHostSchematicRenderClearanceEvidence, type SchematicRenderClearanceEvidence, type SchematicRenderClearanceExpected } from "../integrations/schematic-render-clearance.js";
import type { HarnessToolResult } from "./contracts.js";
import {
  validateDeepRuleCatalog,
  type DeepRuleCatalog,
} from "./deep-rule-catalog.js";
import {
  selectDeepRulesForDesign,
  type DeepRuleSelectionOptions,
} from "./deep-rule-selector.js";
import {
  PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION,
  PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION,
  PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION,
  createPcbAcceptancePlan,
  createPcbAcceptancePlanV1,
  deriveDeepRuleFeaturesFromContract,
  normalizePcbResolvedFootprint,
  normalizePcbResolvedSymbol,
  type PcbAcceptancePlan,
  type PcbAcceptancePlanRow,
  type PcbDeepRuleBinding,
  type PcbLibraryBinding,
  type PcbReadOnlyLibraryResolver,
} from "./pcb-design-compiler.js";
import {
  parsePcbDesignContract,
  type PcbDesignContract,
} from "./pcb-design-contract.js";
import {
  FreshKicadParseError,
  parseFreshNetlistSource,
  parseFreshPcbSource,
  parseFreshSchematicSource,
  freshGlobalLabelInventoryMatches,
  freshSchematicClassSourcesSupported,
  type FreshBounds,
  type FreshParsedPcb,
  type FreshPcbFootprint,
  type FreshPcbPad,
  type FreshPoint,
} from "./fresh-kicad-parser.js";
import { verifyHostKicadNativePadObservation, type KicadNativePadObservation, type KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";

/**
 * Generic, deterministic acceptance for a compiler-closed fresh PCB design.
 *
 * This module is deliberately not a provider tool. The controller supplies
 * host-read source files, a host-exported native netlist, host-run ERC/DRC,
 * and host-owned visual inspection evidence. Provider prose and provider-
 * supplied PASS claims are not accepted by this boundary.
 */
export const FRESH_DESIGN_ACCEPTANCE_LEGACY_SCHEMA_VERSION = "evleda.fresh-design-acceptance.v1" as const;
export const FRESH_DESIGN_ACCEPTANCE_SCHEMA_VERSION =
  "evleda.fresh-design-acceptance.v2" as const;
export const FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION =
  "evleda.fresh-design-clearance-evidence.v1" as const;

export const FRESH_DESIGN_ACCEPTANCE_LIMITS = Object.freeze({
  maximumParsedSegments: 4_096,
  maximumParsedVias: 256,
});

export const FRESH_DESIGN_COORDINATE_TOLERANCE_MM = 0.0001;
export const FRESH_DESIGN_ANGLE_TOLERANCE_DEG = 0.01;
const NUMERIC_EPSILON = 1e-9;

export type FreshDesignAcceptanceStatus = "pass" | "fail" | "unknown";

export interface FreshDesignAcceptanceRequirement {
  readonly id: string;
  readonly kind: PcbAcceptancePlanRow["kind"];
  readonly mandatory: true;
  readonly status: FreshDesignAcceptanceStatus;
  readonly detail: string;
}

export interface FreshDesignAcceptanceResult {
  readonly schemaVersion: typeof FRESH_DESIGN_ACCEPTANCE_SCHEMA_VERSION | typeof FRESH_DESIGN_ACCEPTANCE_LEGACY_SCHEMA_VERSION;
  readonly passed: boolean;
  readonly contractIdentity: PcbDesignContract["identity"];
  readonly acceptancePlanIdentity: PcbAcceptancePlan["identity"];
  readonly requirements: readonly FreshDesignAcceptanceRequirement[];
  readonly missing: readonly string[];
  readonly sourceHashes: Readonly<{
    schematicSha256: string;
    netlistSha256: string;
    pcbSha256: string;
  }>;
  readonly evidenceLimitations: readonly string[];
}

export interface FreshDesignAcceptanceArtifacts {
  readonly contract: PcbDesignContract;
  /** Trusted read-only local-library projection used to reproduce bindings. */
  readonly libraryResolver: PcbReadOnlyLibraryResolver;
  readonly libraryBinding: PcbLibraryBinding;
  /** Trusted local catalog used to independently regenerate the compiler binding. */
  readonly deepRuleCatalog: DeepRuleCatalog;
  /** Exact deterministic selector policy used by compilation; functions are forbidden here. */
  readonly deepRuleSelectionOptions?: Omit<DeepRuleSelectionOptions, "tokenCounter">;
  readonly deepRuleBinding: PcbDeepRuleBinding;
  readonly acceptancePlan: PcbAcceptancePlan;
  /** Exact compiler-bundle profile; independently regenerated before use. */
  readonly practiceProfile?: PcbPracticeAnalysisProfile;
  /** Host current source/tool/native-validation authority for the separate SVG receipt. */
  readonly schematicRenderExpected?: SchematicRenderClearanceExpected;
  readonly nativePadExpected?: KicadNativePadObservationExpected;
}

export interface HostNativeAcceptanceEvidence {
  /** Explicitly marks evidence captured by the host controller, not the model. */
  readonly origin: "host";
  readonly result: string | HarnessToolResult;
}

export interface FreshDesignClearanceEvidence {
  readonly origin: "host";
  readonly schemaVersion: typeof FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION;
  readonly source: "kicad-effective-netclass-rules";
  readonly pcbSha256: string;
  readonly rulesSourceSha256: string;
  readonly netClasses: readonly Readonly<{
    readonly id: string;
    readonly configuredClearanceMm: number;
    readonly effectiveClearanceMm: number;
  }>[];
}

export interface FreshDesignAcceptanceEvidence {
  readonly schematicSource: string;
  /** Native `kicad-cli sch export netlist` S-expression. */
  readonly netlistSource: string;
  readonly pcbSource: string;
  readonly clearance: FreshDesignClearanceEvidence;
  readonly erc: HostNativeAcceptanceEvidence;
  readonly drc: HostNativeAcceptanceEvidence;
  readonly visualInspection: HostNativeAcceptanceEvidence;
  /** Must be minted or independently reverified by the host SVG collector. */
  readonly schematicRenderClearance?: SchematicRenderClearanceEvidence;
  /** Must originate in the current private host collector, not a decoded/copied JSON receipt. */
  readonly nativePads?: KicadNativePadObservation;
}

interface Check {
  readonly status: FreshDesignAcceptanceStatus;
  readonly detail: string;
}

interface NativeCheck extends Check {
  readonly passed: boolean | null;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort(compareText);

const sameStrings = (left: readonly string[], right: readonly string[]): boolean => {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};

const endpointKey = (reference: string, pin: string): string => `${reference}:${pin}`;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const sha256 = (source: string): string =>
  createHash("sha256").update(source, "utf8").digest("hex");

const closeNumber = (left: number, right: number): boolean =>
  Math.abs(left - right) <= FRESH_DESIGN_COORDINATE_TOLERANCE_MM;

const closePoint = (left: FreshPoint, right: FreshPoint): boolean =>
  Math.hypot(left.x - right.x, left.y - right.y) <= FRESH_DESIGN_COORDINATE_TOLERANCE_MM;

const normalizeRotation = (degrees: number): number => ((degrees % 360) + 360) % 360;

const acceptedNativeStatus = (value: unknown): boolean =>
  typeof value === "string" && ["clean", "pass", "passed"].includes(value.toLowerCase());

const rawContent = (evidence: HostNativeAcceptanceEvidence): string | null => {
  if (evidence.origin !== "host") return null;
  if (typeof evidence.result === "string") {
    return evidence.result.trim().length === 0 ? null : evidence.result;
  }
  return evidence.result.isError === true || evidence.result.content.trim().length === 0
    ? null
    : evidence.result.content;
};

const jsonRecord = (evidence: HostNativeAcceptanceEvidence): Record<string, unknown> | null => {
  const content = rawContent(evidence);
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const metadataRecord = (record: Record<string, unknown>): Record<string, unknown> | null =>
  record.metadata !== null && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : null;

const nonnegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const VALID_FINDING_SEVERITIES = new Set(["error", "warning", "advisory", "info"]);

const findingsArray = (value: unknown): readonly unknown[] | null => {
  if (!Array.isArray(value)) return null;
  for (const finding of value) {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return null;
    const severity = (finding as Record<string, unknown>).severity;
    if (typeof severity !== "string" || !VALID_FINDING_SEVERITIES.has(severity.toLowerCase())) return null;
  }
  return value;
};

function nativeValidatorCheck(
  evidence: HostNativeAcceptanceEvidence,
  kind: "erc" | "drc",
): NativeCheck {
  const record = jsonRecord(evidence);
  if (record === null) {
    return { status: "unknown", passed: null, detail: `Host ${kind.toUpperCase()} evidence is absent or malformed.` };
  }
  const metadata = metadataRecord(record);
  if (metadata === null) {
    return { status: "unknown", passed: null, detail: `Host ${kind.toUpperCase()} metadata is absent or malformed.` };
  }
  const findings = findingsArray(record.findings);
  const issues = record.issues === undefined ? [] : findingsArray(record.issues);
  if (findings === null || issues === null || record.passed !== undefined && typeof record.passed !== "boolean") {
    return { status: "unknown", passed: null, detail: `Host ${kind.toUpperCase()} findings/issues violate the strict evidence schema.` };
  }
  if (metadata.available !== true) {
    return { status: "fail", passed: false, detail: `Native KiCad ${kind.toUpperCase()} is unavailable.` };
  }
  if (!acceptedNativeStatus(record.status) || record.passed === false) {
    return { status: "fail", passed: false, detail: `Native KiCad ${kind.toUpperCase()} is unavailable or did not report a passing status.` };
  }
  const keys = kind === "erc"
    ? ["violation_count"] as const
    : ["violations", "unconnected_items", "courtyard_issues"] as const;
  const counts = keys.map((key) => nonnegativeInteger(metadata[key]));
  if (counts.some((entry) => entry === null)) {
    return { status: "unknown", passed: null, detail: `Native KiCad ${kind.toUpperCase()} lacks exact nonnegative integer count evidence.` };
  }
  const primaryCount = counts[0]!;
  // The pinned ERC sidecar exposes the flattened violations list here; DRC
  // keeps a scalar count. No other count field accepts arrays.
  const violationsAlias = kind === "erc" && Array.isArray(metadata.violations)
    ? metadata.violations.length : metadata.violations;
  const aliasCounts = [metadata.violation_count, violationsAlias, metadata.issue_count]
    .filter((value) => value !== undefined)
    .map(nonnegativeInteger);
  if (aliasCounts.some((entry) => entry === null)
      || aliasCounts.some((entry) => entry !== primaryCount)) {
    return { status: "fail", passed: false, detail: `Native KiCad ${kind.toUpperCase()} count aliases contradict one another.` };
  }
  const observedItems = findings.length + issues.length;
  if (primaryCount !== observedItems || counts.some((entry) => entry! > 0) || observedItems > 0) {
    return {
      status: "fail",
      passed: false,
      detail: `Native KiCad ${kind.toUpperCase()} status/count/findings contradict a clean result or report one or more violations.`,
    };
  }
  return {
    status: "pass",
    passed: true,
    detail: kind === "erc"
      ? "Native KiCad ERC is available, passing, and reports zero violations."
      : "Native KiCad DRC is available, passing, and reports zero violations, unconnected items, and courtyard issues.",
  };
}

function visualCheck(
  evidence: HostNativeAcceptanceEvidence,
  analysis: PcbPracticeAnalysis | null,
  analysisProblem: string,
  uncoveredZonesPresent: boolean,
): Check {
  const record = jsonRecord(evidence);
  if (record === null) {
    return { status: "unknown", detail: "Host visual inspection is absent or malformed." };
  }
  const findings = findingsArray(record.findings);
  const issues = record.issues === undefined ? [] : findingsArray(record.issues);
  if (findings === null || issues === null || record.passed !== undefined && typeof record.passed !== "boolean") {
    return { status: "unknown", detail: "Host visual inspection violates the strict status/findings/issues evidence schema." };
  }
  const metadata = record.metadata === undefined ? {} : metadataRecord(record);
  if (metadata === null) {
    return { status: "unknown", detail: "Host visual inspection metadata is malformed." };
  }
  const countChecks = [
    [record.finding_count, findings.length],
    [record.findings_count, findings.length],
    [record.issue_count, issues.length],
    [metadata.finding_count, findings.length],
    [metadata.findings_count, findings.length],
    [metadata.issue_count, issues.length],
  ] as const;
  for (const [observed, expected] of countChecks) {
    if (observed === undefined) continue;
    const count = nonnegativeInteger(observed);
    if (count === null) return { status: "unknown", detail: "Host visual inspection count evidence is not a nonnegative integer." };
    if (count !== expected) return { status: "fail", detail: "Host visual inspection counts contradict its findings/issues arrays." };
  }
  if (!acceptedNativeStatus(record.status) || record.passed === false || findings.length !== 0 || issues.length !== 0) {
    return { status: "fail", detail: `Host visual inspection is non-passing or reports ${findings.length} finding(s) and ${issues.length} issue(s).` };
  }
  if (analysis === null) {
    return { status: "unknown", detail: `Deterministic PCB practice analysis is unavailable: ${analysisProblem}` };
  }
  if (uncoveredZonesPresent && !analysis.summary.completeBoardGeometryCoverage) {
    return {
      status: "fail",
      detail: "PCB contains zone geometry outside deterministic analyzer coverage; V1 has no contract field or separate verified zone evidence that can authorize it.",
    };
  }
  if (analysis.findings.length !== 0) {
    const codes = sorted([...new Set(analysis.findings.map((finding) => finding.code))]);
    return { status: "fail", detail: `Deterministic PCB practice analysis reports ${analysis.findings.length} finding(s): ${codes.join(", ")}.` };
  }
  return { status: "pass", detail: "Host visual inspection and deterministic PCB practice analysis report no findings." };
}

/** Exact lexical check for a direct child form of the KiCad root. */
function hasTopLevelForm(source: string, wanted: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      if (depth !== 2) continue;
      let cursor = index + 1;
      while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
      const start = cursor;
      while (cursor < source.length && !/[\s()]/u.test(source[cursor]!)) cursor += 1;
      if (source.slice(start, cursor) === wanted) return true;
    } else if (character === ")") depth -= 1;
  }
  return false;
}

interface PcbNetDeclaration {
  readonly id: number;
  readonly name: string;
}

interface ParsedPcbNetTable {
  readonly declarations: readonly PcbNetDeclaration[];
  /** null id denotes an exact quoted KiCad 10 net name, including numeric-looking names. */
  readonly references: readonly Readonly<{ id: number | null; name: string | null }>[];
}

const formHeadAt = (source: string, openingIndex: number): Readonly<{ head: string; cursor: number }> | null => {
  let cursor = openingIndex + 1;
  while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  const start = cursor;
  while (cursor < source.length && !/[\s()]/u.test(source[cursor]!)) cursor += 1;
  return cursor === start ? null : { head: source.slice(start, cursor), cursor };
};

const quotedAtomAt = (source: string, start: number): Readonly<{ value: string; cursor: number }> | null => {
  if (source[start] !== '"') return null;
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor++]!;
    if (character === '"') return { value, cursor };
    if (character === "\\") {
      if (cursor >= source.length) return null;
      const escaped = source[cursor++]!;
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
    } else value += character;
  }
  return null;
};

/** Independently extracts legacy declarations and every nested numeric/name net reference. */
function parsePcbNetTable(source: string): ParsedPcbNetTable | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let rootSeen = false;
  const declarations: PcbNetDeclaration[] = [];
  const references: Array<{ id: number | null; name: string | null }> = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      const form = formHeadAt(source, index);
      if (form === null) return null;
      if (depth === 1) {
        if (rootSeen || form.head !== "kicad_pcb") return null;
        rootSeen = true;
      }
      if (form.head !== "net") continue;
      let cursor = form.cursor;
      while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
      if (source[cursor] === '"') {
        const name = quotedAtomAt(source, cursor);
        if (name === null || depth === 2) return null;
        cursor = name.cursor;
        while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
        if (source[cursor] !== ")") return null;
        references.push({ id: null, name: name.value });
        continue;
      }
      const idStart = cursor;
      while (cursor < source.length && /\d/u.test(source[cursor]!)) cursor += 1;
      const idText = source.slice(idStart, cursor);
      while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
      const name = source[cursor] === '"' ? quotedAtomAt(source, cursor) : null;
      if (idText.length === 0 || source[cursor] === '"' && name === null) return null;
      if (name !== null) cursor = name.cursor;
      while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
      if (source[cursor] !== ")") return null;
      const id = Number(idText);
      if (!Number.isSafeInteger(id) || id < 0) return null;
      if (depth === 2) {
        if (name === null) return null;
        declarations.push({ id, name: name.value });
      } else references.push({ id, name: name?.value ?? null });
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
    }
  }
  if (!rootSeen || depth !== 0 || quoted) return null;
  if (new Set(declarations.map((entry) => entry.id)).size !== declarations.length
      || new Set(declarations.map((entry) => entry.name)).size !== declarations.length) return null;
  return { declarations, references };
}

function pcbNetInventoryCheck(source: string, contract: PcbDesignContract): Check {
  const table = parsePcbNetTable(source);
  if (table === null) return { status: "unknown", detail: "PCB net declarations or nested references are malformed or ambiguous." };
  const reserved = table.declarations.filter((entry) => entry.name.length === 0);
  const named = table.declarations.filter((entry) => entry.name.length > 0);
  const nameById = new Map(table.declarations.map((entry) => [entry.id, entry.name]));
  const declaredNames = new Set(named.map((entry) => entry.name));
  const hasNumericTable = table.declarations.length > 0;
  const referencedNames = new Set<string>();
  const referencesValid = table.references.every((reference) => {
    if (reference.id === null) {
      if (reference.name === null) return false;
      if (reference.name.length === 0) return true;
      referencedNames.add(reference.name);
      return !hasNumericTable || declaredNames.has(reference.name);
    }
    if (reference.id === 0) return reference.name === null || reference.name.length === 0;
    const declaredName = nameById.get(reference.id);
    if (declaredName !== undefined && declaredName.length > 0) referencedNames.add(declaredName);
    return declaredName !== undefined && (reference.name === null || reference.name === declaredName);
  });
  const actualNames = hasNumericTable ? named.map((entry) => entry.name) : [...referencedNames];
  const passed = reserved.every((entry) => entry.id === 0)
    && named.every((entry) => entry.id > 0)
    && referencesValid
    && named.every((entry) => referencedNames.has(entry.name))
    && sameStrings(actualNames, contract.nets.map((net) => net.name));
  return {
    status: passed ? "pass" : "fail",
    detail: passed
      ? `PCB references exactly the ${contract.nets.length} closed contract net name(s), with no unused named declarations.`
      : `PCB net declarations or numeric/name references differ from the closed contract: ${actualNames.join(", ") || "empty"}; references-valid=${referencesValid}.`,
  };
}

const identityMatches = (
  value: { readonly identity: unknown; readonly schemaVersion: string },
  expectedSchemaVersion: string,
): boolean => {
  try {
    const { identity, ...payload } = value;
    return value.schemaVersion === expectedSchemaVersion
      && canonicalJson(identity) === canonicalJson(canonicalIdentity(payload, expectedSchemaVersion));
  } catch {
    return false;
  }
};

const exactPlainDataRecord = (
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { return false; }
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
};

type DeterministicDeepRuleSelectionOptions = Omit<DeepRuleSelectionOptions, "tokenCounter">;

function parseDeterministicDeepRuleSelectionOptions(
  value: unknown,
): DeterministicDeepRuleSelectionOptions | null | undefined {
  if (value === undefined) return undefined;
  const allowed = ["maxRules", "maxPromptBytes", "maxPromptTokens", "featureCoveragePolicy"] as const;
  if (!exactPlainDataRecord(value, allowed)) return null;
  const positiveIntegerKeys = ["maxRules", "maxPromptBytes", "maxPromptTokens"] as const;
  for (const key of positiveIntegerKeys) {
    if (Object.hasOwn(value, key) && value[key] === undefined) return null;
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)) return null;
  }
  if (Object.hasOwn(value, "featureCoveragePolicy") && value.featureCoveragePolicy === undefined) return null;
  if (value.featureCoveragePolicy !== undefined
      && value.featureCoveragePolicy !== "require-all"
      && value.featureCoveragePolicy !== "report-incomplete") return null;
  return {
    ...(value.maxRules === undefined ? {} : { maxRules: value.maxRules as number }),
    ...(value.maxPromptBytes === undefined ? {} : { maxPromptBytes: value.maxPromptBytes as number }),
    ...(value.maxPromptTokens === undefined ? {} : { maxPromptTokens: value.maxPromptTokens as number }),
    ...(value.featureCoveragePolicy === undefined
      ? {}
      : { featureCoveragePolicy: value.featureCoveragePolicy as "require-all" | "report-incomplete" }),
  };
}

function clearanceChecks(
  value: unknown,
  contract: PcbDesignContract,
  pcbSource: string,
): ReadonlyMap<string, Check> {
  const checks = new Map<string, Check>();
  const all = (status: FreshDesignAcceptanceStatus, detail: string): ReadonlyMap<string, Check> => {
    for (const netClass of contract.netClasses) checks.set(netClass.id, { status, detail });
    return checks;
  };
  if (!exactPlainDataRecord(value, [
    "origin", "schemaVersion", "source", "pcbSha256", "rulesSourceSha256", "netClasses",
  ])) return all("unknown", "Host effective-clearance evidence is absent or violates its strict root schema.");
  if (value.origin !== "host"
      || value.schemaVersion !== FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION
      || value.source !== "kicad-effective-netclass-rules"
      || typeof value.pcbSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.pcbSha256)
      || value.pcbSha256 !== sha256(pcbSource)
      || typeof value.rulesSourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.rulesSourceSha256)
      || !Array.isArray(value.netClasses)) {
    return all("unknown", "Host effective-clearance evidence has an invalid source binding, schema identity, or source hash.");
  }
  const records = value.netClasses;
  if (records.length > 32 || records.some((entry) => !exactPlainDataRecord(entry, [
    "id", "configuredClearanceMm", "effectiveClearanceMm",
  ]))) return all("unknown", "Host effective-clearance class records violate the strict evidence schema.");
  const typed = records as readonly Record<string, unknown>[];
  if (typed.some((entry) =>
    typeof entry.id !== "string" || entry.id.length === 0
    || typeof entry.configuredClearanceMm !== "number" || !Number.isFinite(entry.configuredClearanceMm) || entry.configuredClearanceMm < 0
    || typeof entry.effectiveClearanceMm !== "number" || !Number.isFinite(entry.effectiveClearanceMm) || entry.effectiveClearanceMm < 0)) {
    return all("unknown", "Host effective-clearance class values are malformed.");
  }
  const ids = typed.map((entry) => entry.id as string);
  const inventoryExact = new Set(ids).size === ids.length
    && sameStrings(ids, contract.netClasses.map((netClass) => netClass.id));
  if (!inventoryExact) return all("fail", "Host effective-clearance class inventory differs from the closed contract.");
  for (const netClass of contract.netClasses) {
    const evidence = typed.find((entry) => entry.id === netClass.id)!;
    const configured = evidence.configuredClearanceMm as number;
    const effective = evidence.effectiveClearanceMm as number;
    const passed = configured + NUMERIC_EPSILON >= netClass.clearanceMm
      && effective + NUMERIC_EPSILON >= netClass.clearanceMm;
    checks.set(netClass.id, {
      status: passed ? "pass" : "fail",
      detail: passed
        ? `${netClass.id} configured/effective clearance ${configured.toFixed(3)}/${effective.toFixed(3)} mm meets contract minimum ${netClass.clearanceMm.toFixed(3)} mm.`
        : `${netClass.id} configured/effective clearance ${configured.toFixed(3)}/${effective.toFixed(3)} mm is below contract minimum ${netClass.clearanceMm.toFixed(3)} mm.`,
    });
  }
  return checks;
}

function libraryBindingCheck(
  contract: PcbDesignContract,
  binding: PcbLibraryBinding,
  resolver: PcbReadOnlyLibraryResolver,
): Readonly<{ valid: boolean; detail: string }> {
  try {
    const expectedSymbols: PcbLibraryBinding["symbols"][number][] = [];
    const expectedFootprints: PcbLibraryBinding["footprints"][number][] = [];
    for (const component of contract.components) {
      const symbol = normalizePcbResolvedSymbol(
        resolver.resolveSymbol(component.symbolLibId),
        component.symbolLibId,
      );
      const footprint = normalizePcbResolvedFootprint(
        resolver.resolveFootprint(component.footprintLibId),
        component.footprintLibId,
      );
      if (symbol === null || footprint === null) {
        return { valid: false, detail: `Trusted local-library resolver no longer resolves ${component.reference}.` };
      }
      const expectedSymbol: PcbLibraryBinding["symbols"][number] = {
        reference: component.reference,
        libraryId: component.symbolLibId,
        source: "kicad-stock" as const,
        unitCount: 1 as const,
        componentKind: symbol.componentKind as Exclude<typeof symbol.componentKind, "bga">,
        polarized: symbol.polarized,
        pins: [...symbol.pins]
          .map((pin) => ({ number: pin.number, function: pin.function }))
          .sort((left, right) => compareText(left.number, right.number)),
      };
      const expectedFootprint: PcbLibraryBinding["footprints"][number] = {
        reference: component.reference,
        libraryId: component.footprintLibId,
        source: "kicad-stock" as const,
        packageKind: "generic" as const,
        pads: [...footprint.pads].sort(compareText),
      };
      if (symbol.libraryId !== component.symbolLibId || symbol.source !== "kicad-stock"
          || symbol.unitCount !== 1 || symbol.componentKind === "bga"
          || symbol.polarized && symbol.pins.some((pin) => pin.function === null)
          || footprint.libraryId !== component.footprintLibId || footprint.source !== "kicad-stock"
          || footprint.packageKind !== "generic"
          || !sameStrings(symbol.pins.map((pin) => pin.number), component.pins.map((pin) => pin.pin))
          || !sameStrings(footprint.pads, component.pins.map((pin) => pin.pin))) {
        return { valid: false, detail: `Library binding for ${component.reference} differs from fresh trusted local-library resolution.` };
      }
      expectedSymbols.push(expectedSymbol);
      expectedFootprints.push(expectedFootprint);
    }
    expectedSymbols.sort((left, right) => compareText(left.reference, right.reference));
    expectedFootprints.sort((left, right) => compareText(left.reference, right.reference));
    if (Buffer.byteLength(JSON.stringify({ footprints: expectedFootprints, symbols: expectedSymbols }), "utf8")
        > PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxBindingProjectionBytes) {
      return { valid: false, detail: "Independently reconstructed library projection exceeds the compiler aggregate bound." };
    }
    const payload = {
      schemaVersion: PCB_LIBRARY_BINDING_SCHEMA_VERSION,
      contractIdentity: structuredClone(contract.identity),
      symbols: expectedSymbols,
      footprints: expectedFootprints,
    };
    const expected: PcbLibraryBinding = {
      ...payload,
      identity: canonicalIdentity(payload, PCB_LIBRARY_BINDING_SCHEMA_VERSION),
    };
    if (!identityMatches(binding, PCB_LIBRARY_BINDING_SCHEMA_VERSION)
        || canonicalJson(binding) !== canonicalJson(expected)) {
      return { valid: false, detail: "Complete library binding keys, ordering, content, or identity differ from canonical independent reconstruction." };
    }
  } catch {
    return { valid: false, detail: "Trusted local-library resolver failed during independent binding reproduction." };
  }
  return { valid: true, detail: "Complete canonical library binding independently reproduces from the contract and trusted local resolver." };
}

function deepRuleBindingCheck(
  contract: PcbDesignContract,
  libraryBinding: PcbLibraryBinding,
  catalogInput: DeepRuleCatalog,
  selectionOptionsInput: unknown,
  binding: PcbDeepRuleBinding,
): Readonly<{ valid: boolean; detail: string }> {
  try {
    const selectionOptions = parseDeterministicDeepRuleSelectionOptions(selectionOptionsInput);
    if (selectionOptions === null) {
      return { valid: false, detail: "Deep-rule selection options are not exact plain deterministic data." };
    }
    const catalog = validateDeepRuleCatalog(catalogInput);
    const expectedFeatures = deriveDeepRuleFeaturesFromContract(contract, libraryBinding);
    const expectedSelection = selectDeepRulesForDesign(catalog, expectedFeatures, selectionOptions);
    const payload = {
      schemaVersion: PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
      contractIdentity: structuredClone(contract.identity),
      catalogIdentity: canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1"),
      features: structuredClone(expectedFeatures),
      selection: structuredClone(expectedSelection),
    };
    const expected = {
      ...payload,
      identity: canonicalIdentity(payload, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION),
    };
    const valid = identityMatches(binding, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION)
      && canonicalJson(binding) === canonicalJson(expected);
    return valid
      ? { valid: true, detail: "Deep-rule catalog, features, selection, and binding identity independently reproduce." }
      : { valid: false, detail: "Deep-rule catalog, features, selection, or binding identity differs from independent regeneration." };
  } catch {
    return { valid: false, detail: "Deep-rule binding or trusted catalog is malformed and cannot be independently regenerated." };
  }
}

const encodePathToken = (value: string): string => {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    encoded += /[A-Za-z0-9_-]/u.test(character)
      ? character
      : `%${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
};

/**
 * Build the exact deterministic practice-analyzer profile used by generic
 * fresh-design acceptance.  Keeping this derivation public lets persisted
 * compilation artifacts bind the executable host policy instead of copying a
 * second, potentially drifting profile implementation.
 */
export function createFreshDesignPracticeProfile(
  contractInput: PcbDesignContract,
): PcbPracticeAnalysisProfile {
  const contract = parsePcbDesignContract(contractInput);
  const viaPolicy = contract.routingConstraints.viaPolicy;
  const viaRules = viaPolicy.mode === "bounded"
    ? [{
        id: "fresh-design-via",
        sourceRuleId: "fresh-design.contract.via-policy",
        severity: "error" as const,
        gates: ["human-review" as const],
        appliesTo: { netNames: contract.nets.map((net) => net.name) },
        minimumPadDiameterMm: viaPolicy.diameterMm,
        minimumDrillDiameterMm: viaPolicy.drillMm,
        minimumAnnularRingMm: viaPolicy.minimumAnnularRingMm,
        allowedLayerTransitions: [{ startLayer: "F.Cu", endLayer: "B.Cu" }],
      }]
    : [];
  return deepFreeze({
    schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: {
      mode: "production",
      supportedBoardVersions: [...PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS],
    },
    copperLayerOrder: ["F.Cu", "B.Cu"],
    netClasses: contract.netClasses.map((netClass) => ({
      id: netClass.id,
      sourceRuleId: `fresh-design.contract.net-class.${netClass.id}`,
      severity: "error",
      gates: ["human-review"],
      minimumTrackWidthMm: netClass.traceWidthMm,
      minimumInteriorAngleDeg: 180 - contract.routingConstraints.maximumTurnAngleDeg,
      interiorAngleDisposition: {
        sourceRuleId: "fresh-design.contract.maximum-turn",
        severity: "error",
        gates: ["human-review"],
      },
      minimumTraceToBoardEdgeMm: netClass.copperToEdgeMm,
      traceToBoardEdgeDisposition: {
        sourceRuleId: `fresh-design.contract.net-class.${netClass.id}.copper-to-edge`,
        severity: "error",
        gates: ["human-review"],
      },
    })),
    netClassByNet: Object.fromEntries(contract.nets.map((net) => [net.name, net.netClassId])),
    viaRules,
    advisories: {
      rightAngle: { sourceRuleId: "fresh-design.contract.no-right-angle", toleranceDeg: 0.01 },
      reversal: { sourceRuleId: "fresh-design.contract.no-backtracking", maximumInteriorAngleDeg: 2 },
      adjacentHairpin: {
        sourceRuleId: "fresh-design.contract.no-backtracking",
        parallelToleranceDeg: 0.25,
        maximumLegEdgeGapMm: 0.2,
        minimumParallelOverlapMm: 1,
        maximumConnectorPathLengthMm: 0.6,
      },
    },
    diagnostics: {
      invalidGeometrySourceRuleId: "fresh-design.native-geometry",
      unboundNetSourceRuleId: "fresh-design.exact-net-binding",
      unsupportedOutlineSourceRuleId: "fresh-design.outline-coverage",
      unsupportedRoutingSourceRuleId: "fresh-design.routing-coverage",
      junctionCoverageSourceRuleId: "fresh-design.turn-junction-coverage",
      containmentSourceRuleId: "fresh-design.board-containment",
      duplicateTrackSourceRuleId: "fresh-design.contract.no-duplicate-tracks",
    },
    coordinateToleranceMm: FRESH_DESIGN_COORDINATE_TOLERANCE_MM,
  });
}

const boundsClearance = (bounds: FreshBounds, outline: FreshBounds): Readonly<Record<"left" | "right" | "top" | "bottom", number>> => ({
  left: bounds.minX - outline.minX,
  right: outline.maxX - bounds.maxX,
  top: bounds.minY - outline.minY,
  bottom: outline.maxY - bounds.maxY,
});

const boundsDistance = (left: FreshBounds, right: FreshBounds): number => {
  const dx = Math.max(0, left.minX - right.maxX, right.minX - left.maxX);
  const dy = Math.max(0, left.minY - right.maxY, right.minY - left.maxY);
  return Math.hypot(dx, dy);
};

function placementCheck(
  placement: PcbDesignContract["placementConstraints"][number],
  board: FreshParsedPcb,
  contract: PcbDesignContract,
): Check {
  const matches = board.footprints.filter((footprint) => footprint.reference === placement.reference);
  if (matches.length !== 1) {
    return { status: "fail", detail: `${placement.reference} must occur exactly once on the PCB; observed ${matches.length}.` };
  }
  const footprint = matches[0]!;
  const outline = board.outlineBounds;
  if (outline === null || footprint.courtyardBounds === null) {
    return { status: "unknown", detail: `${placement.reference} lacks supported outline or courtyard geometry.` };
  }
  const expectedLayer = placement.side === "front" ? "F.Cu" : "B.Cu";
  const sidePass = footprint.layer === expectedLayer;
  const region = placement.regionMm;
  const regionPass = footprint.at.x >= region.minXmm - FRESH_DESIGN_COORDINATE_TOLERANCE_MM
    && footprint.at.x <= region.maxXmm + FRESH_DESIGN_COORDINATE_TOLERANCE_MM
    && footprint.at.y >= region.minYmm - FRESH_DESIGN_COORDINATE_TOLERANCE_MM
    && footprint.at.y <= region.maxYmm + FRESH_DESIGN_COORDINATE_TOLERANCE_MM;
  const actualRotation = normalizeRotation(footprint.rotationDeg);
  const rotationPass = placement.allowedRotationsDeg.some((allowed) =>
    Math.min(Math.abs(actualRotation - allowed), 360 - Math.abs(actualRotation - allowed))
      <= FRESH_DESIGN_ANGLE_TOLERANCE_DEG);
  const edgeClearances = boundsClearance(footprint.courtyardBounds, outline);
  const insideAndClear = Object.values(edgeClearances).every((clearance) =>
    clearance + FRESH_DESIGN_COORDINATE_TOLERANCE_MM >= placement.minimumEdgeClearanceMm);
  const edgePass = placement.edgePreference === "none"
    || edgeClearances[placement.edgePreference]
      <= Math.min(...Object.values(edgeClearances)) + FRESH_DESIGN_COORDINATE_TOLERANCE_MM;
  let courtyardPass = true;
  let courtyardKnown = true;
  for (const other of contract.placementConstraints) {
    if (other.reference === placement.reference) continue;
    const otherFootprint = board.footprints.find((candidate) => candidate.reference === other.reference);
    if (otherFootprint?.courtyardBounds === null || otherFootprint?.courtyardBounds === undefined) {
      courtyardKnown = false;
      continue;
    }
    const required = Math.max(placement.minimumCourtyardClearanceMm, other.minimumCourtyardClearanceMm);
    if (boundsDistance(footprint.courtyardBounds, otherFootprint.courtyardBounds)
        + FRESH_DESIGN_COORDINATE_TOLERANCE_MM < required) courtyardPass = false;
  }
  if (!courtyardKnown) {
    return { status: "unknown", detail: `${placement.reference} cannot prove every pairwise courtyard clearance.` };
  }
  const passed = sidePass && regionPass && rotationPass && insideAndClear && edgePass && courtyardPass;
  return passed
    ? {
        status: "pass",
        detail: `${placement.reference} satisfies ${placement.side} side, anchor region, allowed rotation, ${placement.minimumEdgeClearanceMm.toFixed(3)} mm edge, ${placement.minimumCourtyardClearanceMm.toFixed(3)} mm courtyard, and ${placement.edgePreference} edge-preference constraints.`,
      }
    : {
        status: "fail",
        detail: `${placement.reference} placement mismatch (side=${sidePass}, region=${regionPass}, rotation=${rotationPass}, edge-clearance=${insideAndClear}, courtyard=${courtyardPass}, edge-preference=${edgePass}).`,
      };
}

function exactRectangleCheck(board: FreshParsedPcb, analysis: PcbPracticeAnalysis | null, contract: PcbDesignContract): Check {
  if (board.outlineBounds === null || analysis === null) {
    return { status: "unknown", detail: "Supported parsed outline and deterministic outline analysis are both required." };
  }
  const edges = analysis.extracted.boardEdges;
  const lines = edges.filter((edge) => edge.kind === "line" && edge.start !== null && edge.end !== null);
  const bounds = board.outlineBounds;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const dimensionsPass = closeNumber(width, contract.scope.board.widthMm)
    && closeNumber(height, contract.scope.board.heightMm);
  const originPass = closeNumber(bounds.minX, 0) && closeNumber(bounds.minY, 0);
  const axisAligned = lines.length === 4 && lines.every((edge) =>
    closeNumber(edge.start!.x, edge.end!.x) !== closeNumber(edge.start!.y, edge.end!.y));
  const cornerKeys = new Map<string, number>();
  const key = (point: FreshPoint): string =>
    `${Math.round(point.x / FRESH_DESIGN_COORDINATE_TOLERANCE_MM)}:${Math.round(point.y / FRESH_DESIGN_COORDINATE_TOLERANCE_MM)}`;
  for (const edge of lines) {
    cornerKeys.set(key(edge.start!), (cornerKeys.get(key(edge.start!)) ?? 0) + 1);
    cornerKeys.set(key(edge.end!), (cornerKeys.get(key(edge.end!)) ?? 0) + 1);
  }
  const topologyPass = edges.length === 4 && lines.length === 4 && cornerKeys.size === 4
    && [...cornerKeys.values()].every((degree) => degree === 2)
    && analysis.summary.outlineComplete;
  const passed = board.outlineSupported && originPass && dimensionsPass && axisAligned && topologyPass;
  return {
    status: passed ? "pass" : "fail",
    detail: `Outline origin is (${bounds.minX.toFixed(4)}, ${bounds.minY.toFixed(4)}) mm, size ${width.toFixed(3)} x ${height.toFixed(3)} mm with ${edges.length} primitive(s); contract requires one closed axis-aligned ${contract.scope.board.widthMm.toFixed(3)} x ${contract.scope.board.heightMm.toFixed(3)} mm rectangle at (0, 0).`,
  };
}

const pointOnSegment = (point: FreshPoint, segment: PcbRoutedSegment): boolean => {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= NUMERIC_EPSILON) return closePoint(point, segment.start);
  const cross = Math.abs((point.x - segment.start.x) * dy - (point.y - segment.start.y) * dx) / length;
  if (cross > FRESH_DESIGN_COORDINATE_TOLERANCE_MM) return false;
  const dot = (point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy;
  return dot >= -FRESH_DESIGN_COORDINATE_TOLERANCE_MM
    && dot <= length * length + FRESH_DESIGN_COORDINATE_TOLERANCE_MM;
};

const properSegmentIntersection = (left: PcbRoutedSegment, right: PcbRoutedSegment): boolean => {
  const orientation = (a: FreshPoint, b: FreshPoint, c: FreshPoint): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const a = orientation(left.start, left.end, right.start);
  const b = orientation(left.start, left.end, right.end);
  const c = orientation(right.start, right.end, left.start);
  const d = orientation(right.start, right.end, left.end);
  const tolerance = FRESH_DESIGN_COORDINATE_TOLERANCE_MM;
  if (Math.abs(a) <= tolerance || Math.abs(b) <= tolerance || Math.abs(c) <= tolerance || Math.abs(d) <= tolerance) return false;
  return (a > 0) !== (b > 0) && (c > 0) !== (d > 0);
};

function findingTouchesNet(
  finding: PcbPracticeAnalysis["findings"][number],
  netName: string,
  analysis: PcbPracticeAnalysis,
): boolean {
  if (finding.observed.netName === netName) return true;
  const segmentOrdinals = new Set(analysis.extracted.segments
    .filter((segment) => segment.netName === netName)
    .map((segment) => segment.ordinal));
  const viaOrdinals = new Set(analysis.extracted.vias
    .filter((via) => via.netName === netName)
    .map((via) => via.ordinal));
  return finding.evidence.some((entry) =>
    entry.geometry.netName === netName
    || entry.location.form === "segment" && segmentOrdinals.has(entry.location.ordinal)
    || entry.location.form === "via" && viaOrdinals.has(entry.location.ordinal));
}

interface RouteGraphVertex {
  readonly point: FreshPoint;
  readonly layer: string | null;
  readonly padEndpoint: string | null;
}

interface RouteTopologyResult {
  readonly connected: boolean;
  readonly acyclic: boolean;
  readonly noDuplicateEdges: boolean;
  readonly leavesTerminateAtPads: boolean;
  readonly pointToPointSimplePath: boolean;
  readonly vertexCount: number;
  readonly edgeCount: number;
}

function buildRouteTopology(
  segments: readonly PcbRoutedSegment[],
  vias: readonly PcbViaGeometry[],
  padByEndpoint: ReadonlyMap<string, readonly FreshPcbPad[]>,
): RouteTopologyResult {
  const vertices: RouteGraphVertex[] = [];
  const adjacency: Array<Set<number>> = [];
  const edges = new Set<string>();
  let duplicateEdge = false;
  const addVertex = (point: FreshPoint, layer: string | null, padEndpoint: string | null, force = false): number => {
    if (!force) {
      const existing = vertices.findIndex((candidate) =>
        candidate.padEndpoint === null && candidate.layer === layer && closePoint(candidate.point, point));
      if (existing >= 0) return existing;
    }
    vertices.push({ point, layer, padEndpoint });
    adjacency.push(new Set());
    return vertices.length - 1;
  };
  const addEdge = (left: number, right: number): void => {
    if (left === right) {
      duplicateEdge = true;
      return;
    }
    const key = left < right ? `${left}:${right}` : `${right}:${left}`;
    if (edges.has(key)) {
      duplicateEdge = true;
      return;
    }
    edges.add(key);
    adjacency[left]!.add(right);
    adjacency[right]!.add(left);
  };
  const allSegmentEndpoints = segments.flatMap((segment) => [
    { point: segment.start, layer: segment.layer },
    { point: segment.end, layer: segment.layer },
  ]);
  for (const segment of segments) {
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const denominator = dx * dx + dy * dy;
    const splitPoints = [
      segment.start,
      segment.end,
      ...allSegmentEndpoints
        .filter((candidate) => candidate.layer === segment.layer && pointOnSegment(candidate.point, segment))
        .map((candidate) => candidate.point),
      ...vias
        .filter((via) => via.layers.includes(segment.layer) && pointOnSegment(via.at, segment))
        .map((via) => via.at),
      ...[...padByEndpoint.values()].flat().filter((pad) => physicalPadCopperLayers(pad).includes(segment.layer) && pointOnSegment(pad.at, segment)).map(pad => pad.at),
    ];
    const unique = splitPoints
      .filter((point, index, array) => array.findIndex((candidate) => closePoint(candidate, point)) === index)
      .sort((left, right) => {
        const leftT = denominator <= NUMERIC_EPSILON ? 0 : ((left.x - segment.start.x) * dx + (left.y - segment.start.y) * dy) / denominator;
        const rightT = denominator <= NUMERIC_EPSILON ? 0 : ((right.x - segment.start.x) * dx + (right.y - segment.start.y) * dy) / denominator;
        return leftT - rightT;
      });
    const indices = unique.map((point) => addVertex(point, segment.layer, null));
    for (let index = 0; index + 1 < indices.length; index += 1) addEdge(indices[index]!, indices[index + 1]!);
  }
  for (const via of vias) {
    addEdge(
      addVertex(via.at, via.layers[0], null),
      addVertex(via.at, via.layers[1], null),
    );
  }
  const padVertices = new Set<number>();
  const attachedEndpoints = new Set<string>();
  for (const [endpoint, pads] of padByEndpoint) {
    // One local contact site per logical terminal/layer, not one artificial
    // leaf for every overlapping EP primitive. This never contracts a native
    // cluster reached through external routing into an intrinsic pad bridge.
    const sites = new Map<string, {point:FreshPoint;layers:Set<string>;plated:boolean}>();
    for (const pad of pads) {
      const copper = physicalPadCopperLayers(pad);
      const plated = pad.physical.padType === "thru_hole" && pad.physical.drill !== null;
      const key = canonicalJson([pad.at.x,pad.at.y]);
      const site = sites.get(key) ?? {point:pad.at,layers:new Set<string>(),plated:false};
      for (const layer of copper) site.layers.add(layer);
      site.plated ||= plated; sites.set(key,site);
    }
    for (const site of sites.values()) {
      const matches = vertices.map((candidate,index)=>({candidate,index})).filter(({candidate})=>candidate.layer!==null && site.layers.has(candidate.layer) && closePoint(candidate.point,site.point));
      const groups = site.plated ? [matches] : [...site.layers].map(layer=>matches.filter(match=>match.candidate.layer===layer));
      for (const group of groups) {
        if (group.length===0) continue;
        // A physical contact labels the existing copper graph vertex. It is
        // not an additional electrical leaf for every repeated EP primitive.
        attachedEndpoints.add(endpoint);
        for (const match of group) {
          padVertices.add(match.index);
          vertices[match.index]={...vertices[match.index]!,padEndpoint:endpoint};
        }
        if(site.plated)for(let index=1;index<group.length;index++){
          const left=group[0]!.index,right=group[index]!.index;
          if(left!==right&&!adjacency[left]!.has(right))addEdge(left,right);
        }
      }
    }
  }
  const visited = new Set<number>();
  if (vertices.length > 0) {
    const pending = [0];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency[current]!) pending.push(neighbor);
    }
  }
  const connected = vertices.length > 0 && visited.size === vertices.length;
  const acyclic = connected && edges.size === vertices.length - 1;
  const leafIndices = adjacency.flatMap((neighbors, index) => neighbors.size === 1 ? [index] : []);
  const leavesTerminateAtPads = leafIndices.every((index) => vertices[index]!.padEndpoint !== null)
    && [...padVertices].every((index) => adjacency[index]!.size > 0) && attachedEndpoints.size === padByEndpoint.size;
  const pointToPointSimplePath = connected && acyclic && padByEndpoint.size === 2
    && leafIndices.length === 2
    && leafIndices.every((index) => vertices[index]!.padEndpoint !== null)
    && new Set(leafIndices.map(index=>vertices[index]!.padEndpoint)).size===2
    && adjacency.every((neighbors) => neighbors.size <= 2);
  return {
    connected,
    acyclic,
    noDuplicateEdges: !duplicateEdge,
    leavesTerminateAtPads,
    pointToPointSimplePath,
    vertexCount: vertices.length,
    edgeCount: edges.size,
  };
}
/** Shared source-geometry topology for host authoring checks; native reachability stays separate. */
export { buildRouteTopology as buildFreshPhysicalRouteTopology };

function physicalPadCopperLayers(pad: FreshPcbPad): readonly string[] {
  if (pad.number.length === 0) return [];
  // Layer selectors alone do not make an NPTH/mechanical or unknown primitive
  // an electrical endpoint. Keep source-only behavior inside the characterized
  // SMD/no-drill and plated-through-hole/real-drill combinations as well.
  if (pad.physical.padType === "smd") {
    if (pad.physical.drill !== null) return [];
  } else if (pad.physical.padType === "thru_hole") {
    if (pad.physical.drill === null || pad.physical.drill.sizeMm.x <= 0 || pad.physical.drill.sizeMm.y <= 0) return [];
  } else return [];
  return [...new Set(pad.layers.flatMap(layer=>layer==="*.Cu"?["F.Cu","B.Cu"]:layer==="F.Cu"||layer==="B.Cu"?[layer]:[]))];
}

function needsNativePhysicalPadEvidence(footprint: FreshPcbFootprint): boolean {
  return footprint.pads.some(pad=>pad.number.length===0) || new Set(footprint.pads.map(pad=>pad.number)).size!==footprint.pads.length;
}

function routedNetCheck(
  net: PcbDesignContract["nets"][number],
  contract: PcbDesignContract,
  board: FreshParsedPcb,
  analysis: PcbPracticeAnalysis,
  drcPassed: boolean | null,
  uncoveredZonesPresent: boolean,
  pcbNetInventory: Check,
  nativePads: KicadNativePadObservation | null,
  nativePadProblem: string,
): Check {
  if (nativePadProblem) return {status:"fail",detail:nativePadProblem};
  if (drcPassed === null) return { status: "unknown", detail: `${net.name} routing cannot be accepted without exact native DRC evidence.` };
  if (!drcPassed) return { status: "fail", detail: `${net.name} routing cannot be accepted while native DRC is failing.` };
  if (pcbNetInventory.status !== "pass") {
    return {
      status: pcbNetInventory.status,
      detail: `${net.name} routing cannot be accepted: ${pcbNetInventory.detail}`,
    };
  }
  if (uncoveredZonesPresent && !analysis.summary.completeBoardGeometryCoverage) {
    return {
      status: "fail",
      detail: `${net.name} routing cannot be proven while unmodeled zone copper is present; closed V1 declares no zone policy or verified zone evidence.`,
    };
  }
  const route = contract.routingConstraints.nets.find((entry) => entry.net === net.name)!;
  const netClass = contract.netClasses.find((entry) => entry.id === net.netClassId)!;
  const segments = analysis.extracted.segments.filter((segment) => segment.netName === net.name);
  const vias = analysis.extracted.vias.filter((via) => via.netName === net.name);
  const unexpectedCopper = analysis.extracted.segments.some((segment) =>
    segment.netName === null || !contract.nets.some((candidate) => candidate.name === segment.netName))
    || analysis.extracted.vias.some((via) =>
      via.netName === null || !contract.nets.some((candidate) => candidate.name === via.netName));
  if (unexpectedCopper) return { status: "fail", detail: "PCB contains routed copper outside the closed contract net set." };
  if (analysis.extracted.routedArcs.some((arc) => arc.netName === net.name)) {
    return { status: "fail", detail: `${net.name} contains routed arcs, but the closed routing style is miter_45.` };
  }
  const padByEndpoint = new Map<string, readonly FreshPcbPad[]>();
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads) {
      const expected = net.endpoints.some((endpoint) => endpoint.reference === footprint.reference && endpoint.pin === pad.number);
      if (expected && pad.netName === net.name && physicalPadCopperLayers(pad).length>0) {
        const key=endpointKey(footprint.reference,pad.number);
        padByEndpoint.set(key,[...(padByEndpoint.get(key)??[]),pad]);
      }
    }
  }
  if (padByEndpoint.size !== net.endpoints.length) {
    return { status: "fail", detail: `${net.name} lacks one or more exact PCB pad endpoints or has a pad assigned to the wrong net.` };
  }
  if (segments.length === 0) return { status: "fail", detail: `${net.name} has no routed copper segments.` };
  if (route.topology === "point_to_point" && net.endpoints.length !== 2) {
    return { status: "fail", detail: `${net.name} declares point_to_point topology but has ${net.endpoints.length} endpoints.` };
  }
  const invalidLayer = segments.some((segment) =>
    !netClass.allowedLayers.includes(segment.layer as "F.Cu" | "B.Cu")
    || route.preferredLayer !== "either" && segment.layer !== route.preferredLayer);
  if (invalidLayer) return { status: "fail", detail: `${net.name} uses copper outside its allowed/preferred layer policy.` };
  const relevantFootprints=board.footprints.filter(fp=>net.endpoints.some(endpoint=>endpoint.reference===fp.reference));
  if (relevantFootprints.some(needsNativePhysicalPadEvidence) && nativePads===null) {
    return {status:"unknown",detail:`${net.name} requires current native physical-pad/layer/cluster evidence for repeated terminals or non-electrical footprint features.`};
  }
  if (nativePads!==null) {
    const contacts=[...padByEndpoint].map(([endpoint,pads])=>({endpoint,ids:pads.filter(pad=>segments.some(segment=>physicalPadCopperLayers(pad).includes(segment.layer)&&pointOnSegment(pad.at,segment))).map(pad=>pad.physical.id).filter((id):id is string=>id!==null)}));
    if(contacts.some(contact=>contact.ids.length===0))return {status:"fail",detail:`${net.name} does not reach every logical terminal on an actual pad copper layer.`};
    const queries=new Map(nativePads.clusters.queries.filter(q=>q.sourceUuids.length===1).map(q=>[q.sourceUuids[0]!,q]));
    const contactIds=[...new Set(contacts.flatMap(contact=>contact.ids))];
    if(contactIds.some(id=>!queries.has(id)))return {status:"unknown",detail:`${net.name} is missing a native single-source query for a contacted physical pad.`};
    const observedSets=contactIds.map(id=>new Set(queries.get(id)!.returnedPadUuids));
    for(let a=0;a<observedSets.length;a++)for(let b=a+1;b<observedSets.length;b++){
      const left=observedSets[a]!,right=observedSets[b]!;
      if([...left].some(id=>right.has(id))&&(left.size!==right.size||[...left].some(id=>!right.has(id))))return {status:"fail",detail:`${net.name} has contradictory intersecting complete native pad clusters.`};
    }
    if(observedSets.some(set=>[...set].some(id=>nativePads.inventory?.physicalPads.find(p=>p.uuid===id)?.netName!==net.name)))return {status:"fail",detail:`${net.name} native cluster includes a different net or unknown physical pad.`};
    if(!observedSets.some(set=>contacts.every(contact=>contact.ids.some(id=>set.has(id)))))return {status:"fail",detail:`${net.name} logical terminals are not joined by native physical copper reachability.`};
    // Native reachability does not contract routing edges. The independent
    // source topology/turn/width/via checks below still inspect every track.
  }
  const totalLength = segments.reduce((sum, segment) => sum + segment.lengthMm, 0);
  if (route.routeLength.mode === "bounded" && totalLength > route.routeLength.maximumMm + NUMERIC_EPSILON) {
    return { status: "fail", detail: `${net.name} route length ${totalLength.toFixed(3)} mm exceeds ${route.routeLength.maximumMm.toFixed(3)} mm.` };
  }

  const topology = buildRouteTopology(segments, vias, padByEndpoint);
  const topologyPass = topology.connected && topology.acyclic && topology.noDuplicateEdges
    && topology.leavesTerminateAtPads
    && (route.topology === "tree" || topology.pointToPointSimplePath);
  if (!topologyPass) {
    return {
      status: "fail",
      detail: `${net.name} violates ${route.topology} topology (connected=${topology.connected}, acyclic=${topology.acyclic}, duplicate-edges=${!topology.noDuplicateEdges}, pad-terminated-leaves=${topology.leavesTerminateAtPads}, simple-path=${topology.pointToPointSimplePath}, vertices=${topology.vertexCount}, edges=${topology.edgeCount}).`,
    };
  }
  return {
    status: "pass",
    detail: `${net.name} joins all ${net.endpoints.length} exact pads as one connected acyclic ${route.topology} copper graph with pad-terminated leaves and no duplicate edges; routed length ${totalLength.toFixed(3)} mm.`,
  };
}

function widthCheck(
  netClass: PcbDesignContract["netClasses"][number],
  contract: PcbDesignContract,
  analysis: PcbPracticeAnalysis,
): Check {
  const names = new Set(contract.nets.filter((net) => net.netClassId === netClass.id).map((net) => net.name));
  const segments = analysis.extracted.segments.filter((segment) => segment.netName !== null && names.has(segment.netName));
  const everyNetCovered = [...names].every((name) => segments.some((segment) => segment.netName === name));
  if (!everyNetCovered) return { status: "unknown", detail: `Net class ${netClass.id} lacks width-bearing segments for one or more assigned nets.` };
  const passed = segments.every((segment) => segment.widthMm + NUMERIC_EPSILON >= netClass.traceWidthMm);
  return {
    status: passed ? "pass" : "fail",
    detail: passed
      ? `Every ${netClass.id} segment is at least the contract width ${netClass.traceWidthMm.toFixed(3)} mm.`
      : `At least one ${netClass.id} segment is below the contract width ${netClass.traceWidthMm.toFixed(3)} mm.`,
  };
}

function turnCheck(
  netName: string,
  contract: PcbDesignContract,
  analysis: PcbPracticeAnalysis,
): Check {
  const turns = analysis.extracted.turns.filter((turn) => turn.netName === netName);
  const segmentByOrdinal = new Map(analysis.extracted.segments.map((segment) => [segment.ordinal, segment]));
  const maximum = contract.routingConstraints.maximumTurnAngleDeg + FRESH_DESIGN_ANGLE_TOLERANCE_DEG;
  const anglePass = turns.every((turn) => turn.directionChangeDeg <= maximum + NUMERIC_EPSILON);
  const straightPass = turns.every((turn) => turn.segmentOrdinals.every((ordinal) =>
    (segmentByOrdinal.get(ordinal)?.lengthMm ?? -1) + NUMERIC_EPSILON
      >= contract.routingConstraints.minimumStraightBeforeTurnMm));
  const forbiddenCodes = new Set<string>([
    ...(contract.routingConstraints.allowRightAngleCorners ? [] : ["RIGHT_ANGLE_TURN_ADVISORY"]),
    ...(contract.routingConstraints.allowBacktracking ? [] : ["CONNECTED_REVERSAL_CANDIDATE", "ADJACENT_PARALLEL_HAIRPIN_CANDIDATE"]),
    "DUPLICATE_ROUTED_TRACK",
    "OVERLAPPING_ROUTED_TRACKS",
  ]);
  const findingsPass = !analysis.findings.some((finding) =>
    forbiddenCodes.has(finding.code)
    && findingTouchesNet(finding, netName, analysis));
  const segments = analysis.extracted.segments.filter((segment) => segment.netName === netName);
  let selfIntersectionPass = true;
  if (!contract.routingConstraints.allowSelfIntersections) {
    for (let left = 0; left < segments.length; left += 1) {
      for (let right = left + 1; right < segments.length; right += 1) {
        if (segments[left]!.layer === segments[right]!.layer
            && properSegmentIntersection(segments[left]!, segments[right]!)) selfIntersectionPass = false;
      }
    }
  }
  const acutePass = contract.routingConstraints.allowAcuteInteriorCorners
    || turns.every((turn) => turn.interiorAngleDeg + FRESH_DESIGN_ANGLE_TOLERANCE_DEG >= 90);
  const passed = anglePass && straightPass && findingsPass && selfIntersectionPass && acutePass;
  if (!passed) {
    return {
      status: "fail",
      detail: `${netName} violates one or more closed turn/geometry constraints (angle=${anglePass}, straight=${straightPass}, findings=${findingsPass}, acute=${acutePass}, self-intersection=${selfIntersectionPass}).`,
    };
  }
  if (!analysis.summary.routingCoverageComplete) {
    return { status: "unknown", detail: `${netName} has no detected violation, but turn acceptance requires complete deterministic routing coverage.` };
  }
  return {
    status: "pass",
    detail: `${netName} has no turn above ${contract.routingConstraints.maximumTurnAngleDeg.toFixed(2)} deg, short pre-turn leg, right angle, acute interior, backtrack/hairpin, duplicate/overlap, or self-intersection.`,
  };
}

function viaCheck(
  netName: string,
  contract: PcbDesignContract,
  analysis: PcbPracticeAnalysis,
): Check {
  const policy = contract.routingConstraints.viaPolicy;
  const route = contract.routingConstraints.nets.find((entry) => entry.net === netName)!;
  const vias = analysis.extracted.vias.filter((via) => via.netName === netName);
  const totalPass = analysis.extracted.vias.length <= policy.maxTotal;
  const perNetPass = vias.length <= route.maxVias;
  const boundPass = analysis.extracted.vias.every((via) => via.netName !== null
    && contract.nets.some((net) => net.name === via.netName));
  let geometryPass = true;
  if (policy.mode === "forbidden") geometryPass = analysis.extracted.vias.length === 0;
  else geometryPass = vias.every((via) =>
    via.padDiameterMm + NUMERIC_EPSILON >= policy.diameterMm
    && via.drillDiameterMm + NUMERIC_EPSILON >= policy.drillMm
    && via.annularRingMm + NUMERIC_EPSILON >= policy.minimumAnnularRingMm);
  const classId = contract.nets.find((net) => net.name === netName)!.netClassId;
  const allowedLayers = contract.netClasses.find((netClass) => netClass.id === classId)!.allowedLayers;
  const layersPass = vias.every((via) => via.layers.every((layer) => allowedLayers.includes(layer as "F.Cu" | "B.Cu")));
  const findingCodes = new Set([
    "VIA_GEOMETRY_BELOW_BOUND_MINIMUM", "VIA_GEOMETRY_INVALID", "VIA_GEOMETRY_UNSUPPORTED",
    "VIA_INCIDENT_LAYER_OUTSIDE_SPAN", "VIA_LAYER_TRANSITION_NOT_ALLOWED", "VIA_NET_CLASS_UNBOUND", "VIA_RULE_UNBOUND",
  ]);
  const analyzerPass = !analysis.findings.some((finding) =>
    findingCodes.has(finding.code)
    && findingTouchesNet(finding, netName, analysis));
  const passed = totalPass && perNetPass && boundPass && geometryPass && layersPass && analyzerPass;
  return {
    status: passed ? "pass" : "fail",
    detail: `${netName} has ${vias.length} via(s); per-net maximum ${route.maxVias}, global ${analysis.extracted.vias.length}/${policy.maxTotal}; geometry=${geometryPass}, layers=${layersPass}, analyzer=${analyzerPass}.`,
  };
}

function componentBindingChecks(
  component: PcbDesignContract["components"][number],
  binding: PcbLibraryBinding,
): Readonly<{ symbol: Check; footprint: Check }> {
  const symbols = binding.symbols.filter((entry) => entry.reference === component.reference);
  const footprints = binding.footprints.filter((entry) => entry.reference === component.reference);
  const expectedPins = component.pins.map((pin) => pin.pin);
  const symbolPass = symbols.length === 1
    && symbols[0]!.libraryId === component.symbolLibId
    && symbols[0]!.source === "kicad-stock"
    && symbols[0]!.unitCount === 1
    && sameStrings(symbols[0]!.pins.map((pin) => pin.number), expectedPins);
  const footprintPass = footprints.length === 1
    && footprints[0]!.libraryId === component.footprintLibId
    && footprints[0]!.source === "kicad-stock"
    && sameStrings(footprints[0]!.pads, expectedPins);
  return {
    symbol: {
      status: symbolPass ? "pass" : "fail",
      detail: symbolPass
        ? `${component.reference} exact stock symbol and complete pin-number set match the contract.`
        : `${component.reference} symbol binding differs from the contract or complete pin set.`,
    },
    footprint: {
      status: footprintPass ? "pass" : "fail",
      detail: footprintPass
        ? `${component.reference} exact stock footprint and complete pad-number set match the contract.`
        : `${component.reference} footprint binding differs from the contract or complete pad set.`,
    },
  };
}

const schematicComponentCheck = (
  component: PcbDesignContract["components"][number],
  schematic: ReturnType<typeof parseFreshSchematicSource>,
  inventoryExact: boolean,
): Check => {
  const matches = schematic.symbols.filter((symbol) => symbol.reference === component.reference);
  const passed = inventoryExact && matches.length === 1
    && matches[0]!.libId === component.symbolLibId
    && matches[0]!.value === component.value
    && matches[0]!.footprint === component.footprintLibId;
  return {
    status: passed ? "pass" : "fail",
    detail: passed
      ? `${component.reference} exists exactly once with exact symbol, value, and footprint properties.`
      : `${component.reference} schematic identity mismatch or the schematic inventory contains a missing, duplicate, or unexpected symbol.`,
  };
};

const pcbComponentCheck = (
  component: PcbDesignContract["components"][number],
  board: FreshParsedPcb,
  inventoryExact: boolean,
  pcbNetInventory: Check,
  allowedFootprintLeaf: string | undefined,
  nativePads: KicadNativePadObservation | null,
  nativePadProblem: string,
): Check => {
  if (nativePadProblem) return {status:"fail",detail:nativePadProblem};
  if (pcbNetInventory.status !== "pass") {
    return {
      status: pcbNetInventory.status,
      detail: `${component.reference} PCB identity cannot be accepted: ${pcbNetInventory.detail}`,
    };
  }
  const matches = board.footprints.filter((footprint) => footprint.reference === component.reference);
  const expectedNetByPin = new Map(component.pins.map((pin) => [pin.pin, pin.assignment.kind === "net" ? pin.assignment.net : null]));
  if(matches.length===1 && needsNativePhysicalPadEvidence(matches[0]!) && nativePads===null)return {status:"unknown",detail:`${component.reference} needs current host-native physical feature and logical-terminal evidence; paste apertures are not pins.`};
  if(nativePads!==null && !nativePads.physicalLibraryBindings.some(binding=>binding.reference===component.reference&&binding.libraryId===component.footprintLibId))return {status:"unknown",detail:`${component.reference} lacks current source-pinned physical library preservation evidence.`};
  const electrical=matches[0]?.pads.filter(pad=>pad.number.length>0&&physicalPadCopperLayers(pad).length>0)??[];
  const nonElectricalValid=matches[0]?.pads.every(pad=>pad.number.length>0?physicalPadCopperLayers(pad).length>0:pad.physical.padType==="smd"&&pad.netName===null&&pad.layers.length>0&&pad.layers.every(layer=>layer==="F.Paste"||layer==="B.Paste"))??false;
  const logicalNumbers=[...new Set(electrical.map(pad=>pad.number))];
  const observedTerminals=nativePads?.inventory?.terminals.filter(terminal=>terminal.reference===component.reference);
  const passed = inventoryExact && matches.length === 1
    && (matches[0]!.libraryId === component.footprintLibId
      || allowedFootprintLeaf !== undefined && !matches[0]!.libraryId.includes(":") && matches[0]!.libraryId === allowedFootprintLeaf)
    && matches[0]!.value === component.value
    && nonElectricalValid && sameStrings(logicalNumbers, component.pins.map((pin) => pin.pin))
    && electrical.every((pad) => pad.netName === expectedNetByPin.get(pad.number))
    && (observedTerminals===undefined||sameStrings(observedTerminals.map(t=>t.number),logicalNumbers)&&observedTerminals.every(t=>t.eligibleForPinMatching));
  return {
    status: passed ? "pass" : "fail",
    detail: passed
      ? `${component.reference} PCB footprint/value, complete logical terminal set, every physical member's net, and non-electrical feature classification match${nativePads===null?"":" with source-pinned physical library preservation"}.`
      : `${component.reference} PCB identity/pad mismatch or the PCB footprint inventory contains a missing, duplicate, or unexpected footprint.`,
  };
};

/**
 * Evaluate only regenerated host rows. A supplied acceptance plan is compared
 * with the regenerated plan but is never used as executable policy.
 */
export function evaluateFreshDesignAcceptance(
  evidence: FreshDesignAcceptanceEvidence,
  artifacts: FreshDesignAcceptanceArtifacts,
): FreshDesignAcceptanceResult {
  const contract = parsePcbDesignContract(artifacts.contract);
  let nativePads: KicadNativePadObservation | null = null;
  let nativePadProblem = "";
  if(evidence.nativePads!==undefined||artifacts.nativePadExpected!==undefined){
    try{
      if(evidence.nativePads===undefined||artifacts.nativePadExpected===undefined||artifacts.nativePadExpected.pcbSource!==evidence.pcbSource)throw new Error("Missing or stale native pad source/expected binding.");
      nativePads=verifyHostKicadNativePadObservation(evidence.nativePads,artifacts.nativePadExpected);
    }catch(error){nativePadProblem=`Native physical-pad evidence rejected: ${error instanceof Error?error.message:String(error)}`;}
  }
  const libraryIntegrity = libraryBindingCheck(contract, artifacts.libraryBinding, artifacts.libraryResolver);
  const deepRuleIntegrity = deepRuleBindingCheck(
    contract,
    artifacts.libraryBinding,
    artifacts.deepRuleCatalog,
    artifacts.deepRuleSelectionOptions,
    artifacts.deepRuleBinding,
  );
  const legacyPlan = artifacts.acceptancePlan.schemaVersion === PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION;
  const expectedPlan = (legacyPlan ? createPcbAcceptancePlanV1 : createPcbAcceptancePlan)(contract, artifacts.libraryBinding, artifacts.deepRuleBinding);
  let suppliedPlanMatches = false;
  try {
    suppliedPlanMatches = identityMatches(artifacts.acceptancePlan, legacyPlan ? PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION : PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION)
      && canonicalJson(artifacts.acceptancePlan) === canonicalJson(expectedPlan);
  } catch {
    suppliedPlanMatches = false;
  }
  const expectedPracticeProfile = createFreshDesignPracticeProfile(contract);
  let suppliedPracticeProfileMatches = artifacts.practiceProfile === undefined;
  if (artifacts.practiceProfile !== undefined) {
    try { suppliedPracticeProfileMatches = canonicalJson(artifacts.practiceProfile) === canonicalJson(expectedPracticeProfile); }
    catch { suppliedPracticeProfileMatches = false; }
  }
  const integrityPass = libraryIntegrity.valid && deepRuleIntegrity.valid && suppliedPlanMatches && suppliedPracticeProfileMatches;

  const erc = nativeValidatorCheck(evidence.erc, "erc");
  const drc = nativeValidatorCheck(evidence.drc, "drc");
  const clearances = clearanceChecks(evidence.clearance, contract, evidence.pcbSource);
  const uncoveredZonesPresent = hasTopLevelForm(evidence.pcbSource, "zone");
  const pcbNetInventory = pcbNetInventoryCheck(evidence.pcbSource, contract);
  let schematic: ReturnType<typeof parseFreshSchematicSource> | null = null;
  let netlist: ReturnType<typeof parseFreshNetlistSource> | null = null;
  let board: FreshParsedPcb | null = null;
  let schematicProblem = "";
  let netlistProblem = "";
  let boardProblem = "";
  try { schematic = parseFreshSchematicSource(evidence.schematicSource); }
  catch (error) { schematicProblem = error instanceof FreshKicadParseError ? error.message : "Schematic parsing failed unexpectedly."; }
  try { netlist = parseFreshNetlistSource(evidence.netlistSource); }
  catch (error) { netlistProblem = error instanceof FreshKicadParseError ? error.message : "Native netlist parsing failed unexpectedly."; }
  try { board = parseFreshPcbSource(evidence.pcbSource); }
  catch (error) { boardProblem = error instanceof FreshKicadParseError ? error.message : "PCB parsing failed unexpectedly."; }

  let analysis: PcbPracticeAnalysis | null = null;
  let analysisProblem = "";
  if (board !== null && board.version !== null) {
    if (board.segments.length > FRESH_DESIGN_ACCEPTANCE_LIMITS.maximumParsedSegments
        || board.viaCount > FRESH_DESIGN_ACCEPTANCE_LIMITS.maximumParsedVias) {
      analysisProblem = "PCB routing evidence exceeds the bounded generic acceptance limits.";
    } else {
      try {
        analysis = analyzeKicadPcbPractices(
          evidence.pcbSource,
          suppliedPracticeProfileMatches && artifacts.practiceProfile !== undefined
            ? artifacts.practiceProfile
            : expectedPracticeProfile,
          { sourcePath: "<fresh-design.kicad_pcb>" },
        );
      } catch (error) {
        analysisProblem = error instanceof Error ? error.message : "PCB practice analysis failed unexpectedly.";
      }
    }
  } else analysisProblem = boardProblem || "PCB version is unavailable.";

  const checks = new Map<string, Check>();
  checks.set("contract:integrity", {
    status: integrityPass ? "pass" : "fail",
    detail: integrityPass
      ? "Closed contract, exact local-library binding, deep-rule binding, and regenerated host acceptance plan identities reproduce."
      : `Acceptance artifact integrity mismatch (library=${libraryIntegrity.valid}, deep-rules=${deepRuleIntegrity.valid}, plan=${suppliedPlanMatches}, practice-profile=${suppliedPracticeProfileMatches}).`,
  });

  const expectedReferences = contract.components.map((component) => component.reference);
  const schematicScopeExact = schematic !== null && schematic.childSheetCount === contract.scope.sheetCount - 1;
  const schematicClassSourcesExact = schematic !== null && freshSchematicClassSourcesSupported(schematic);
  const schematicLabelsExact = schematic !== null
    && freshGlobalLabelInventoryMatches(schematic, contract.nets.map((net) => net.name));
  const schematicInventoryExact = schematic !== null
    && schematicScopeExact
    && sameStrings(schematic.symbols.map((symbol) => symbol.reference), expectedReferences);
  const pcbInventoryExact = board !== null
    && sameStrings(board.footprints.map((footprint) => footprint.reference), expectedReferences);
  const expectedNoConnectCount = contract.components.reduce(
    (count, component) => count + component.pins.filter((pin) => pin.assignment.kind === "no_connect").length,
    0,
  );
  const intentionalNoConnectNets = netlist?.nets.filter((net) =>
    /^unconnected-\(.+\)$/u.test(net.name)
    && net.nodes.length === 1
    && net.nodes[0]!.pinType.split("+").includes("no_connect")) ?? [];
  const functionalNets = netlist?.nets.filter((net) => !intentionalNoConnectNets.includes(net)) ?? [];
  const malformedNoConnectSemantics = functionalNets.some((net) =>
    /^unconnected-\(/u.test(net.name)
    || net.nodes.some((node) => node.pinType.split("+").includes("no_connect")));
  const actualNoConnectEndpoints = intentionalNoConnectNets.map((net) =>
    endpointKey(net.nodes[0]!.reference, net.nodes[0]!.pin));
  const expectedNoConnectEndpoints = contract.components.flatMap((component) => component.pins.flatMap((pin) =>
    pin.assignment.kind === "no_connect" ? [endpointKey(component.reference, pin.pin)] : []));
  const nativeNoConnectEndpointsExact = !malformedNoConnectSemantics
    && sameStrings(actualNoConnectEndpoints, expectedNoConnectEndpoints);
  const actualNetByEndpoint = new Map<string, string>();
  if (netlist !== null) {
    for (const net of functionalNets) {
      for (const endpoint of net.nodes) actualNetByEndpoint.set(endpointKey(endpoint.reference, endpoint.pin), net.name);
    }
  }
  const netlistReferencesExact = netlist !== null && sameStrings(netlist.references, expectedReferences);
  const netlistComponentIdentitiesExact = netlist !== null && contract.components.every((component) => {
    const matches = netlist!.components.filter((candidate) => candidate.reference === component.reference);
    return matches.length === 1
      && matches[0]!.symbolLibId === component.symbolLibId
      && matches[0]!.value === component.value
      && matches[0]!.footprintLibId === component.footprintLibId;
  });
  const expectedConnectedEndpoints = contract.components.flatMap((component) => component.pins.flatMap((pin) =>
    pin.assignment.kind === "net" ? [endpointKey(component.reference, pin.pin)] : []));
  const assignedEndpointInventoryExact = netlist !== null
    && sameStrings([...actualNetByEndpoint.keys()], expectedConnectedEndpoints);
  const noConnectCountExact = schematic !== null && schematic.noConnectCount === expectedNoConnectCount;
  const allowedFootprintLeaves = new Map<string, string>();
  if (libraryIntegrity.valid && netlistReferencesExact && netlistComponentIdentitiesExact) {
    // Match the host author's unique rebinding rule, using acceptance's own
    // independently reproduced local-library ledger and exact native identities.
    // A qualified but wrong library ID is never reduced to its leaf.
    const fullIdsByLeaf = new Map<string, Set<string>>();
    for (const footprint of artifacts.libraryBinding.footprints) {
      const leaf = footprint.libraryId.slice(footprint.libraryId.indexOf(":") + 1);
      const fullIds = fullIdsByLeaf.get(leaf) ?? new Set<string>();
      fullIds.add(footprint.libraryId);
      fullIdsByLeaf.set(leaf, fullIds);
    }
    for (const component of contract.components) {
      const leaf = component.footprintLibId.slice(component.footprintLibId.indexOf(":") + 1);
      if (fullIdsByLeaf.get(leaf)?.size === 1 && fullIdsByLeaf.get(leaf)!.has(component.footprintLibId)) {
        allowedFootprintLeaves.set(component.reference, leaf);
      }
    }
  }

  for (const component of contract.components) {
    const encodedReference = encodePathToken(component.reference);
    const bindingChecks = componentBindingChecks(component, artifacts.libraryBinding);
    checks.set(`library:${encodedReference}:symbol`, bindingChecks.symbol);
    checks.set(`library:${encodedReference}:footprint`, bindingChecks.footprint);
    checks.set(
      `component:${encodedReference}:schematic`,
      schematic === null
        ? { status: "unknown", detail: schematicProblem || "Schematic source is unavailable." }
        : !schematicScopeExact
          ? { status: "fail", detail: "Schematic contains root child sheets outside the closed single-sheet contract." }
          : !schematicClassSourcesExact
            ? { status: "fail", detail: "Schematic class overrides, directives, rule areas, or label metadata exceed the authored-pattern model; only global intersheet-reference fields are supported." }
          : schematicComponentCheck(component, schematic, schematicInventoryExact),
    );
    for (const pin of component.pins) {
      const encodedPin = encodePathToken(pin.pin);
      const id = `pin:${encodedReference}:${encodedPin}:disposition`;
      if (schematic === null || netlist === null) {
        checks.set(id, { status: "unknown", detail: schematicProblem || netlistProblem || "Schematic/netlist evidence is unavailable." });
        continue;
      }
      const actualNet = actualNetByEndpoint.get(endpointKey(component.reference, pin.pin));
      const assignmentPass = pin.assignment.kind === "net"
        ? actualNet === pin.assignment.net
        : actualNet === undefined && actualNoConnectEndpoints.includes(endpointKey(component.reference, pin.pin));
      const nativeNoConnectPass = pin.assignment.kind !== "no_connect" || erc.passed === true;
      const passed = assignmentPass && noConnectCountExact && netlistReferencesExact && netlistComponentIdentitiesExact
        && schematicScopeExact && schematicLabelsExact
        && assignedEndpointInventoryExact && nativeNoConnectEndpointsExact && nativeNoConnectPass;
      const status: FreshDesignAcceptanceStatus = pin.assignment.kind === "no_connect" && erc.passed === null
        ? "unknown"
        : passed ? "pass" : "fail";
      checks.set(id, {
        status,
        detail: passed
          ? pin.assignment.kind === "net"
            ? `${component.reference}.${pin.pin} is assigned exactly to ${pin.assignment.net}; exact pin numbering preserves any bound polarity semantics.`
            : `${component.reference}.${pin.pin} is absent from every net, the exact no-connect marker count matches, and native ERC passes.`
          : `${component.reference}.${pin.pin} disposition mismatch (assignment=${assignmentPass}, single-sheet=${schematicScopeExact}, schematic-class-sources=${schematicClassSourcesExact}, global-labels=${schematicLabelsExact}, no-connect-count=${noConnectCountExact}, native-no-connects=${nativeNoConnectEndpointsExact}, netlist-components=${netlistComponentIdentitiesExact}, endpoint-inventory=${assignedEndpointInventoryExact}, native-erc=${nativeNoConnectPass}).`,
      });
    }
  }

  for (const net of contract.nets) {
    const id = `net:${encodePathToken(net.name)}:schematic`;
    if (netlist === null || schematic === null) {
      checks.set(id, { status: "unknown", detail: schematicProblem || netlistProblem || "Schematic/native netlist evidence is unavailable." });
      continue;
    }
    const matches = functionalNets.filter((candidate) => candidate.name === net.name);
    const expectedEndpoints = net.endpoints.map((endpoint) => endpointKey(endpoint.reference, endpoint.pin));
    const actualEndpoints = matches.flatMap((candidate) => candidate.nodes.map((node) => endpointKey(node.reference, node.pin)));
    const netNamesExact = sameStrings(functionalNets.map((candidate) => candidate.name), contract.nets.map((candidate) => candidate.name));
    const passed = matches.length === 1 && netNamesExact && netlistComponentIdentitiesExact
      && schematicScopeExact && schematicLabelsExact
      && sameStrings(actualEndpoints, expectedEndpoints)
      && assignedEndpointInventoryExact && nativeNoConnectEndpointsExact;
    checks.set(id, {
      status: passed ? "pass" : "fail",
      detail: passed
        ? `${net.name} has the exact symmetric endpoint set ${sorted(expectedEndpoints).join(", ")}.`
        : `${net.name} differs from the closed single-sheet contract, exact passive-global-label inventory, or native net/endpoint inventory.`,
    });
  }

  for (const component of contract.components) {
    const id = `component:${encodePathToken(component.reference)}:pcb`;
    checks.set(
      id,
      board === null
        ? { status: "unknown", detail: boardProblem || "PCB source is unavailable." }
        : pcbComponentCheck(component, board, pcbInventoryExact, pcbNetInventory, allowedFootprintLeaves.get(component.reference),nativePads,nativePadProblem),
    );
  }
  checks.set(
    "board:outline",
    board === null
      ? { status: "unknown", detail: boardProblem || "PCB source is unavailable." }
      : exactRectangleCheck(board, analysis, contract),
  );
  for (const placement of contract.placementConstraints) {
    checks.set(
      `placement:${encodePathToken(placement.reference)}`,
      board === null
        ? { status: "unknown", detail: boardProblem || "PCB source is unavailable." }
        : placementCheck(placement, board, contract),
    );
  }
  for (const net of contract.nets) {
    checks.set(
      `net:${encodePathToken(net.name)}:routed`,
      board === null || analysis === null
        ? { status: "unknown", detail: boardProblem || analysisProblem || "PCB routing evidence is unavailable." }
        : routedNetCheck(net, contract, board, analysis, drc.passed, uncoveredZonesPresent, pcbNetInventory,nativePads,nativePadProblem),
    );
  }
  for (const netClass of contract.netClasses) {
    checks.set(
      `netclass:${encodePathToken(netClass.id)}:width`,
      analysis === null
        ? { status: "unknown", detail: analysisProblem || "PCB practice analysis is unavailable." }
        : widthCheck(netClass, contract, analysis),
    );
    checks.set(
      `netclass:${encodePathToken(netClass.id)}:clearance`,
      clearances.get(netClass.id) ?? {
        status: "unknown",
        detail: `Host effective-clearance evidence is missing class ${netClass.id}.`,
      },
    );
  }
  for (const route of contract.routingConstraints.nets) {
    checks.set(
      `route:${encodePathToken(route.net)}:turns`,
      analysis === null
        ? { status: "unknown", detail: analysisProblem || "PCB practice analysis is unavailable." }
        : turnCheck(route.net, contract, analysis),
    );
    checks.set(
      `route:${encodePathToken(route.net)}:vias`,
      analysis === null
        ? { status: "unknown", detail: analysisProblem || "PCB practice analysis is unavailable." }
        : viaCheck(route.net, contract, analysis),
    );
  }
  checks.set("erc", erc);
  checks.set("drc", drc);
  checks.set("visual-practice", visualCheck(evidence.visualInspection, analysis, analysisProblem, uncoveredZonesPresent));

  if (!legacyPlan) {
    let renderCheck: Check = { status: "unknown", detail: "Current host-bound native schematic SVG ink-clearance evidence is unavailable." };
    try {
      const expected = artifacts.schematicRenderExpected;
      if (expected !== undefined && canonicalJson(expected.sources.schematic) === canonicalJson(contentIdentity(evidence.schematicSource)) && canonicalJson(expected.sources.pcb) === canonicalJson(contentIdentity(evidence.pcbSource))) {
        const render = verifyHostSchematicRenderClearanceEvidence(evidence.schematicRenderClearance, expected);
        const witnesses = render.collisions.slice(0, 8).map((collision) => {
          const a = collision.a; const b = collision.b;
          return `${collision.kind}: SVG element ${a.elementIndex} text-group ${a.textGroupIndex ?? "none"} ${JSON.stringify((a.text ?? "").slice(0, 96))} at (${collision.pointAMm.x}, ${collision.pointAMm.y}) mm intersects element ${b.elementIndex} text-group ${b.textGroupIndex ?? "none"} ${JSON.stringify((b.text ?? "").slice(0, 96))} at (${collision.pointBMm.x}, ${collision.pointBMm.y}) mm`;
        });
        renderCheck = { status: render.status, detail: render.status === "pass"
          ? "Current source-bound native SVG visible text ink clears supported visible text and geometry. This establishes ink clearance only; compactness and professional layout are not established."
          : [render.status === "fail" ? "Native SVG text ink collisions require an explicit schematic repair and fresh validation." : "Native SVG ink coverage or its source/tool/validation binding is incomplete.", ...witnesses,
            ...render.bindingProblems.slice(0, 4), ...render.unsupported.slice(0, 4).map((item) => `Unsupported SVG evidence: ${item.code} at element ${item.elementIndex ?? "unknown"}.`),
            "Use fresh_autoplace_schematic_fields with empty arguments for visible Reference/Value field repair; do not infer field UUIDs from SVG indices."].join(" ") };
      }
    } catch { renderCheck = { status: "unknown", detail: "Schematic SVG ink-clearance receipt is unverified, stale, or not bound to the current sources and native-validation pass." }; }
    checks.set("schematic-render-clearance", renderCheck);
  }

  const requirements = expectedPlan.rows.map((planRow): FreshDesignAcceptanceRequirement => {
    const check = checks.get(planRow.id) ?? {
      status: "unknown" as const,
      detail: `No host evaluator is implemented for acceptance row kind ${planRow.kind}.`,
    };
    return {
      id: planRow.id,
      kind: planRow.kind,
      mandatory: true,
      status: check.status,
      detail: check.detail,
    };
  });
  const missing = requirements
    .filter((requirement) => requirement.status !== "pass")
    .map((requirement) => `${requirement.id} [${requirement.status}]: ${requirement.detail}`);
  return deepFreeze({
    schemaVersion: legacyPlan ? FRESH_DESIGN_ACCEPTANCE_LEGACY_SCHEMA_VERSION : FRESH_DESIGN_ACCEPTANCE_SCHEMA_VERSION,
    passed: missing.length === 0,
    contractIdentity: structuredClone(contract.identity),
    acceptancePlanIdentity: structuredClone(expectedPlan.identity),
    requirements,
    missing,
    sourceHashes: {
      schematicSha256: sha256(evidence.schematicSource),
      netlistSha256: sha256(evidence.netlistSource),
      pcbSha256: sha256(evidence.pcbSource),
    },
    evidenceLimitations: [
      "Native ERC/DRC results expose explicit availability and counts but are not content-hash-bound by the current KiCad adapter; the controller must run them after the frozen sources are saved.",
      "Net-class clearance acceptance requires a separate host-derived effective-rule payload bound to the exact PCB hash and a hashed KiCad rules source; clean DRC counts alone never satisfy it.",
      "Pad endpoints use actual saved copper layers and explicit plated-hole geometry; same-coordinate opposite-layer SMD pads are not intrinsic bridges. Native reachability does not replace independent trace geometry/topology checks.",
      `Routed VIA objects: ${board?.viaCount??0}; plated through-hole footprint PAD primitives: ${board?.footprints.flatMap(fp=>fp.pads).filter(pad=>pad.physical.padType==="thru_hole"&&pad.physical.drill!==null).length??0}. A zero-via routing result does not claim zero footprint holes or thermal/manufacturing suitability.`,
      "Courtyard spacing uses deterministic axis-aligned bounds and therefore fails conservatively for rotated non-rectangular courtyards; unsupported/missing courtyard geometry remains unknown.",
      "Acceptance establishes conformance to the closed candidate contract only; it does not establish ampacity, impedance, safety, fabrication qualification, or manufacturing release.",
    ],
  });
}
