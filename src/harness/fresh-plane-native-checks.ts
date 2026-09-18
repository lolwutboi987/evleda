import path from "node:path";
import { assertPcbNativeNumericProjectSettings } from "./pcb-native-numeric-rules.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { KicadCheckResult, KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import { isKicadPlaneContactsObservation, type KicadPlaneContactsObservation } from "../integrations/kicad-plane-contacts.js";
import { assertSavedFreshPlaneEvidenceCurrent, type SavedFreshPlaneEvidence } from "./fresh-plane-evidence.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

/** This profile describes native rule checking, not physical width or ampacity. */
export const FRESH_PLANE_NATIVE_CHECK_PROFILE = Object.freeze({
  version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
  requiredClearanceShortChecks: Object.freeze(["clearance", "hole_clearance", "copper_edge_clearance", "shorting_items", "tracks_crossing", "zones_intersect", "unconnected_items"]),
  requiredViaManufacturingChecks: Object.freeze(["hole_to_hole", "holes_co_located", "annular_width", "drill_out_of_range"]),
});
type Status = "verified" | "failed" | "unsupported";
export interface FreshPlaneNativeCheckFinding { readonly status: Status; readonly reasons: readonly string[] }
export interface FreshPlaneErcSourceScope {
  readonly schematic: Readonly<{ relativePath: string; sha256: string }>;
  readonly symbolLibraryTable: Readonly<{ relativePath: string; sha256: string }>;
  readonly footprintLibraryTable: Readonly<{ relativePath: string; sha256: string }>;
  readonly sourceSetIdentity: CanonicalIdentity;
}
export interface FreshPlaneErcCoverage {
  readonly ignoredChecks: readonly Readonly<{ key: string; description: string }>[];
  readonly projectIgnoredCheckKeys: readonly string[];
  readonly projectExclusionCount: number | null;
  readonly reportExcludedViolationCount: number | null;
  readonly unexcludedViolationCount: number | null;
  readonly sheetCount: number | null;
  readonly pinMapApplicability: "native-default-absent" | "native-default-explicit" | "non-default" | "unavailable";
  readonly pinMapIdentity: CanonicalIdentity | null;
}
export interface FreshPlaneThermalPadEvidence {
  readonly physicalPadUuid: string;
  readonly footprintUuid: string;
  readonly reference: string;
  readonly number: string;
  readonly layer: string;
  readonly zoneUuid: string;
  readonly applicability: "direct-native-zone-contact" | "no-pad-copper-on-plane-layer";
  /** Declared threshold, never an observed physical count. Check proof/status before using it. */
  readonly minimumResolvedSpokes: number | null;
  readonly proof: "native-drc-lower-bound-with-source-derived-applicability" | "not-applicable" | "unproven";
}
export interface FreshPlaneNativeChecksAssessment {
  readonly schemaVersion: "evleda.fresh-plane-native-checks.v1";
  readonly status: Status;
  readonly bundleIdentity: CanonicalIdentity;
  readonly savedEvidenceIdentity: CanonicalIdentity;
  readonly sourceIdentities: Readonly<{ pcb: ContentIdentity; project: ContentIdentity; rules: ContentIdentity }>;
  readonly checks: Readonly<{ erc: FreshPlaneNativeCheckFinding; drcClearanceShorts: FreshPlaneNativeCheckFinding; thermalPolicy: FreshPlaneNativeCheckFinding }>;
  readonly nativeErcIdentity: CanonicalIdentity | null;
  readonly ercSourceScope: FreshPlaneErcSourceScope;
  readonly ercCoverage: FreshPlaneErcCoverage;
  readonly thermalPads: readonly FreshPlaneThermalPadEvidence[];
  readonly nativeDrcIdentity: CanonicalIdentity;
  /** Complete historical CLI result, including invocation and report sources; never fresh authority on reparse. */
  readonly nativeInput: KicadCheckResult;
  readonly contactsIdentity: ContentIdentity | null;
  readonly ruleApplicability: "source-derived-under-pinned-native-semantics";
  readonly drcScope: "configured-native-clearance-short-checks-not-complete-plane-acceptance";
  readonly nativeProviderCompletion: "stock-cli-process-evidence-not-explicit-provider-telemetry";
  readonly physicalSpokeCount: "not_measured";
  readonly physicalThermalWidth: "not_measured";
  readonly actualMinimumPlaneCopperWidth: "not_evaluated";
  readonly acceptanceEvaluated: false;
  readonly identity: CanonicalIdentity;
}
export interface FreshPlaneNativeChecksInput {
  readonly compilationBundle: PcbPlaneCompilationBundle;
  readonly savedEvidence: SavedFreshPlaneEvidence;
  readonly current: Readonly<{ projectBindingIdentity: CanonicalIdentity; sourceScopeIdentity: CanonicalIdentity }>;
  readonly sources: Readonly<{ projectRoot: string; pcbPath: string; pcbSource: string;
    projectPath: string; projectSource: string; rulesPath: string; rulesSource: string }>;
  /** Complete current host snapshot, including schematic/library tables; not just three selected files. */
  readonly expectedSourceHashes: Readonly<Record<string, string>>;
  /** Identity independently pinned by the owning host, not copied from a model's claimed result. */
  readonly expectedExecutable: KicadExecutableIdentity;
  readonly nativeChecks: KicadCheckResult;
  readonly contacts?: KicadPlaneContactsObservation;
}

type Obj = Record<string, unknown>;
const assessments = new WeakSet<object>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Plane native checks: ${message}`);
}
function object(value: unknown, label: string): Obj {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Obj;
}
function array(value: unknown, label: string): unknown[] {
  requireEvidence(Array.isArray(value) && value.length <= 100_000, `${label} must be a complete bounded array`);
  return value;
}
function unique(values: readonly string[], label: string): void {
  requireEvidence(new Set(values).size === values.length, `${label} contains duplicates`);
}
function exactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  unique(actual, label);
  requireEvidence(same([...actual].sort(), [...expected].sort()), `${label} differs from complete expected inventory`);
}
function canonicalPath(value: string): string {
  requireEvidence(typeof value === "string" && path.win32.isAbsolute(value) && !/[\0-\x1f]/u.test(value), "absolute Windows source paths are required");
  return path.win32.normalize(value).toLowerCase();
}
function finding(reasons: string[], unsupported = false): FreshPlaneNativeCheckFinding {
  return { status: reasons.length === 0 ? "verified" : unsupported ? "unsupported" : "failed", reasons };
}

interface Atom { value: string; quoted: boolean }
interface Form { name: string; atoms: Atom[]; children: Form[] }
/** Small bounded syntax reader used ONLY to establish absence of override forms.
 * Strings cannot become field names; unknown ordinary-pad forms fail closed.
 */
function sourceForms(source: string): Form {
  requireEvidence(source.length <= 1_048_576 && source.isWellFormed(), "PCB source exceeds override-reader support");
  let index = 0, nodes = 0;
  const whitespace = () => { while (index < source.length && /\s/u.test(source[index]!)) index++; };
  const atom = (): Atom => {
    whitespace(); let value = "";
    const quoted = source[index] === '"';
    if (quoted) {
      index++;
      while (index < source.length) {
        const character = source[index++]!;
        if (character === '"') return { value, quoted };
        if (character === "\\") {
          requireEvidence(index < source.length, "unterminated source escape");
          const escaped = source[index++]!;
          requireEvidence(['"', "\\", "n", "r", "t", "b", "f"].includes(escaped), "unsupported source string escape");
          value += "_";
        } else value += character;
      }
      throw new Error("Plane native checks: unterminated source string");
    }
    while (index < source.length && !/[\s()"]/u.test(source[index]!)) value += source[index++];
    requireEvidence(value.length > 0 && !/[;\x00-\x1f]/u.test(value), "unsupported source atom");
    return { value, quoted };
  };
  const form = (depth: number): Form => {
    requireEvidence(depth <= 64 && ++nodes <= 100_000 && source[index++] === "(", "unsupported source structure");
    whitespace(); requireEvidence(source[index] !== '"', "quoted source field name");
    const result: Form = { name: atom().value, atoms: [], children: [] };
    while (true) {
      whitespace(); requireEvidence(index < source.length, "unclosed source form");
      if (source[index] === ")") { index++; return result; }
      if (source[index] === "(") result.children.push(form(depth + 1));
      else result.atoms.push(atom());
    }
  };
  whitespace(); const root = form(0); whitespace();
  requireEvidence(index === source.length && root.name === "kicad_pcb", "PCB override source is not one complete board");
  return root;
}
const PAD_FIELDS = new Set(["at", "size", "drill", "layers", "net", "uuid", "tstamp", "roundrect_rratio", "pinfunction", "pintype",
  "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "die_length", "locked", "remove_unused_layers"]);
const FORBIDDEN = new Set(["zone_connect", "thermal_width", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap",
  "zone_layer_connections", "padstack", "primitives", "options"]);
// Pinned KiCad ZONE_CONNECTION values, including explicit inherited (-1).
const zoneConnection = (node: Form) => node.children.length === 0 && node.atoms.length === 1
  && !node.atoms[0]!.quoted && /^(?:-1|[0-3])$/u.test(node.atoms[0]!.value);
function overrideSourceIssues(source: string, noPlaneCopper: ReadonlySet<string>): Map<string, string[]> {
  const root = sourceForms(source), result = new Map<string, string[]>();
  for (const footprint of root.children.filter(node => node.name === "footprint")) {
    const footprintConnections = footprint.children.filter(node => node.name === "zone_connect");
    for (const pad of footprint.children.filter(node => node.name === "pad")) {
      const uuid = pad.children.find(node => node.name === "uuid" || node.name === "tstamp")?.atoms[0]?.value;
      requireEvidence(uuid !== undefined && !result.has(uuid), "source pad override inventory has missing/duplicate UUID");
      const issues: string[] = [];
      if (footprintConnections.length > 1 || footprintConnections.some(node => !zoneConnection(node))) issues.push("unsupported-footprint-source-zone-connect");
      else if (footprintConnections.some(node => node.atoms[0]!.value !== "-1") && !noPlaneCopper.has(uuid)) issues.push("footprint-source-zone-override");
      if (pad.atoms.length !== 3 || pad.atoms[1]!.quoted || pad.atoms[2]!.quoted
        || !["circle", "rect", "roundrect"].includes(pad.atoms[2]!.value)) issues.push("unsupported-source-pad-shape");
      const seen = new Set<string>();
      const visit = (node: Form) => {
        if (FORBIDDEN.has(node.name)) issues.push(`source-pad-${node.name}`);
        for (const child of node.children) visit(child);
      };
      for (const child of pad.children) {
        if (seen.has(child.name)) issues.push(`duplicate-source-pad-field:${child.name}`);
        seen.add(child.name);
        if (child.name === "property") {
          // This stock heatsink marker changes neither pad copper nor its bore.
          if (child.children.length || child.atoms.length !== 1 || child.atoms[0]!.quoted
            || child.atoms[0]!.value !== "pad_prop_heatsink") issues.push("unsupported-source-pad-property");
          visit(child); continue;
        }
        if (child.name === "zone_connect") {
          if (!zoneConnection(child)) { issues.push("unsupported-source-pad-zone-connect"); visit(child); }
          else if (child.atoms[0]!.value !== "-1" && !noPlaneCopper.has(uuid)) issues.push("source-pad-zone_connect");
          continue;
        }
        if (!PAD_FIELDS.has(child.name)) issues.push(`unsupported-source-pad-field:${child.name}`);
        if (child.name === "drill") {
          if (child.children.length > 1 || child.children.some(offset => offset.name !== "offset" || offset.children.length !== 0
            || offset.atoms.length !== 2 || offset.atoms.some(atom => atom.quoted))) issues.push("unsupported-source-pad-drill-fields");
        } else if (child.children.length !== 0) issues.push(`unsupported-source-pad-nested-field:${child.name}`);
        // KiCad 10 always serializes this false setting for ordinary PTH pads.
        if (child.name === "remove_unused_layers" && (!same(child.atoms, [{ value: "no", quoted: false }]) || child.children.length !== 0)) issues.push("conditional-pad-layer-flashing");
        visit(child);
      }
      result.set(uuid, [...new Set(issues)]);
    }
  }
  return result;
}

function inspectNativeChecks(input: FreshPlaneNativeChecksInput): { ignored: Set<string>; issues: string[] } {
  const { sources, nativeChecks: native, expectedExecutable: executable } = input;
  requireEvidence(executable.version === FRESH_PLANE_NATIVE_CHECK_PROFILE.version && executable.commit === FRESH_PLANE_NATIVE_CHECK_PROFILE.commit
    && /^[a-f0-9]{64}$/u.test(executable.sha256) && Number.isSafeInteger(executable.sizeBytes) && executable.sizeBytes > 0, "unsupported expected native executable");
  requireEvidence(native.classification === "candidate-validation" && native.releaseAuthorized === false
    && same(native.executable, executable) && same(native.drc.invocation.executable, executable), "native executable/result identity differs from host pin");
  requireEvidence(same(native.sourceHashes, input.expectedSourceHashes), "native sourceHashes differ from complete current host snapshot");
  for (const [key, digest] of Object.entries(input.expectedSourceHashes)) {
    requireEvidence(key.length > 0 && !path.win32.isAbsolute(key) && !key.split(/[\\/]/u).some(part => part === ".." || part === "." || part === "")
      && !key.includes("\\") && /^[a-f0-9]{64}$/u.test(digest), "invalid current host source-hash entry");
  }
  for (const [filename, source] of [[sources.pcbPath, sources.pcbSource], [sources.projectPath, sources.projectSource], [sources.rulesPath, sources.rulesSource]] as const) {
    const relative = path.win32.relative(sources.projectRoot, filename).replaceAll("\\", "/");
    requireEvidence(input.expectedSourceHashes[relative] === contentIdentity(source).digest, "source bytes differ from exact CLI source-hash entry");
  }
  const stem = path.win32.basename(sources.pcbPath, ".kicad_pcb"), directory = path.win32.dirname(sources.pcbPath);
  for (const filename of [`${stem}.kicad_sch`, "fp-lib-table", "sym-lib-table"]) {
    const relative = path.win32.relative(sources.projectRoot, path.win32.join(directory, filename)).replaceAll("\\", "/");
    requireEvidence(input.expectedSourceHashes[relative] !== undefined, "V2 CLI snapshot omits a required schematic/library-table source");
  }
  const drc = native.drc, invocation = drc.invocation;
  requireEvidence(drc.kind === "drc" && canonicalPath(invocation.command) === canonicalPath(executable.path)
    && canonicalPath(invocation.cwd) === canonicalPath(sources.projectRoot), "DRC invocation command or cwd differs");
  requireEvidence(same(invocation.args, ["pcb", "drc", "--output", drc.reportPath, "--format", "json", "--units", "mm", "--severity-all",
    "--exit-code-violations", "--schematic-parity", sources.pcbPath]), "DRC arguments are not the fixed source-preserving full check");
  requireEvidence(Number.isFinite(invocation.durationMs) && invocation.durationMs >= 0 && Number.isFinite(Date.parse(invocation.startedAt))
    && typeof invocation.stdout === "string" && typeof invocation.stderr === "string", "incomplete native process observation");
  const report = object(drc.report, "DRC report");
  requireEvidence(report.$schema === "https://schemas.kicad.org/drc.v1.json" && report.coordinate_units === "mm"
    && report.kicad_version === executable.version && report.source === path.win32.basename(sources.pcbPath), "DRC report identity differs");
  const severity = array(report.included_severities, "included severities");
  requireEvidence(severity.every(value => typeof value === "string"), "invalid included severity");
  exactSet(severity as string[], ["error", "warning", "exclusion"], "DRC included severities");
  const ignoredKeys = array(report.ignored_checks, "ignored checks").map(value => {
    const entry = object(value, "ignored check");
    requireEvidence(typeof entry.key === "string" && entry.key.length > 0 && typeof entry.description === "string", "malformed ignored check");
    return entry.key;
  });
  unique(ignoredKeys, "ignored checks");
  const lists = ["violations", "unconnected_items", "schematic_parity"].map(key => array(report[key], `DRC ${key}`));
  requireEvidence(lists.every(list => list.every(value => value !== null && typeof value === "object" && !Array.isArray(value))), "malformed native finding");
  const count = lists.reduce((sum, values) => sum + values.length, 0);
  requireEvidence(drc.violationCount === count && drc.schematicParityCount === lists[2]!.length
    && drc.status === (count === 0 ? "clean" : "violations") && invocation.exitCode === (count === 0 ? 0 : 5), "native report/status/exit mismatch");
  const issues: string[] = [];
  if (count > 0) issues.push("native-drc-has-findings");
  // The fixed stock CLI has no cancellation reporter. No explicit per-provider
  // completion telemetry is inferred from its report-writing stdout.
  if (invocation.stderr.trim() !== "") issues.push("native-drc-stderr-needs-review");
  return { ignored: new Set(ignoredKeys), issues };
}

// KiCad commit 146a4f2a: eeschema/erc/erc_settings.cpp m_defaultPinMap,
// PIN_ERROR { OK=0, WARNING=1, PP_ERROR=2, UNCONNECTED=3 }. Data comparison only;
// this gate never evaluates connectivity or substitutes a second ERC engine.
const ERC_DEFAULT_PIN_MAP = [
  [0,0,0,0,0,0,1,0,0,0,0,2], [0,2,0,1,0,0,1,0,2,2,2,2],
  [0,0,0,0,0,0,1,0,1,0,1,2], [0,1,0,0,0,0,1,1,2,1,1,2],
  [0,0,0,0,0,0,1,0,0,0,0,2], [0,0,0,0,0,0,0,0,0,0,0,2],
  [1,1,1,1,1,0,1,1,1,1,1,2], [0,0,0,1,0,0,1,0,0,0,0,2],
  [0,2,1,2,0,0,1,0,2,2,2,2], [0,2,0,1,0,0,1,0,2,0,0,2],
  [0,2,1,1,0,0,1,0,2,0,0,2], [2,2,2,2,2,2,2,2,2,2,2,2],
] as const;
const ERC_DEFAULT_IGNORED = ["single_global_label", "footprint_filter", "simulation_model_issue", "four_way_junction"];

/** Missing/unsupported ERC remains a separate unknown fact; it cannot erase valid DRC facts. */
function inspectErc(input: FreshPlaneNativeChecksInput, nativeInput: KicadCheckResult, project: Obj) {
  const { sources, expectedExecutable: executable } = input;
  const directory = path.win32.dirname(sources.pcbPath), stem = path.win32.basename(sources.pcbPath, ".kicad_pcb");
  const schematicPath = path.win32.join(directory, `${stem}.kicad_sch`);
  const sourcePin = (filePath: string) => {
    const relativePath = path.win32.relative(sources.projectRoot, filePath).replaceAll("\\", "/");
    // inspectNativeChecks already authenticated the exact complete current source set.
    return { relativePath, sha256: input.expectedSourceHashes[relativePath]! };
  };
  const sourceScope: FreshPlaneErcSourceScope = { schematic: sourcePin(schematicPath),
    symbolLibraryTable: sourcePin(path.win32.join(directory, "sym-lib-table")),
    footprintLibraryTable: sourcePin(path.win32.join(directory, "fp-lib-table")),
    sourceSetIdentity: canonicalIdentity(input.expectedSourceHashes, "evleda.fresh-plane-native-source-set.v1") };
  const coverage = { ignoredChecks: [] as { key: string; description: string }[], projectIgnoredCheckKeys: [] as string[],
    projectExclusionCount: null as number | null, reportExcludedViolationCount: null as number | null,
    unexcludedViolationCount: null as number | null, sheetCount: null as number | null,
    pinMapApplicability: "unavailable" as FreshPlaneErcCoverage["pinMapApplicability"], pinMapIdentity: null as CanonicalIdentity | null };
  const issues: string[] = [];
  let nativeIdentity: CanonicalIdentity | null = null;
  const finish = (status: Status) => ({ fact: { status, reasons: [...new Set(issues)] } as FreshPlaneNativeCheckFinding,
    coverage, sourceScope, nativeIdentity });
  const expectedIgnored = new Set(ERC_DEFAULT_IGNORED);
  try {
    const settings = project.erc === undefined ? {} : object(project.erc, "ERC project settings");
    if (Object.keys(settings).some(key => !["meta", "rule_severities", "erc_exclusions", "pin_map"].includes(key))) issues.push("erc-project-settings-unsupported");
    if (settings.meta !== undefined && object(settings.meta, "ERC settings metadata").version !== 0) issues.push("erc-project-settings-version-unsupported");
    const severities = settings.rule_severities === undefined ? {} : object(settings.rule_severities, "ERC project severities");
    for (const [key, severity] of Object.entries(severities)) {
      if (severity === "ignore") expectedIgnored.add(key);
      else if (severity === "error" || severity === "warning") expectedIgnored.delete(key);
      else issues.push("erc-project-severity-unsupported");
    }
    coverage.projectIgnoredCheckKeys = [...expectedIgnored].sort();
    if (coverage.projectIgnoredCheckKeys.length > 0) issues.push("erc-project-has-ignored-checks");
    coverage.projectExclusionCount = settings.erc_exclusions === undefined ? 0 : array(settings.erc_exclusions, "ERC project exclusions").length;
    if (coverage.projectExclusionCount > 0) issues.push("erc-project-exclusions-present");
    if (settings.pin_map === undefined) {
      coverage.pinMapApplicability = "native-default-absent";
      coverage.pinMapIdentity = canonicalIdentity(ERC_DEFAULT_PIN_MAP, "evleda.kicad10-erc-pin-map.v1");
    } else {
      const matrix = array(settings.pin_map, "ERC pin map");
      requireEvidence(matrix.length === 12 && matrix.every(row => Array.isArray(row) && row.length === 12
        && row.every(value => Number.isInteger(value) && value >= 0 && value <= 3)), "ERC pin map is not a supported native matrix");
      coverage.pinMapIdentity = canonicalIdentity(matrix, "evleda.kicad10-erc-pin-map.v1");
      coverage.pinMapApplicability = same(matrix, ERC_DEFAULT_PIN_MAP) ? "native-default-explicit" : "non-default";
      if (coverage.pinMapApplicability === "non-default") issues.push("erc-pin-map-differs-from-native-default");
    }
  } catch { issues.push("erc-project-policy-unavailable-or-malformed"); }
  const rawErc: unknown = nativeInput.erc;
  if (rawErc === undefined || rawErc === null) { issues.push("native-erc-evidence-unavailable"); return finish("unsupported"); }
  try {
    const erc = object(rawErc, "ERC result"), invocation = object(erc.invocation, "ERC invocation");
    nativeIdentity = canonicalIdentity(erc, "evleda.fresh-plane-native-erc-input.v1");
    requireEvidence(erc.kind === "erc" && same(invocation.executable, executable), "ERC executable/kind differs from host pin");
    requireEvidence(typeof invocation.command === "string" && canonicalPath(invocation.command) === canonicalPath(executable.path)
      && typeof invocation.cwd === "string" && canonicalPath(invocation.cwd) === canonicalPath(sources.projectRoot), "ERC invocation command/cwd differs");
    requireEvidence(typeof erc.reportPath === "string" && path.win32.isAbsolute(erc.reportPath)
      && same(invocation.args, ["sch", "erc", "--output", erc.reportPath, "--format", "json", "--units", "mm",
        "--severity-all", "--exit-code-violations", schematicPath]), "ERC arguments are not the exact full schematic check");
    requireEvidence(typeof invocation.durationMs === "number" && Number.isFinite(invocation.durationMs) && invocation.durationMs >= 0
      && typeof invocation.startedAt === "string" && Number.isFinite(Date.parse(invocation.startedAt))
      && typeof invocation.stdout === "string" && typeof invocation.stderr === "string", "ERC process observation is incomplete");
    const report = object(erc.report, "ERC report");
    requireEvidence(report.$schema === "https://schemas.kicad.org/erc.v1.json" && report.coordinate_units === "mm"
      && report.kicad_version === executable.version && report.source === path.win32.basename(schematicPath), "ERC report identity/source differs");
    const severities = array(report.included_severities, "ERC included severities");
    requireEvidence(severities.every(value => typeof value === "string"), "ERC included severity is malformed");
    exactSet(severities as string[], ["error", "warning", "exclusion"], "ERC included severities");
    const ignored = array(report.ignored_checks, "ERC ignored checks").map(value => {
      const entry = object(value, "ERC ignored check");
      requireEvidence(typeof entry.key === "string" && entry.key.length > 0 && entry.key.length <= 256
        && typeof entry.description === "string" && entry.description.length <= 4096, "ERC ignored check is malformed");
      return { key: entry.key, description: entry.description };
    });
    unique(ignored.map(entry => entry.key), "ERC ignored checks");
    coverage.ignoredChecks = ignored;
    if (!same(ignored.map(entry => entry.key).sort(), [...expectedIgnored].sort())) issues.push("erc-report-project-ignored-checks-mismatch");
    if (ignored.length > 0) issues.push("native-erc-has-ignored-checks");
    const sheets = array(report.sheets, "ERC sheets");
    requireEvidence(sheets.length > 0 && sheets.length <= 1024, "ERC sheet inventory is empty or unsupported");
    const sheetPaths: string[] = []; let count = 0, excluded = 0, roots = 0;
    for (const value of sheets) {
      const sheet = object(value, "ERC sheet");
      requireEvidence(typeof sheet.path === "string" && sheet.path.startsWith("/") && sheet.path.length <= 4096
        && typeof sheet.uuid_path === "string" && sheet.uuid_path.startsWith("/") && sheet.uuid_path.length <= 4096, "ERC sheet path is malformed");
      sheetPaths.push(sheet.uuid_path); if (sheet.path === "/") roots++;
      for (const value of array(sheet.violations, "ERC sheet violations")) {
        const violation = object(value, "ERC violation");
        requireEvidence(["error", "warning", "exclusion"].includes(String(violation.severity))
          && typeof violation.type === "string" && violation.type.length > 0
          && (violation.excluded === undefined || typeof violation.excluded === "boolean"), "ERC violation is malformed");
        count++; if (violation.excluded === true || violation.severity === "exclusion") excluded++;
      }
    }
    unique(sheetPaths, "ERC sheet UUID paths"); requireEvidence(roots === 1, "ERC root sheet is missing or ambiguous");
    requireEvidence(erc.violationCount === count && erc.schematicParityCount === 0
      && erc.status === (count === 0 ? "clean" : "violations") && invocation.exitCode === (count === 0 ? 0 : 5), "ERC report/status/exit mismatch");
    coverage.sheetCount = sheets.length; coverage.reportExcludedViolationCount = excluded; coverage.unexcludedViolationCount = count - excluded;
    if (excluded > 0) issues.push("native-erc-has-excluded-violations");
    if (invocation.stderr.trim() !== "") issues.push("native-erc-stderr-needs-review");
    if (coverage.unexcludedViolationCount > 0) { issues.push("native-erc-has-violations"); return finish("failed"); }
    return finish(issues.length > 0 ? "unsupported" : "verified");
  } catch { issues.push("native-erc-evidence-invalid"); return finish("unsupported"); }
}

/** Pure gate for the owning host's trusted runChecks port. No native invocation or filesystem read.
 * The CLI result and executable pin are host capabilities/data, NEVER public/model tool arguments.
 * This brand authenticates this validation path; it is not an independent native attestation.
 */
export function assessFreshPlaneNativeChecks(input: FreshPlaneNativeChecksInput): FreshPlaneNativeChecksAssessment {
  const bundle = input.compilationBundle, sources = input.sources;
  requireEvidence(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated actual V2 bundle required");
  const parent = canonicalPath(path.win32.dirname(sources.pcbPath)), stem = path.win32.basename(sources.pcbPath, ".kicad_pcb");
  requireEvidence(canonicalPath(sources.projectPath) === canonicalPath(path.win32.join(parent, `${stem}.kicad_pro`))
    && canonicalPath(sources.rulesPath) === canonicalPath(path.win32.join(parent, `${stem}.kicad_dru`)), "PCB/project/DRU must share the exact design stem");
  canonicalPath(sources.projectRoot);
  const sourceIdentities = { pcb: contentIdentity(sources.pcbSource), project: contentIdentity(sources.projectSource), rules: contentIdentity(sources.rulesSource) };
  const rules = createFreshPlaneRules(bundle);
  requireEvidence(sources.rulesSource === rules.source, "canonical authenticated V2 DRU differs");
  assertSavedFreshPlaneEvidenceCurrent(input.savedEvidence, { bundleIdentity: bundle.identity, ...input.current,
    savedPcbIdentity: sourceIdentities.pcb, projectSettingsIdentity: sourceIdentities.project, rulesIdentity: sourceIdentities.rules });
  const native = inspectNativeChecks(input);
  const nativeInput=hardenPortableValue(input.nativeChecks,{maxBytes:8*1024*1024,maxDepth:64,maxNodes:500000,
    maxArrayLength:100000,maxOwnKeys:4096,maxStringBytes:1048576}) as KicadCheckResult;
  const settings = object(parsePortableJsonBytes(Buffer.from(sources.projectSource), { maxBytes: 1_048_576, maxDepth: 64, maxNodes: 100_000 }), "project");
  assertPcbNativeNumericProjectSettings(bundle.contract, settings);
  const erc = inspectErc(input, nativeInput, settings);
  const design = object(object(settings.board, "project board").design_settings, "project design settings");
  const severities = object(design.rule_severities, "project rule severities"), boardRules = object(design.rules, "project rules");
  requireEvidence(Number.isInteger(boardRules.min_resolved_spokes) && Number(boardRules.min_resolved_spokes) >= 0 && Number(boardRules.min_resolved_spokes) <= 99
    && typeof boardRules.max_error === "number" && Number.isFinite(boardRules.max_error) && boardRules.max_error > 0, "missing/unsupported board thermal/error settings");
  const commonIssues = [...native.issues];
  if (array(design.drc_exclusions, "project DRC exclusions").length > 0) commonIssues.push("project-drc-exclusions-present");
  const drcIssues = [...commonIssues];
  if (bundle.contract.nativeRuleMode !== undefined) for (const name of ["track_width", "track_angle"]) {
    if (severities[name] !== "error" || native.ignored.has(name)) drcIssues.push(`required-native-check-disabled:${name}`);
  }
  // inspectNativeChecks pins the exact native version/commit. Its qualified
  // via-diameter default is error even though the saved key is absent.
  if (bundle.contract.nativeRuleMode !== undefined && native.ignored.has("via_diameter")) drcIssues.push("required-native-check-disabled:via_diameter");
  for (const name of FRESH_PLANE_NATIVE_CHECK_PROFILE.requiredClearanceShortChecks) {
    if (severities[name] !== "error" || native.ignored.has(name)) drcIssues.push(`required-native-check-disabled:${name}`);
  }
  // KiCad defaults hole spacing to warning. The qualified all-severity report
  // fails on either warning or error findings; missing/ignored checks cannot pass.
  for (const name of FRESH_PLANE_NATIVE_CHECK_PROFILE.requiredViaManufacturingChecks) {
    if ((severities[name] !== "error" && severities[name] !== "warning") || native.ignored.has(name)) drcIssues.push(`required-native-check-disabled:${name}`);
  }
  const thermalIssues = [...commonIssues]; let unsupported = false;
  const plane = bundle.contract.planes[0]!, thermal = plane.padConnection.mode === "thermal";
  for (const name of thermal ? ["starved_thermal", "unconnected_items"] : ["unconnected_items"]) {
    if (severities[name] !== "error" || native.ignored.has(name)) thermalIssues.push(`required-native-check-disabled:${name}`);
  }
  let thermalFailure = thermalIssues.length > 0;
  const thermalPads: FreshPlaneThermalPadEvidence[] = [];
  const board = parseFreshPcbSource(sources.pcbSource), geometry = parseFreshPcbReferenceGeometry(sources.pcbSource);
  const sourcePads = board.footprints.flatMap(fp => fp.pads.map(pad => ({ fp, pad })));
  // An empty number does not make assigned copper non-electrical. Examine every
  // physical pad on the plane net; the physical inventory decides support.
  const ownNet = sourcePads.filter(({ pad }) => pad.netName === plane.net);
  const inventory = input.savedEvidence.stage.nativePads.inventory;
  requireEvidence(inventory !== null, "complete validated physical pad inventory required");
  exactSet(inventory.physicalPads.map(pad => pad.uuid), sourcePads.map(({ pad }) => pad.physical.id!), "saved stage physical pads");
  const nativeLayer = `BL_${plane.layer.replace(".", "_")}`;
  // Scope connection settings only after the authenticated physical inventory
  // establishes absence. Unknown geometry or conditional flashing never earns it.
  const noPlaneCopper = new Set(inventory.physicalPads.filter(pad => pad.issues.length === 0
    && pad.observedUsableCopperLayers !== null && !pad.observedUsableCopperLayers.includes(nativeLayer)).map(pad => pad.uuid));
  const sourceIssues = overrideSourceIssues(sources.pcbSource, noPlaneCopper);
  for (const { pad } of ownNet) {
    const issues = sourceIssues.get(pad.physical.id!) ?? ["source-pad-override-inventory-incomplete"];
    if (issues.length > 0) { thermalIssues.push(...issues.map(issue => `${pad.physical.id}:${issue}`)); unsupported = true; }
  }
  const contacts = input.contacts;
  if (!contacts) { thermalIssues.push("current-native-direct-contacts-unavailable"); unsupported = true; }
  else {
    requireEvidence(isKicadPlaneContactsObservation(contacts), "genuine host native direct-contact observation required");
    requireEvidence(same(contacts.sourceBefore, sourceIdentities.pcb) && same(contacts.sourceAfter, sourceIdentities.pcb)
      && contacts.sourceUnchanged === true, "native contact source is stale");
    const report = contacts.report;
    const target = geometry.zones.find(zone => zone.uuid === input.savedEvidence.stage.targetZoneUuid);
    requireEvidence(target !== undefined && target.netName === plane.net && same(target.layers, [plane.layer]) && geometry.zones.length === 1, "intended source zone differs");
    const zones = report.zones;
    requireEvidence(zones.length === 1 && zones[0]!.uuid === target.uuid && zones[0]!.netName === plane.net, "native zone inventory differs");
    const zone = zones[0]!;
    const stagedZone = input.savedEvidence.stage.nativeFilledZones.find(item => item.uuid === target.uuid);
    requireEvidence(stagedZone?.raw.name === rules.zones[0]!.zoneName && !zone.isRuleArea && zone.isFilled === true
      && zone.padConnection === (thermal ? 1 : 2), "native intended zone configuration differs");
    if (zone.needRefill) { thermalIssues.push("native-loaded-zone-reports-refill-needed"); unsupported = true; }
    if (zone.layers.length !== 1 || zone.layers[0]!.name !== plane.layer || !zone.layers[0]!.hasFilledPolys || zone.layers[0]!.filledSubpolygonCount !== 1
      || zone.layers[0]!.subpolygons.length !== 1) { thermalIssues.push("aggregate-native-contact-has-ambiguous-subpolygon-scope"); unsupported = true; }
    exactSet(report.allPads.map(pad => pad.uuid), sourcePads.map(({ pad }) => pad.physical.id!), "native physical pads");
    exactSet(report.allFootprints.map(fp => fp.uuid), board.footprints.map(fp => fp.id!), "native footprints");
    requireEvidence(zone.directPads.every(pad => pad.netName === plane.net && report.allPads.some(item => item.uuid === pad.uuid)), "native direct pad contact has another net/owner");
    const direct = new Set(zone.directPads.map(pad => pad.uuid));
    for (const { fp, pad } of ownNet) {
      const uuid = pad.physical.id!, observed = report.allPads.find(item => item.uuid === uuid)!, physical = inventory.physicalPads.find(item => item.uuid === uuid)!;
      const footprint = report.allFootprints.find(item => item.uuid === fp.id)!;
      requireEvidence(observed.footprintUuid === fp.id && observed.reference === fp.reference && observed.number === pad.number
        && observed.netName === plane.net && footprint.reference === fp.reference, "native pad ownership/net differs");
      const padIssues = [...(sourceIssues.get(uuid) ?? ["source-pad-override-inventory-incomplete"])];
      if (physical.issues.length > 0 || physical.observedUsableCopperLayers === null) padIssues.push("unsupported-physical-pad");
      const absent = noPlaneCopper.has(uuid);
      if (absent) requireEvidence(!direct.has(uuid), "direct contact contradicts native pad-layer absence");
      const connections = [observed.localZoneConnection, observed.resolvedZoneConnectionOverride,
        footprint.localZoneConnection, footprint.resolvedZoneConnectionOverride];
      if (connections.some(value => ![-1, 0, 1, 2, 3].includes(value))) padIssues.push("unsupported-native-zone-connection");
      if (!absent && connections.some(value => value !== -1)
        || observed.localThermalGapOverride !== null || observed.localThermalSpokeWidthOverride !== null || observed.padstackMode !== 0) padIssues.push("native-pad-or-footprint-override");
      if (!same(observed.padstackUniqueLayers, [0]) || observed.layers.some(layer => /^(?:F|B|In[0-9]+)\.Cu$/u.test(layer.name)
        && (layer.zoneLayerOverride !== 0 || layer.effectivePadstackLayer !== 0))) padIssues.push("native-per-layer-padstack-or-zone-override");
      const stack = object(physical.rawNative.pad_stack, "raw native padstack");
      if (stack.type !== "PST_NORMAL") padIssues.push("unsupported-native-padstack-mode");
      if (stack.unconnected_layer_removal !== undefined && stack.unconnected_layer_removal !== "ULR_KEEP") padIssues.push("native-conditional-pad-layer-flashing");
      const checkZoneSettings = (value: unknown) => {
        if (value === undefined) return;
        const setting = object(value, "raw native pad zone settings");
        if (setting.zone_connection !== undefined) {
          if (typeof setting.zone_connection !== "string" || !["ZCS_INHERITED", "ZCS_NONE", "ZCS_THERMAL", "ZCS_FULL", "ZCS_PTH_THERMAL"].includes(setting.zone_connection)) padIssues.push("unsupported-native-padstack-zone-connection");
          else if (!absent && setting.zone_connection !== "ZCS_INHERITED") padIssues.push("native-padstack-zone-override");
        }
        if (setting.thermal_spokes !== undefined) {
          const spoke = object(setting.thermal_spokes, "raw native thermal settings");
          if (spoke.gap !== undefined || spoke.width !== undefined) padIssues.push("native-padstack-thermal-override");
        }
      };
      checkZoneSettings(stack.zone_settings);
      for (const layer of array(stack.copper_layers, "complete raw copper layers")) {
        const copper = object(layer, "raw copper layer");
        if (!["PSS_CIRCLE", "PSS_RECTANGLE", "PSS_ROUNDRECT"].includes(String(copper.shape))) padIssues.push("unsupported-native-pad-shape");
        checkZoneSettings(copper.zone_settings);
      }
      if (padIssues.length > 0) { thermalIssues.push(...padIssues.map(reason => `${uuid}:${reason}`)); unsupported = true; continue; }
      if (absent) {
        thermalPads.push({ physicalPadUuid: uuid, footprintUuid: fp.id!, reference: fp.reference, number: pad.number, layer: plane.layer,
          zoneUuid: zone.uuid, applicability: "no-pad-copper-on-plane-layer", minimumResolvedSpokes: null, proof: "not-applicable" });
      } else if (!direct.has(uuid)) {
        thermalIssues.push(`${uuid}:local-intended-zone-contact-not-observed`);
        thermalFailure = true;
      } else {
        thermalPads.push({ physicalPadUuid: uuid, footprintUuid: fp.id!, reference: fp.reference, number: pad.number, layer: plane.layer,
          zoneUuid: zone.uuid, applicability: "direct-native-zone-contact", minimumResolvedSpokes: thermal ? plane.padConnection.minimumConnectedSpokes : null,
          proof: thermal ? "native-drc-lower-bound-with-source-derived-applicability" : "not-applicable" });
      }
    }
    if (thermal && !thermalPads.some(pad => pad.applicability === "direct-native-zone-contact")) {
      thermalIssues.push("no-direct-thermal-pad-witness"); unsupported = true;
    }
  }
  const checks = { erc: erc.fact, drcClearanceShorts: finding([...new Set(drcIssues)]), thermalPolicy: finding([...new Set(thermalIssues)], unsupported && !thermalFailure) };
  const evaluatedPads = thermalPads.map(pad => pad.proof === "native-drc-lower-bound-with-source-derived-applicability" && checks.thermalPolicy.status !== "verified"
    ? { ...pad, proof: "unproven" as const } : pad);
  const status: Status = Object.values(checks).some(check => check.status === "failed") ? "failed"
    : Object.values(checks).some(check => check.status === "unsupported") ? "unsupported" : "verified";
  const body = { schemaVersion: "evleda.fresh-plane-native-checks.v1" as const, status, bundleIdentity: bundle.identity,
    savedEvidenceIdentity: input.savedEvidence.identity, sourceIdentities, checks, thermalPads: evaluatedPads,
    nativeDrcIdentity: canonicalIdentity(nativeInput.drc, "evleda.fresh-plane-native-drc-input.v1"),
    nativeErcIdentity: erc.nativeIdentity, ercSourceScope: erc.sourceScope, ercCoverage: erc.coverage,
    nativeInput,
    contactsIdentity: contacts?.artifacts.rawOutput.identity ?? null,
    ruleApplicability: "source-derived-under-pinned-native-semantics" as const,
    drcScope: "configured-native-clearance-short-checks-not-complete-plane-acceptance" as const,
    nativeProviderCompletion: "stock-cli-process-evidence-not-explicit-provider-telemetry" as const,
    physicalSpokeCount: "not_measured" as const, physicalThermalWidth: "not_measured" as const,
    actualMinimumPlaneCopperWidth: "not_evaluated" as const, acceptanceEvaluated: false as const };
  const result = freezePcbPlaneArtifact({ ...body, identity: canonicalIdentity(body, body.schemaVersion) });
  assessments.add(result); return result;
}

export function isFreshPlaneNativeChecksAssessment(value: unknown): value is FreshPlaneNativeChecksAssessment {
  return value !== null && typeof value === "object" && assessments.has(value);
}
