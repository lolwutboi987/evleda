import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { freshNetClassPreparationMechanics as classes } from "./fresh-clearance-evidence.js";
import { assertEmptyDerivedNetClassAssignments, assertExactContractNetClassPatterns } from "./fresh-netclass-assignment.js";
import { seedFreshBoardFeatures, verifyFreshBoardFeatures } from "./fresh-board-features.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument, type FreshKicadSourceNode } from "./fresh-kicad-parser.js";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requireValue = (value: unknown, message: string): void => { if (!value) throw new Error(`Placement revision: ${message}`); };
const text = (source: string): string => {
  requireValue(typeof source === "string" && source.isWellFormed() && Buffer.byteLength(source) <= 2 * 1024 * 1024,
    "source must be bounded scalar UTF-8 text");
  return source;
};
const object = (value: unknown): Record<string, unknown> => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "expected a source object");
  return value as Record<string, unknown>;
};
const one = (node: FreshKicadSourceNode, name: string): FreshKicadSourceNode => {
  const matches = node.children.filter(child => child.name === name);
  requireValue(matches.length === 1, `expected exactly one ${node.name}/${name}`);
  return matches[0]!;
};
const scalar = (node: FreshKicadSourceNode): string => {
  requireValue(node.values.length === 1 && node.children.length === 0, `expected scalar ${node.name}`);
  return node.values[0]!.value;
};
const uuids = (node: FreshKicadSourceNode): FreshKicadSourceNode[] =>
  [...(node.name === "uuid" ? [node] : []), ...node.children.flatMap(uuids)];
const reference = (node: FreshKicadSourceNode): string => {
  const fields = node.children.filter(child => child.name === "property" && child.values[0]?.value === "Reference");
  requireValue(fields.length === 1 && fields[0]!.values.length === 2, "footprint lacks one exact reference property");
  return fields[0]!.values[1]!.value;
};

/** KiCad 10.0.3 commit 146a4f2a7585c65bc580427a19b6fe2ec4a3f622:
 * pcb_io_kicad_sexpr.cpp format(BOARD*) orders footprints with BOARD_ITEM::ptr_cmp;
 * board_item.cpp orders equal types/layer sets by UUID. Front-side footprints
 * share the same type and single layer. Preserve each complete source form. */
function nativeFootprintOrder(source: string) {
  const root = parseFreshPcbSourceDocument(source), slots = root.children.filter(n => n.name === "footprint");
  requireValue(slots.length > 0 && slots.every(n => scalar(one(n, "layer")) === "F.Cu"), "native revision ordering requires front-side footprints");
  const first = root.children.indexOf(slots[0]!), last = root.children.indexOf(slots.at(-1)!);
  requireValue(last - first + 1 === slots.length, "native footprint block contains interleaved root forms");
  const parts = slots.map(node => ({ reference: reference(node), uuid: scalar(one(node, "uuid")), source: source.slice(node.start, node.end) }));
  const ordered = [...parts].sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
  let result = source;
  for (let i = slots.length - 1; i >= 0; i--) result = result.slice(0, slots[i]!.start) + ordered[i]!.source + result.slice(slots[i]!.end);
  return { source: result, before: parts.map(p => p.reference), after: ordered.map(p => p.reference) };
}

/** Placement-only contract comparison. Circuit, board, stackup, routing, plane
 * policy, electrical limits and approved library selections cannot change. */
export function assertPlanePlacementRevisionScope(source: PcbPlaneCompilationBundle, target: PcbPlaneCompilationBundle): void {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(source) && isAuthenticatedPcbPlaneCompilationBundle(target),
    "both bundles must be authenticated");
  const contract = ({ identity: _identity, placementConstraints: _placement, ...rest }: PcbPlaneCompilationBundle["contract"]) => rest;
  const draft = ({ placementConstraints: _placement, ...rest }: PcbPlaneCompilationBundle["draft"]) => rest;
  const library = ({ identity: _identity, contractIdentity: _contract, ...rest }: PcbPlaneCompilationBundle["libraryBinding"]) => rest;
  requireValue(equal(contract(source.contract), contract(target.contract)) && equal(draft(source.draft), draft(target.draft))
    && equal(library(source.libraryBinding), library(target.libraryBinding)) && equal(source.selectionPolicy, target.selectionPolicy),
  "only component placement constraints and original-prompt metadata may differ");
  requireValue(!equal(source.contract.placementConstraints, target.contract.placementConstraints), "a placement revision must change placement intent");
}

export type PlaneRevisionKind = "placement" | "via-budgets";
/** Saved copies are operator recovery seeds, never ordinary public revisions. */
export type PlaneSourceSeedKind = PlaneRevisionKind | "saved-copy";

/** A separate engineering revision, never an amendment to a checker or an
 * existing allocation. Only bounded per-net via-count changes on nets with
 * no continuous-reference requirement are supported. */
export function assertPlaneViaBudgetRevisionScope(source: PcbPlaneCompilationBundle, target: PcbPlaneCompilationBundle): void {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(source) && isAuthenticatedPcbPlaneCompilationBundle(target),
    "both bundles must be authenticated");
  const withoutBudgets = (routing: PcbPlaneCompilationBundle["contract"]["routingConstraints"]
    | PcbPlaneCompilationBundle["draft"]["routingConstraints"]) => ({
    ...routing, nets: routing.nets.map(rule => {
      if (!("maxVias" in rule)) return rule;
      const { maxVias: _budget, ...rest } = rule; return rest;
    }),
  });
  const contract = ({ identity: _identity, routingConstraints, ...rest }: PcbPlaneCompilationBundle["contract"]) =>
    ({ ...rest, routingConstraints: withoutBudgets(routingConstraints) });
  const draft = ({ routingConstraints, ...rest }: PcbPlaneCompilationBundle["draft"]) =>
    ({ ...rest, routingConstraints: withoutBudgets(routingConstraints) });
  const library = ({ identity: _identity, contractIdentity: _contract, ...rest }: PcbPlaneCompilationBundle["libraryBinding"]) => rest;
  requireValue(equal(contract(source.contract), contract(target.contract)) && equal(draft(source.draft), draft(target.draft))
    && equal(library(source.libraryBinding), library(target.libraryBinding)) && equal(source.selectionPolicy, target.selectionPolicy),
  "only per-net via-count budgets and original-prompt metadata may differ");
  let changed = false;
  for (const [index, before] of source.contract.routingConstraints.nets.entries()) {
    const after = target.contract.routingConstraints.nets[index]!;
    if (!("maxVias" in before) || !("maxVias" in after) || before.maxVias === after.maxVias) continue;
    requireValue(typeof before.maxVias === "number" && typeof after.maxVias === "number"
      && after.maxVias >= 0 && after.referencePath.mode === "none"
      && target.contract.routingConstraints.viaPolicy.mode === "bounded"
      && after.maxVias <= target.contract.routingConstraints.viaPolicy.maxTotal,
    "via budgets may only change on nets without continuous-reference requirements");
    changed = true;
  }
  requireValue(changed, "a via-budget revision must change at least one per-net budget");
}

export interface PlanePlacementRevisionSources {
  readonly pcb: string;
  readonly sch: string;
  readonly pro: string;
  readonly dru: string;
}

/** Pure proposal, not an import or a fresh-project capability. The workspace
 * must separately qualify a genuine closed source, current libraries/profile,
 * leases and destination, then perform native open/save/readback. */
export function planPlanePlacementRevisionSources(input: {
  readonly name: string;
  readonly sourceBundle: PcbPlaneCompilationBundle;
  readonly targetBundle: PcbPlaneCompilationBundle;
  readonly sources: PlanePlacementRevisionSources;
  readonly revisionKind?: PlaneSourceSeedKind;
}) {
  const { sourceBundle: source, targetBundle: target } = input;
  const revisionKind = input.revisionKind ?? "placement";
  requireValue(revisionKind === "placement" || revisionKind === "via-budgets" || revisionKind === "saved-copy", "unsupported revision kind");
  if (revisionKind === "saved-copy") requireValue(isAuthenticatedPcbPlaneCompilationBundle(source)
    && isAuthenticatedPcbPlaneCompilationBundle(target) && equal(source, target), "saved-copy recovery cannot change its authenticated bundle");
  else if (revisionKind === "via-budgets") assertPlaneViaBudgetRevisionScope(source, target);
  else assertPlanePlacementRevisionScope(source, target);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(input.name), "same safe project stem is required");
  const original = Object.freeze({ pcb: text(input.sources.pcb), sch: text(input.sources.sch),
    pro: text(input.sources.pro), dru: text(input.sources.dru) });
  const oldRules = createFreshPlaneRules(source), newRules = createFreshPlaneRules(target);
  requireValue(original.dru === oldRules.source, "source custom rules are not its canonical owned rules");
  const board = parseFreshPcbSource(original.pcb), tree = parseFreshPcbSourceDocument(original.pcb);
  if (revisionKind === "via-budgets") {
    for (const rule of target.contract.routingConstraints.nets) if ("maxVias" in rule) {
      requireValue(board.vias.filter(via => via.netName === rule.net).length <= rule.maxVias,
        `existing native via count exceeds revised budget for ${rule.net}`);
    }
  }
  requireValue(scalar(one(tree, "version")) === "20260206", "only the characterized KiCad 10 board format is supported");
  const expectedReferences = [...source.contract.components.map(c => c.reference), ...(source.contract.boardFeatures ?? []).map(f => f.reference)].sort();
  requireValue(equal(board.footprints.map(f => f.reference).sort(), expectedReferences), "source needs the complete exact materialized footprint inventory");
  verifyFreshBoardFeatures(source, original.pcb);
  const edits: { start: number; end: number; replacement: string; kind: "feature-uuid" | "zone-name" }[] = [];
  const uuidMappings: { reference: string; source: string; target: string }[] = [];
  const oldSeed = parseFreshPcbSourceDocument(seedFreshBoardFeatures(source, "(kicad_pcb)"));
  const newSeed = parseFreshPcbSourceDocument(seedFreshBoardFeatures(target, "(kicad_pcb)"));
  for (const feature of source.contract.boardFeatures ?? []) {
    const old = oldSeed.children.find(n => n.name === "footprint" && reference(n) === feature.reference)!;
    const next = newSeed.children.find(n => n.name === "footprint" && reference(n) === feature.reference)!;
    const oldIds = uuids(old).map(scalar), nextIds = uuids(next).map(scalar);
    requireValue(oldIds.length === nextIds.length && new Set(oldIds).size === oldIds.length, "feature identity inventory differs");
    const current = tree.children.find(n => n.name === "footprint" && reference(n) === feature.reference)!;
    const actualIds = uuids(current);
    for (const [index, oldId] of oldIds.entries()) {
      const matches = actualIds.filter(n => scalar(n) === oldId);
      requireValue(matches.length === 1, "source feature lacks one exact constructor-owned UUID");
      if (oldId === nextIds[index]) continue;
      const atom = matches[0]!.values[0]!;
      edits.push({ start: atom.start, end: atom.end, replacement: JSON.stringify(nextIds[index]), kind: "feature-uuid" });
      uuidMappings.push({ reference: feature.reference, source: oldId, target: nextIds[index]! });
    }
  }
  const zoneMappings: { planeId: string; uuid: string; source: string; target: string }[] = [];
  const seenPlanes = new Set<string>();
  for (const zone of tree.children.filter(n => n.name === "zone")) {
    const name = one(zone, "name"), current = scalar(name), index = oldRules.zones.findIndex(z => z.zoneName === current);
    requireValue(index >= 0 && !seenPlanes.has(current), "source contains an unowned or duplicate plane");
    seenPlanes.add(current);
    requireValue(scalar(one(zone, "net")) === source.contract.planes[index]!.net
      && scalar(one(zone, "layer")) === oldRules.zones[index]!.layer, "source zone net/layer differs from its owned plane");
    const atom = name.values[0]!;
    edits.push({ start: atom.start, end: atom.end, replacement: JSON.stringify(newRules.zones[index]!.zoneName), kind: "zone-name" });
    zoneMappings.push({ planeId: oldRules.zones[index]!.planeId, uuid: scalar(one(zone, "uuid")), source: current, target: newRules.zones[index]!.zoneName });
  }
  let pcb = original.pcb;
  let last = pcb.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    requireValue(edit.start >= 0 && edit.end <= last && edit.start < edit.end, "overlapping or invalid source edits");
    pcb = pcb.slice(0, edit.start) + edit.replacement + pcb.slice(edit.end);
    last = edit.start;
  }
  for (const mapping of uuidMappings) requireValue(!pcb.includes(mapping.source)
    && !original.sch.includes(mapping.source) && !original.pro.includes(mapping.source) && !original.dru.includes(mapping.source),
  "constructor-owned UUID has an unsupported external reference");
  const order = nativeFootprintOrder(pcb);
  pcb = order.source;
  const revised = parseFreshPcbSource(pcb);
  requireValue(equal(revised.segments, board.segments) && equal(revised.vias, board.vias), "routing changed during namespace rebinding");
  const featureReferences = new Set((source.contract.boardFeatures ?? []).map(f => f.reference));
  const functional = (value: typeof board) => value.footprints.filter(f => !featureReferences.has(f.reference))
    .sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
  requireValue(equal(functional(revised), functional(board)),
    "functional footprint geometry or metadata changed");
  verifyFreshBoardFeatures(target, pcb);

  const project = object(structuredClone(parsePortableJsonBytes(Buffer.from(original.pro), { maxBytes: 2 * 1024 * 1024, maxDepth: 64,
    maxNodes: 100_000, maxArrayLength: 10_000, maxOwnKeys: 2048, maxKeyBytes: 512, maxStringBytes: 1024 * 1024 })));
  requireValue(object(project.board).file === `${input.name}.kicad_pcb`, "project does not name the same local board");
  const settings = object(project.net_settings), oldClasses = classes.classBindings(source), newClasses = classes.classBindings(target);
  assertExactContractNetClassPatterns(settings.netclass_patterns, classes.authoredPatternsForBindings(oldClasses));
  assertEmptyDerivedNetClassAssignments(settings.netclass_assignments);
  requireValue(Array.isArray(settings.classes), "source class inventory is missing");
  const classMappings = new Map(oldClasses.map((c, i) => [c.kicadNetClassName, newClasses[i]!.kicadNetClassName]));
  const found = new Set<string>();
  settings.classes = (settings.classes as unknown[]).map(value => {
    const definition = object(value), name = definition.name;
    requireValue(typeof name === "string" && !found.has(name), "duplicate or unnamed source class");
    found.add(name as string);
    const index = oldClasses.findIndex(c => c.kicadNetClassName === name);
    if (index < 0) {
      requireValue(!(name as string).startsWith("EVLEDA_") && ![...classMappings.values()].includes(name as string), "foreign or conflicting managed class");
      return definition;
    }
    requireValue(equal(definition, classes.generatedNetClass(oldClasses[index]!, source.contract)), "owned class settings differ from the bound policy");
    return { ...definition, name: newClasses[index]!.kicadNetClassName };
  });
  requireValue(oldClasses.every(c => found.has(c.kicadNetClassName)), "source omits an owned class");
  settings.netclass_patterns = (settings.netclass_patterns as { pattern: string; netclass: string }[])
    .map(entry => ({ ...entry, netclass: classMappings.get(entry.netclass)! }));
  assertExactContractNetClassPatterns(settings.netclass_patterns, classes.authoredPatternsForBindings(newClasses));
  const sources = Object.freeze({ pcb, sch: original.sch, pro: JSON.stringify(project, null, 2) + "\n", dru: newRules.source });
  const payload = { schemaVersion: revisionKind === "saved-copy" ? "evleda.plane-saved-copy-source-plan.v1" as const
    : revisionKind === "via-budgets" ? "evleda.plane-via-budget-revision-source-plan.v1" as const
    : "evleda.plane-placement-revision-source-plan.v1" as const, sourceBundleIdentity: source.identity,
    targetBundleIdentity: target.identity, sourceIdentities: Object.fromEntries(Object.entries(original).map(([k, v]) => [k, contentIdentity(v)])),
    targetIdentities: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, contentIdentity(v)])),
    featureUuidMappings: uuidMappings, zoneNameMappings: zoneMappings,
    footprintSerializationOrder: { method: "kicad-10.0.3-front-footprint-uuid-order", before: order.before, after: order.after,
      changed: !equal(order.before, order.after) },
    netClassNameMappings: [...classMappings].map(([source, target]) => ({ source, target })),
    schematicBytesPreserved: true as const, routingGeometryPreserved: true as const, functionalFootprintsPreserved: true as const,
    freshnessTransferred: false as const, sourceLifecycleQualified: false as const, nativeAuthoringPerformed: false as const,
    acceptanceEvaluated: false as const };
  return freezePcbPlaneArtifact({ sources, receipt: { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) } });
}
