import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { FreshConnectivityContract } from "./fresh-connectivity-contract.js";
import { freshGlobalLabelTupleInventoryMatches, freshTerminalGlobalLabelPresentationSupported, parseFreshSchematicPresentationSource, parseFreshSchematicSource,
  parseFreshSchematicTerminalGeometrySource, selectFreshSymbolTerminalGeometryPins, type FreshPoint, type FreshSchematicWire } from "./fresh-kicad-parser.js";
import { buildSchematicTerminalGroups, transformFreshSchematicSourcePin, type FreshSchematicTerminalPartition } from "./fresh-schematic-terminal-groups.js";
import { assertFreshTerminalLabelPartition } from "./fresh-schematic-terminal-labels.js";
import { FreshSchematicWorkBudget } from "./fresh-schematic-work-budget.js";
import type { PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { verifyFreshExternalPowerSource } from "./fresh-external-power.js";

// Source cardinal transforms can introduce binary floating noise; this is far
// below the existing 0.001 mm distinct-terminal rejection distance.
const epsilon = 1e-7;
const same = (a: FreshPoint, b: FreshPoint) => Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
const onWire = (point: FreshPoint, wire: FreshSchematicWire) => wire.start.x === wire.end.x
  ? Math.abs(point.x - wire.start.x) <= epsilon && point.y >= Math.min(wire.start.y, wire.end.y) - epsilon && point.y <= Math.max(wire.start.y, wire.end.y) + epsilon
  : Math.abs(point.y - wire.start.y) <= epsilon && point.x >= Math.min(wire.start.x, wire.end.x) - epsilon && point.x <= Math.max(wire.start.x, wire.end.x) + epsilon;
const anchor = (group: FreshSchematicTerminalPartition["groups"][number]): FreshPoint => ({ x: group.liveAnchor.xMm, y: group.liveAnchor.yMm });
export interface FreshTerminalGlobalLabelTuple { readonly name: string; readonly at: FreshPoint; readonly rotationDeg: 0 | 90 | 180 | 270; readonly justify: "left" | "right" | "top" | "bottom" }

/** Source-only reconstruction, not native live-pin proof; callers retain independent native graph/netlist gates and library-currentness checks. */
export function freshSavedTerminalGlobalLabelsMatch(source: string, contract: FreshConnectivityContract, resolver: PcbReadOnlyLibraryResolver,
  expectedLabels?: readonly FreshTerminalGlobalLabelTuple[], budget = new FreshSchematicWorkBudget()): boolean {
  try {
    const identity = contentIdentity(source), verified = verifyFreshExternalPowerSource(contract, source);
    const placed = parseFreshSchematicTerminalGeometrySource(source, identity, verified.references).filter(component => !verified.references.includes(component.reference));
    if (placed.length !== contract.components.length || contract.components.some(component => {
      const matches = verified.physicalSymbols.filter(actual => actual.reference === component.reference), actual = matches[0];
      return matches.length !== 1 || actual?.libId !== component.symbolLibId || actual.value !== component.value || actual.footprint !== component.footprintLibId;
    })) return false;
    for (const actual of placed) {
      const approved = resolver.inspectSymbolTerminalGeometry?.(actual.symbolLibId);
      if (!budget.charge("input", actual.pins.length + 1) || approved == null || approved.libraryId !== actual.symbolLibId
        || actual.unit !== 1 || [approved, actual.embeddedGeometry].some(geometry => geometry.representations.some(value => value.unit > 1))) return false;
      const selected = selectFreshSymbolTerminalGeometryPins(approved, actual.unit, actual.bodyStyle);
      const byNumber = new Map(selected.map(pin => [pin.number, canonicalJson(pin)]));
      if (actual.pins.length !== selected.length || actual.pins.some(pin => byNumber.get(pin.number) !== canonicalJson(pin))) return false;
    }
    const partition = buildSchematicTerminalGroups({ contractIdentity: contract.sourceContractIdentity,
      components: placed.map(component => ({ reference: component.reference, symbolLibId: component.symbolLibId, unit: component.unit,
        sourceIdentity: identity, placement: component.placement, pins: component.pins.map(pin => ({ number: pin.number, at: pin.at, angleDeg: pin.angleDeg })) })),
      assignments: [...contract.nets.flatMap(net => net.endpoints.map(endpoint => ({ ...endpoint, assignment: { kind: "net" as const, net: net.name } }))),
        ...contract.noConnects.map(endpoint => ({ ...endpoint, assignment: { kind: "no_connect" as const } }))],
      livePins: placed.flatMap(component => component.pins.map(pin => ({ reference: component.reference, pin: pin.number,
        ...transformFreshSchematicSourcePin(pin, component.placement) }))),
    }, budget);
    return partition.status === "complete" && freshTerminalGlobalLabelSourceMatches({ source, contract, partition: partition.value,
      ...(expectedLabels === undefined ? {} : { expectedLabels }) }, budget);
  } catch { return false; }
}

/** Validate actual wire islands before any equal-label-name union can conceal floating or cross-net geometry. */
export function freshTerminalGlobalLabelSourceMatches(input: {
  readonly source: string; readonly contract: FreshConnectivityContract; readonly partition: FreshSchematicTerminalPartition;
  readonly expectedLabels?: readonly FreshTerminalGlobalLabelTuple[];
}, budget = new FreshSchematicWorkBudget()): boolean {
  try {
    assertFreshTerminalLabelPartition(input.contract, input.partition, contentIdentity(input.source), undefined, budget);
    const schematic = parseFreshSchematicSource(input.source), presentation = parseFreshSchematicPresentationSource(input.source);
    const groups = input.partition.groups, functional = groups.filter(group => group.assignment.kind === "net");
    const labels = presentation.labels, wires = schematic.wires;
    const noConnects = groups.filter(group => group.assignment.kind === "no_connect");
    if (schematic.noConnects.length !== noConnects.length || noConnects.some(group => schematic.noConnects.filter(point => same(point, anchor(group))).length !== 1)) return false;
    if (schematic.childSheetCount !== 0 || labels.length !== functional.length || wires.length === 0 || wires.length > 4096
      || !freshTerminalGlobalLabelPresentationSupported(input.source)
      || !freshGlobalLabelTupleInventoryMatches(schematic, labels)
      || labels.some(label => label.fontSizeMm?.x !== 1.524 || label.fontSizeMm.y !== 1.524 || label.bold || label.italic || label.hidden
        || label.rotationDeg === null || ![0, 90, 180, 270].includes(label.rotationDeg) || label.justify?.length !== 1
        || label.justify[0] !== ({ 0: "left", 90: "bottom", 180: "right", 270: "top" } as Record<number, string>)[label.rotationDeg])
      || wires.some(wire => same(wire.start, wire.end) || wire.start.x !== wire.end.x && wire.start.y !== wire.end.y)) return false;
    if (input.expectedLabels !== undefined && (!freshGlobalLabelTupleInventoryMatches(schematic, input.expectedLabels)
      || input.expectedLabels.some(expected => !labels.some(actual => actual.name === expected.name && same(actual.at, expected.at)
        && actual.rotationDeg === expected.rotationDeg && actual.justify?.[0] === expected.justify)))) return false;
    const parents = wires.map((_, index) => index);
    const root = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]!; } return index; };
    const union = (a: number, b: number) => { parents[root(b)] = root(a); };
    // Ordinary endpoints/collinear spans connect. An interior crossing needs
    // an actual source junction or physical terminal, never just a net name.
    for (let first = 0; first < wires.length; first++) for (let second = first + 1; second < wires.length; second++) {
      if (!budget.charge("route")) return false;
      const a = wires[first]!, b = wires[second]!;
      if ([a.start, a.end].some(point => onWire(point, b)) || [b.start, b.end].some(point => onWire(point, a))) { union(first, second); continue; }
      const cross = a.start.x === a.end.x && b.start.y === b.end.y ? { x: a.start.x, y: b.start.y }
        : b.start.x === b.end.x && a.start.y === a.end.y ? { x: b.start.x, y: a.start.y } : undefined;
      if (cross !== undefined && onWire(cross, a) && onWire(cross, b)) {
        if (!schematic.junctions.some(point => same(point, cross)) && !groups.some(group => same(anchor(group), cross))) return false;
        union(first, second);
      }
    }
    const islands = new Map<number, { groups: typeof functional[number][]; labels: typeof labels[number][] }>();
    for (let index = 0; index < wires.length; index++) if (!islands.has(root(index))) islands.set(root(index), { groups: [], labels: [] });
    const atWire = (point: FreshPoint): number[] => {
      const matches: number[] = [];
      for (let index = 0; index < wires.length; index++) { if (!budget.charge("route")) return []; if (onWire(point, wires[index]!)) matches.push(root(index)); }
      return [...new Set(matches)];
    };
    for (const group of groups) {
      const matches = atWire(anchor(group));
      if (group.assignment.kind === "no_connect") { if (matches.length !== 0 || labels.some(label => same(label.at, anchor(group)))) return false; continue; }
      if (matches.length !== 1) return false;
      islands.get(matches[0]!)!.groups.push(group);
    }
    for (const label of labels) {
      const matches = atWire(label.at);
      if (matches.length !== 1 || groups.some(group => same(label.at, anchor(group)))) return false;
      islands.get(matches[0]!)!.labels.push(label);
    }
    for (const island of islands.values()) {
      if (island.groups.length === 0 || island.labels.length !== island.groups.length) return false;
      const names = new Set(island.labels.map(label => label.name));
      if (names.size !== 1 || island.groups.some(group => group.assignment.kind !== "net" || !names.has(group.assignment.net))) return false;
    }
    return budget.snapshot().status !== "exhausted";
  } catch { return false; }
}
