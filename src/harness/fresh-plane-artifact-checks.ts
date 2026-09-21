import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { verifyHostKicadNativePadObservation, type KicadNativePadObservation } from "../integrations/kicad-native-pad-observation.js";
import { resolvePcbDesignCommonLibraries, type PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { resolvePcbBoardFeatureLibraries } from "./pcb-board-feature-libraries.js";
import { assertPcbLibrarySourcesCurrent } from "./pcb-library-source-binding.js";
import { assertPcbExternalPowerBindingCurrent } from "./pcb-external-power.js";
import { assertPcbDerivedPowerBindingCurrent, powerAnnotationBindingOf } from "./pcb-derived-power.js";
import { verifyFreshBoardFeatures } from "./fresh-board-features.js";
import { createFreshConnectivityContract } from "./fresh-connectivity-contract.js";
import { verifyFreshExternalPowerSource, type FreshExternalPowerGroup } from "./fresh-external-power.js";
import { prepareFreshPlaneConnectivity, type FreshPlaneConnectivityInput } from "./fresh-plane-connectivity.js";
import { validateCurrentFreshNativeTerminalBinding, type FreshNativeTerminalBinding } from "./fresh-native-terminal-binding.js";
import { parseFreshPcbSource, parseFreshSchematicSource, parseFreshNetlistSource } from "./fresh-kicad-parser.js";
import { verifyFreshSchematicSourceLibraries, type FreshSchematicApprovedGeometryResolver } from "./fresh-schematic-source-adapter.js";
import { verifyFreshPlaneNetClassSemanticAuthority, type FreshPlaneNetClassOperationOptions, type FreshPlaneNetClassSemanticAuthority } from "./fresh-plane-netclasses.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

export const FRESH_PLANE_ARTIFACT_CHECKS_VERSION = "evleda.fresh-plane-artifact-checks.v1" as const;
export type FreshPlaneArtifactSources = Readonly<{ pcb: string; schematic: string; project: string; rules: string; symbolLibraryTable: string; footprintLibraryTable: string }>;
export type FreshPlaneArtifactSourceIdentities = Readonly<Record<keyof FreshPlaneArtifactSources, ContentIdentity>>;
type Kind = PcbPlaneCompilationBundle["verificationPlan"]["requirements"][number]["kind"];
export interface FreshPlaneArtifactRow {
  readonly id: string; readonly kind: Kind; readonly status: "pass" | "fail" | "unknown";
  readonly reasons: readonly string[]; readonly requiresNativeClearance: boolean;
}
const issued = new WeakSet<object>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const need: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(`Plane artifacts: ${message}`); };
const sorted = (values: readonly string[]) => [...values].sort();
export function freshPlaneArtifactSourceIdentities(sources: FreshPlaneArtifactSources): FreshPlaneArtifactSourceIdentities {
  return Object.freeze(Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, contentIdentity(source)]))) as FreshPlaneArtifactSourceIdentities;
}
export function freshPlaneArtifactNetlistScope(bundle: PcbPlaneCompilationBundle, hostScopeIdentity: CanonicalIdentity, sources: FreshPlaneArtifactSources) {
  return canonicalIdentity({ bundleIdentity: bundle.identity, hostScopeIdentity, sourceIdentities: freshPlaneArtifactSourceIdentities(sources) }, "evleda.fresh-plane-artifact-netlist-scope.v1");
}
interface ComponentFact {
  readonly reference: string; readonly symbolLibraryId: string; readonly footprintLibraryId: string; readonly value: string;
  readonly pinCount: number; readonly physicalPadCount: number; readonly logicalTerminalCount: number;
  readonly nonElectricalFeatureCount: number; readonly libraryPhysicalInventoryIdentity: CanonicalIdentity;
}
interface NetClassFact {
  readonly id: string; readonly nativeName: string | null; readonly assignedNets: readonly string[];
  readonly traceWidthMm: number | null; readonly classClearanceMm: number | null;
  readonly boardMinimumClearanceMm: number; readonly effectiveMinimumClearanceMm: number | null;
}
export interface FreshPlaneArtifactAssessment {
  readonly schemaVersion: typeof FRESH_PLANE_ARTIFACT_CHECKS_VERSION;
  readonly group: "components" | "netclasses";
  readonly bundleIdentity: CanonicalIdentity; readonly contractIdentity: CanonicalIdentity;
  readonly libraryBindingIdentity: CanonicalIdentity; readonly verificationPlanIdentity: CanonicalIdentity;
  readonly hostScopeIdentity: CanonicalIdentity; readonly sourceIdentities: FreshPlaneArtifactSourceIdentities;
  readonly rows: readonly FreshPlaneArtifactRow[];
  readonly components: readonly ComponentFact[]; readonly netClasses: readonly NetClassFact[];
  readonly evidence: Readonly<{ nativePadObservationIdentity: ContentIdentity | null; nativeNetlistBindingIdentity: CanonicalIdentity | null;
    schematicLibraryGeometryIdentity: CanonicalIdentity | null; netClassAuthorityIdentity: CanonicalIdentity | null;
    powerAnnotationCount: number; derivedPowerPathCount: number }>;
  readonly accepted: false; readonly electricalSuitabilityEvaluated: false; readonly fabricationAuthorized: false;
  readonly identity: CanonicalIdentity;
}
function issue(bundle: PcbPlaneCompilationBundle, hostScopeIdentity: CanonicalIdentity, sources: FreshPlaneArtifactSources,
  details: Pick<FreshPlaneArtifactAssessment, "group" | "rows" | "components" | "netClasses" | "evidence">): FreshPlaneArtifactAssessment {
  need(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated V2 bundle required");
  need(new Set(details.rows.map(row => row.id)).size === details.rows.length, "duplicate original requirement rows");
  for (const row of details.rows) need(bundle.verificationPlan.requirements.some(r => r.id === row.id && r.kind === row.kind), "artifact row differs from the original verification plan");
  const payload = { schemaVersion: FRESH_PLANE_ARTIFACT_CHECKS_VERSION, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
    libraryBindingIdentity: bundle.libraryBinding.identity, verificationPlanIdentity: bundle.verificationPlan.identity, hostScopeIdentity,
    sourceIdentities: freshPlaneArtifactSourceIdentities(sources), ...details, accepted: false as const, electricalSuitabilityEvaluated: false as const, fabricationAuthorized: false as const };
  const result = freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) }); issued.add(result); return result;
}
export const isFreshPlaneArtifactAssessment = (value: unknown): value is FreshPlaneArtifactAssessment => value !== null && typeof value === "object" && issued.has(value);

/** Host-only native inputs must be collected inside the caller's complete six-file read guard. */
export function assessFreshPlaneComponentArtifacts(input: {
  readonly connectivity: FreshPlaneConnectivityInput; readonly sources: FreshPlaneArtifactSources;
  readonly nativePads: KicadNativePadObservation; readonly nativeNetlistSource: string; readonly nativeNetlistBinding: FreshNativeTerminalBinding;
  readonly libraryResolver: PcbReadOnlyLibraryResolver; readonly schematicLibraryResolver: FreshSchematicApprovedGeometryResolver;
  readonly auxiliaryConnectivity?: readonly FreshExternalPowerGroup[];
}): FreshPlaneArtifactAssessment {
  const bundle = input.connectivity.compilationBundle, contract = bundle.contract, sources = input.sources;
  need(isAuthenticatedPcbPlaneCompilationBundle(bundle) && input.connectivity.pcbSource === sources.pcb, "current PCB/V2 source binding required");
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, input.libraryResolver);
  need(bundle.libraryBinding.sourceSelection !== undefined, "complete current approved library source pins required");
  if (bundle.externalPowerBinding !== undefined) assertPcbExternalPowerBindingCurrent(bundle.externalPowerBinding, input.libraryResolver);
  const logical = createFreshConnectivityContract(contract, bundle.externalPowerBinding, bundle.derivedPowerBinding);
  validateCurrentFreshNativeTerminalBinding(input.nativeNetlistBinding, logical.identity,
    freshPlaneArtifactNetlistScope(bundle, input.connectivity.scopeIdentity, sources));
  need(same(input.nativeNetlistBinding.nativeNetlistContentIdentity, contentIdentity(input.nativeNetlistSource)), "native export differs from its current source-bound authority");
  const prepared = prepareFreshPlaneConnectivity(input.connectivity);
  const native = verifyHostKicadNativePadObservation(input.nativePads, prepared.nativePadExpected), inventory = native.inventory;
  need(inventory !== null && inventory.unsupportedPhysicalUuids.length === 0, "complete supported native physical inventory required");
  const libraries = resolvePcbDesignCommonLibraries(contract, input.libraryResolver);
  need(libraries.disposition === "ready", "current approved symbol/footprint resolution is incomplete");
  const features = resolvePcbBoardFeatureLibraries(contract.boardFeatures, libraries, input.libraryResolver);
  need(same(libraries.symbols, bundle.libraryBinding.symbols) && same(features.footprints, bundle.libraryBinding.footprints)
    && same(features.sourceSelection ?? null, bundle.libraryBinding.sourceSelection ?? null), "reproduced library inventory differs from the authenticated bundle");
  const geometry = verifyFreshSchematicSourceLibraries({ schematicSource: sources.schematic, expectedSourceIdentity: contentIdentity(sources.schematic),
    contract, libraryResolver: input.schematicLibraryResolver, ...(bundle.externalPowerBinding === undefined ? {} : { externalPowerBinding: bundle.externalPowerBinding }),
    ...(bundle.derivedPowerBinding === undefined ? {} : { derivedPowerBinding: bundle.derivedPowerBinding }),
    ...(input.auxiliaryConnectivity === undefined ? {} : { auxiliaryConnectivity: input.auxiliaryConnectivity }) });
  need(geometry.sourceBindings.every(binding => same(binding.librarySourceIdentity, bundle.libraryBinding.sourceSelection!.records.find(record => record.kind === "symbol" && record.libraryId === binding.symbolLibId)?.sourceIdentity)),
    "saved symbol geometry is not bound to the same current approved symbol sources");
  const auxiliary = verifyFreshExternalPowerSource(logical, sources.schematic, { ...(input.auxiliaryConnectivity === undefined ? {} : { groups: input.auxiliaryConnectivity }) });
  if (powerAnnotationBindingOf(bundle) !== undefined) need(input.auxiliaryConnectivity !== undefined, "complete native power-annotation groups required");
  if (bundle.derivedPowerBinding !== undefined) assertPcbDerivedPowerBindingCurrent(bundle.derivedPowerBinding, bundle.libraryBinding, input.libraryResolver);
  const board = parseFreshPcbSource(sources.pcb), schematic = parseFreshSchematicSource(sources.schematic), netlist = parseFreshNetlistSource(input.nativeNetlistSource);
  need(same(sorted(board.footprints.map(fp => fp.reference)), sorted([...contract.components.map(c => c.reference), ...(contract.boardFeatures ?? []).map(f => f.reference)])), "complete PCB reference inventory differs");
  need(same(sorted(auxiliary.physicalSymbols.map(s => s.reference)), sorted(contract.components.map(c => c.reference))), "complete schematic reference inventory differs");
  const rows: FreshPlaneArtifactRow[] = [], components: ComponentFact[] = [];
  const add = (id: string, kind: Kind, passed: boolean, reason: string, requiresNativeClearance = false) => rows.push({ id, kind, status: passed ? "pass" : "fail", reasons: [reason], requiresNativeClearance });
  for (const c of contract.components) {
    const fp = board.footprints.find(fp => fp.reference === c.reference)!, binding = native.physicalLibraryBindings.find(b => b.reference === c.reference);
    need(binding !== undefined && binding.libraryId === c.footprintLibId, "missing source-pinned physical library binding");
    const pads = inventory.physicalPads.filter(p => p.reference === c.reference), terminals = inventory.terminals.filter(t => t.reference === c.reference);
    const expectedNets = new Map(c.pins.map(pin => [pin.pin, pin.assignment.kind === "net" ? pin.assignment.net
      : input.connectivity.nativeTerminalBinding?.endpoints.find(e => e.reference === c.reference && e.pin === pin.pin)?.nativeNetName ?? null]));
    const padsExact = same(sorted(terminals.map(t => t.number)), sorted(c.pins.map(p => p.pin))) && terminals.every(t => t.eligibleForPinMatching)
      && pads.every(p => p.issues.length === 0 && (p.role === "numbered-copper" ? expectedNets.has(p.number) && p.netName === expectedNets.get(p.number)
        : p.netName === null && (p.role === "paste-aperture" || p.role === "mechanical-hole")));
    const placed = schematic.symbols.filter(s => s.reference === c.reference), exported = netlist.components.filter(s => s.reference === c.reference);
    const schematicExact = placed.length === 1 && placed[0]!.libId === c.symbolLibId && placed[0]!.value === c.value && placed[0]!.footprint === c.footprintLibId
      && exported.length === 1 && exported[0]!.symbolLibId === c.symbolLibId && exported[0]!.value === c.value && exported[0]!.footprintLibId === c.footprintLibId;
    add(`library:${c.reference}`, "library", true, "Exact current approved symbol pins, footprint logical/physical inventory and selected source definitions reproduce.");
    add(`pcb:${c.reference}`, "pcb_component", fp.libraryId === c.footprintLibId && fp.value === c.value && padsExact,
      "Complete saved/native footprint, value, logical terminals and every physical member are compared with the contract and approved geometry.");
    add(`schematic:${c.reference}`, "schematic", schematicExact,
      "Exact saved symbol/value/footprint, selected embedded pins/graphics and complete source-bound native pin dispositions match the contract.");
    components.push({ reference: c.reference, symbolLibraryId: c.symbolLibId, footprintLibraryId: c.footprintLibId, value: fp.value,
      pinCount: c.pins.length, physicalPadCount: pads.length, logicalTerminalCount: terminals.length,
      nonElectricalFeatureCount: pads.filter(p => p.role !== "numbered-copper").length, libraryPhysicalInventoryIdentity: binding.physicalInventoryIdentity });
  }
  for (const net of contract.nets) add(`schematic-net:${net.name}`, "schematic", true,
    "The current native export contains exactly the declared functional net and endpoint set; no-connects are separately qualified native singleton nets.");
  for (const source of contract.derivedPowerSources ?? []) add(`derived-power:${source.id}`, "schematic", true,
    "Current approved driver/passive pin facts, all required native source/path/ground groups and the complete source-only flag inventory match. Electrical performance is not evaluated.");
  verifyFreshBoardFeatures(bundle, sources.pcb, input.libraryResolver);
  for (const feature of contract.boardFeatures ?? []) {
    const pads = inventory.physicalPads.filter(p => p.reference === feature.reference), terminals = inventory.terminals.filter(t => t.reference === feature.reference);
    add(`board-feature:${feature.reference}`, "pcb_component", pads.length > 0 && pads.every(p => p.role === "mechanical-hole" && p.netName === null && p.issues.length === 0) && terminals.length === 0,
      "Exact source-bound NPTH geometry, immutable pose, physical inventory and board-only/BOM/position exclusions are verified; independent native hole/clearance checks remain required.", true);
  }
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, input.libraryResolver);
  return issue(bundle, input.connectivity.scopeIdentity, sources, { group: "components", rows, components, netClasses: [], evidence: {
    nativePadObservationIdentity: native.rawEnvelopeIdentity, nativeNetlistBindingIdentity: input.nativeNetlistBinding.identity,
    schematicLibraryGeometryIdentity: canonicalIdentity(geometry, "evleda.fresh-schematic-source-libraries.v1"), netClassAuthorityIdentity: null,
    powerAnnotationCount: auxiliary.references.length, derivedPowerPathCount: bundle.derivedPowerBinding?.paths.length ?? 0 } });
}

/** Fresh disk/native semantic verification, not acceptance of a deserialized preparation receipt. */
export async function collectFreshPlaneNetClassArtifacts(input: {
  readonly authority: FreshPlaneNetClassSemanticAuthority; readonly options: FreshPlaneNetClassOperationOptions;
  readonly hostScopeIdentity: CanonicalIdentity; readonly expectedSources: FreshPlaneArtifactSourceIdentities;
}): Promise<FreshPlaneArtifactAssessment> {
  const { project, compilationBundle: bundle } = input.options;
  const files = { pcb: project.pcbPath, schematic: project.schematicPath, project: path.join(project.projectPath, `${project.name}.kicad_pro`),
    rules: project.rulesPath, symbolLibraryTable: path.join(project.projectPath, "sym-lib-table"), footprintLibraryTable: path.join(project.projectPath, "fp-lib-table") };
  const capture = async () => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await readFile(file, "utf8")]))) as unknown as FreshPlaneArtifactSources;
  const before = await capture(); need(same(freshPlaneArtifactSourceIdentities(before), input.expectedSources), "net-class input sources drifted");
  const authority = await verifyFreshPlaneNetClassSemanticAuthority(input.authority, input.options);
  const after = await capture(); need(same(before, after), "net-class verification changed or outlived its exact source snapshot");
  const rows: FreshPlaneArtifactRow[] = [], netClasses: NetClassFact[] = [];
  for (const c of bundle.contract.netClasses) {
    const assignments = authority.contractNetAssignments.filter(a => a.contractNetClassId === c.id), names = new Set(assignments.map(a => a.kicadNetClassName));
    const definition = names.size === 1 ? authority.netClasses.find(d => names.has(d.name)) : undefined;
    const expectedNets = sorted(bundle.contract.nets.filter(n => n.netClassId === c.id).map(n => n.name)), actualNets = sorted(assignments.map(a => a.netName));
    const exact = definition !== undefined && same(actualNets, expectedNets) && definition.track_width === c.traceWidthMm && definition.clearance === c.clearanceMm;
    rows.push({ id: `netclass:${c.id}`, kind: "netclass_configuration", status: definition === undefined ? "unknown" : exact ? "pass" : "fail", requiresNativeClearance: false,
      reasons: ["Fresh canonical-rule/native-semantic verification checks exclusive class assignment, exact trace-width preference and configured class clearance. Zone clearance and current capacity remain separate."] });
    netClasses.push({ id: c.id, nativeName: definition?.name ?? null, assignedNets: actualNets, traceWidthMm: definition?.track_width ?? null,
      classClearanceMm: definition?.clearance ?? null, boardMinimumClearanceMm: authority.boardMinimumClearanceMm,
      effectiveMinimumClearanceMm: definition === undefined ? null : Math.max(authority.boardMinimumClearanceMm, definition.clearance) });
  }
  return issue(bundle, input.hostScopeIdentity, before, { group: "netclasses", rows, components: [], netClasses, evidence: {
    nativePadObservationIdentity: null, nativeNetlistBindingIdentity: null, schematicLibraryGeometryIdentity: null,
    netClassAuthorityIdentity: authority.identity, powerAnnotationCount: 0, derivedPowerPathCount: 0 } });
}
