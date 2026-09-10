import path from "node:path";
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
});
type Status = "verified" | "failed" | "unsupported";
export interface FreshPlaneNativeCheckFinding { readonly status: Status; readonly reasons: readonly string[] }
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
  readonly checks: Readonly<{ drcClearanceShorts: FreshPlaneNativeCheckFinding; thermalPolicy: FreshPlaneNativeCheckFinding }>;
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

interface Form { name: string; atoms: string[]; children: Form[] }
/** Small bounded syntax reader used ONLY to establish absence of override forms.
 * Strings cannot become field names; unknown ordinary-pad forms fail closed.
 */
function sourceForms(source: string): Form {
  requireEvidence(source.length <= 1_048_576 && source.isWellFormed(), "PCB source exceeds override-reader support");
  let index = 0, nodes = 0;
  const whitespace = () => { while (index < source.length && /\s/u.test(source[index]!)) index++; };
  const atom = (): string => {
    whitespace(); let value = "";
    if (source[index] === '"') {
      index++;
      while (index < source.length) {
        const character = source[index++]!;
        if (character === '"') return value;
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
    return value;
  };
  const form = (depth: number): Form => {
    requireEvidence(depth <= 64 && ++nodes <= 100_000 && source[index++] === "(", "unsupported source structure");
    whitespace(); requireEvidence(source[index] !== '"', "quoted source field name");
    const result: Form = { name: atom(), atoms: [], children: [] };
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
function overrideSourceIssues(source: string): Map<string, string[]> {
  const root = sourceForms(source), result = new Map<string, string[]>();
  for (const footprint of root.children.filter(node => node.name === "footprint")) {
    const footprintIssues = footprint.children.some(node => node.name === "zone_connect") ? ["footprint-source-zone-override"] : [];
    for (const pad of footprint.children.filter(node => node.name === "pad")) {
      const uuid = pad.children.find(node => node.name === "uuid" || node.name === "tstamp")?.atoms[0];
      requireEvidence(uuid !== undefined && !result.has(uuid), "source pad override inventory has missing/duplicate UUID");
      const issues = [...footprintIssues];
      if (pad.atoms.length < 3 || !["circle", "rect", "roundrect"].includes(pad.atoms[2]!)) issues.push("unsupported-source-pad-shape");
      const visit = (node: Form) => {
        if (FORBIDDEN.has(node.name)) issues.push(`source-pad-${node.name}`);
        for (const child of node.children) visit(child);
      };
      for (const child of pad.children) {
        if (!PAD_FIELDS.has(child.name)) issues.push(`unsupported-source-pad-field:${child.name}`);
        // KiCad 10 always serializes this false setting for ordinary PTH pads.
        if (child.name === "remove_unused_layers" && (!same(child.atoms, ["no"]) || child.children.length !== 0)) issues.push("conditional-pad-layer-flashing");
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
  const design = object(object(settings.board, "project board").design_settings, "project design settings");
  const severities = object(design.rule_severities, "project rule severities"), boardRules = object(design.rules, "project rules");
  requireEvidence(Number.isInteger(boardRules.min_resolved_spokes) && Number(boardRules.min_resolved_spokes) >= 0 && Number(boardRules.min_resolved_spokes) <= 99
    && typeof boardRules.max_error === "number" && Number.isFinite(boardRules.max_error) && boardRules.max_error > 0, "missing/unsupported board thermal/error settings");
  const commonIssues = [...native.issues];
  if (array(design.drc_exclusions, "project DRC exclusions").length > 0) commonIssues.push("project-drc-exclusions-present");
  const drcIssues = [...commonIssues];
  for (const name of FRESH_PLANE_NATIVE_CHECK_PROFILE.requiredClearanceShortChecks) {
    if (severities[name] !== "error" || native.ignored.has(name)) drcIssues.push(`required-native-check-disabled:${name}`);
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
  const sourceIssues = overrideSourceIssues(sources.pcbSource);
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
    const inventory = input.savedEvidence.stage.nativePads.inventory;
    requireEvidence(inventory !== null, "complete validated physical pad inventory required");
    exactSet(inventory.physicalPads.map(pad => pad.uuid), sourcePads.map(({ pad }) => pad.physical.id!), "saved stage physical pads");
    requireEvidence(zone.directPads.every(pad => pad.netName === plane.net && report.allPads.some(item => item.uuid === pad.uuid)), "native direct pad contact has another net/owner");
    const direct = new Set(zone.directPads.map(pad => pad.uuid));
    for (const { fp, pad } of ownNet) {
      const uuid = pad.physical.id!, observed = report.allPads.find(item => item.uuid === uuid)!, physical = inventory.physicalPads.find(item => item.uuid === uuid)!;
      const footprint = report.allFootprints.find(item => item.uuid === fp.id)!;
      requireEvidence(observed.footprintUuid === fp.id && observed.reference === fp.reference && observed.number === pad.number
        && observed.netName === plane.net && footprint.reference === fp.reference, "native pad ownership/net differs");
      const padIssues = [...(sourceIssues.get(uuid) ?? ["source-pad-override-inventory-incomplete"])];
      if (physical.issues.length > 0 || physical.observedUsableCopperLayers === null) padIssues.push("unsupported-physical-pad");
      if (observed.localZoneConnection !== -1 || observed.resolvedZoneConnectionOverride !== -1
        || footprint.localZoneConnection !== -1 || footprint.resolvedZoneConnectionOverride !== -1
        || observed.localThermalGapOverride !== null || observed.localThermalSpokeWidthOverride !== null || observed.padstackMode !== 0) padIssues.push("native-pad-or-footprint-override");
      if (!same(observed.padstackUniqueLayers, [0]) || observed.layers.some(layer => /^(?:F|B|In[0-9]+)\.Cu$/u.test(layer.name)
        && (layer.zoneLayerOverride !== 0 || layer.effectivePadstackLayer !== 0))) padIssues.push("native-per-layer-padstack-or-zone-override");
      const stack = object(physical.rawNative.pad_stack, "raw native padstack");
      if (stack.type !== "PST_NORMAL") padIssues.push("unsupported-native-padstack-mode");
      if (stack.unconnected_layer_removal !== undefined && stack.unconnected_layer_removal !== "ULR_KEEP") padIssues.push("native-conditional-pad-layer-flashing");
      const checkZoneSettings = (value: unknown) => {
        if (value === undefined) return;
        const setting = object(value, "raw native pad zone settings");
        if (setting.zone_connection !== undefined && setting.zone_connection !== "ZCS_INHERITED") padIssues.push("native-padstack-zone-override");
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
      const nativeLayer = `BL_${plane.layer.replace(".", "_")}`;
      if (!physical.observedUsableCopperLayers!.includes(nativeLayer)) {
        requireEvidence(!direct.has(uuid), "direct contact contradicts native pad-layer absence");
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
  const checks = { drcClearanceShorts: finding([...new Set(drcIssues)]), thermalPolicy: finding([...new Set(thermalIssues)], unsupported && !thermalFailure) };
  const evaluatedPads = thermalPads.map(pad => pad.proof === "native-drc-lower-bound-with-source-derived-applicability" && checks.thermalPolicy.status !== "verified"
    ? { ...pad, proof: "unproven" as const } : pad);
  const status: Status = checks.drcClearanceShorts.status === "failed" || checks.thermalPolicy.status === "failed" ? "failed"
    : checks.thermalPolicy.status === "unsupported" ? "unsupported" : "verified";
  const body = { schemaVersion: "evleda.fresh-plane-native-checks.v1" as const, status, bundleIdentity: bundle.identity,
    savedEvidenceIdentity: input.savedEvidence.identity, sourceIdentities, checks, thermalPads: evaluatedPads,
    nativeDrcIdentity: canonicalIdentity(nativeInput.drc, "evleda.fresh-plane-native-drc-input.v1"),
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
