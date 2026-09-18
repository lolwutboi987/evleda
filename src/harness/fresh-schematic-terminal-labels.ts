import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import type { FreshConnectivityContract } from "./fresh-connectivity-contract.js";
import type { FreshBounds, FreshPoint, FreshSchematicWire } from "./fresh-kicad-parser.js";
import { approximateFreshGlobalLabelBounds, freshGlobalLabelOrientation, type FreshPlannedGlobalLabel } from "./fresh-schematic-label-layout.js";
import type { FreshSchematicTerminalPartition } from "./fresh-schematic-terminal-groups.js";
import { FreshSchematicWorkBudget } from "./fresh-schematic-work-budget.js";
import { assertFreshSchematicStrokeStyleEvidence, type FreshSchematicStrokeStyleEvidence } from "./fresh-schematic-stroke-style.js";
import { assertFreshSchematicEscapeGeometryCurrent, type FreshSchematicEscapeGeometry } from "./fresh-schematic-source-adapter.js";

type Pin = FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 };
export interface FreshTerminalLabelObstacle extends FreshBounds {
  readonly reference: string;
  readonly nativeText?: Readonly<{ coveringLabel: Readonly<{ name: string; at: FreshPoint; rotationDeg: number }> | null }>;
}
export interface FreshTerminalLabelWire extends FreshPoint { readonly endX: number; readonly endY: number; readonly net: string; readonly edgeEndpoints: readonly string[] }
export interface FreshTerminalLabelIssue { readonly code: string; readonly message: string; readonly remediation: string; readonly endpoints?: readonly string[] }
export interface FreshTerminalLabelPlan { readonly wires: readonly FreshTerminalLabelWire[]; readonly labels: readonly FreshPlannedGlobalLabel[]; readonly routes: readonly string[]; readonly issues: readonly FreshTerminalLabelIssue[] }
const epsilon = 0.001, margin = 0.02;
const id = (point: { reference: string; pin: string }) => `${point.reference}:${point.pin}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const same = (a: FreshPoint, b: FreshPoint) => a.x === b.x && a.y === b.y;
const sourcePoint = (point: { xMm: number; yMm: number }): FreshPoint => ({ x: point.xMm, y: point.yMm });
const onWire = (point: FreshPoint, wire: FreshSchematicWire) => wire.start.x === wire.end.x
  ? Math.abs(point.x - wire.start.x) <= epsilon && point.y >= Math.min(wire.start.y, wire.end.y) - epsilon && point.y <= Math.max(wire.start.y, wire.end.y) + epsilon
  : Math.abs(point.y - wire.start.y) <= epsilon && point.x >= Math.min(wire.start.x, wire.end.x) - epsilon && point.x <= Math.max(wire.start.x, wire.end.x) + epsilon;
const asWire = (wire: FreshTerminalLabelWire): FreshSchematicWire => ({ start: { x: wire.x, y: wire.y }, end: { x: wire.endX, y: wire.endY } });
const inBox = (point: FreshPoint, box: FreshBounds) => point.x > box.minX && point.x < box.maxX && point.y > box.minY && point.y < box.maxY;
const boxesConflict = (a: FreshBounds, b: FreshBounds) => Math.min(a.maxX + margin, b.maxX + margin) - Math.max(a.minX - margin, b.minX - margin) > epsilon
  && Math.min(a.maxY + margin, b.maxY + margin) - Math.max(a.minY - margin, b.minY - margin) > epsilon;
const wireEntersBox = (wire: FreshSchematicWire, box: FreshBounds) => wire.start.x === wire.end.x
  ? box.minX + epsilon < wire.start.x && wire.start.x < box.maxX - epsilon && Math.max(Math.min(wire.start.y, wire.end.y), box.minY + epsilon) < Math.min(Math.max(wire.start.y, wire.end.y), box.maxY - epsilon)
  : box.minY + epsilon < wire.start.y && wire.start.y < box.maxY - epsilon && Math.max(Math.min(wire.start.x, wire.end.x), box.minX + epsilon) < Math.min(Math.max(wire.start.x, wire.end.x), box.maxX - epsilon);
const wiresTouch = (a: FreshSchematicWire, b: FreshSchematicWire) => onWire(a.start, b) || onWire(a.end, b) || onWire(b.start, a) || onWire(b.end, a)
  || a.start.x === a.end.x && b.start.y === b.end.y && onWire({ x: a.start.x, y: b.start.y }, a) && onWire({ x: a.start.x, y: b.start.y }, b)
  || b.start.x === b.end.x && a.start.y === a.end.y && onWire({ x: b.start.x, y: a.start.y }, a) && onWire({ x: b.start.x, y: a.start.y }, b);

/** Correlation and complete inventory checks; callers still own source-adapter/native provenance. */
export function assertFreshTerminalLabelPartition(contract: FreshConnectivityContract, partition: FreshSchematicTerminalPartition,
  sourceIdentity: ContentIdentity, pins?: ReadonlyMap<string, Pin>, budget = new FreshSchematicWorkBudget()): void {
  if (!Object.isFrozen(partition) || !Object.isFrozen(partition.groups) || !equal(partition.contractIdentity, contract.sourceContractIdentity)) throw new Error("Terminal labels require the exact immutable source-adapter partition.");
  const { identity, ...payload } = partition;
  if (!equal(identity, canonicalIdentity(payload, partition.schemaVersion))) throw new Error("Terminal label partition identity changed.");
  const expected = new Map<string, { readonly kind: "net"; readonly net: string } | { readonly kind: "no_connect" }>([
    ...contract.nets.flatMap(net => net.endpoints.map(point => [id(point), { kind: "net" as const, net: net.name }] as const)),
    ...contract.noConnects.map(point => [id(point), { kind: "no_connect" as const }] as const)]);
  if (!budget.charge("input", 1 + expected.size + partition.endpointToGroup.length)) throw new Error("Terminal label partition work exhausted.");
  const endpointGroups = new Map(partition.endpointToGroup.map(value => [value.endpointId, value.groupId]));
  if (endpointGroups.size !== partition.endpointToGroup.length) throw new Error("Terminal label partition repeats endpoint mappings.");
  const seen = new Set<string>();
  for (const group of partition.groups) {
    if (!budget.charge("terminal_group", 1 + group.memberEndpointIds.length)) throw new Error("Terminal label partition work exhausted.");
    if (group.unit !== 1 || !equal(group.sourceIdentity, sourceIdentity) || group.memberEndpointIds.length === 0
      || group.symbolLibId !== contract.components.find(value => value.reference === group.reference)?.symbolLibId) throw new Error("Terminal label partition has stale or foreign source geometry.");
    for (const member of group.memberEndpointIds) {
      const point = pins?.get(member);
      if (seen.has(member) || !member.startsWith(`${group.reference}:`) || !equal(expected.get(member), group.assignment)
        || endpointGroups.get(member) !== group.id
        || pins !== undefined && (point === undefined || !same(point, sourcePoint(group.liveAnchor)) || point.angleDeg !== group.angleDeg)) throw new Error("Terminal label partition differs from complete physical endpoint assignments or live anchors.");
      seen.add(member);
    }
  }
  if (seen.size !== expected.size || partition.endpointToGroup.length !== seen.size || pins !== undefined && pins.size !== seen.size) throw new Error("Terminal labels require every functional and NC endpoint exactly once.");
}

/** One outward nonzero stub/label per functional terminal group; no name-based physical merging. */
export function planFreshTerminalGlobalLabels(input: {
  readonly contract: FreshConnectivityContract; readonly partition: FreshSchematicTerminalPartition; readonly sourceIdentity: ContentIdentity;
  readonly pins: ReadonlyMap<string, Pin>; readonly boxes: readonly FreshTerminalLabelObstacle[]; readonly sheet: FreshBounds;
  readonly strokeStyle?: FreshSchematicStrokeStyleEvidence;
  readonly sourceBodyBoxes?: readonly FreshTerminalLabelObstacle[];
  readonly escapeGeometry?: readonly FreshSchematicEscapeGeometry[];
}, budget = new FreshSchematicWorkBudget()): FreshTerminalLabelPlan {
  const empty = (code: string, message: string, endpoints?: readonly string[]): FreshTerminalLabelPlan => ({ wires: [], labels: [], routes: [],
    issues: [{ code, message, remediation: "Keep connectivity unchanged; resolve source evidence or reserve collision-free terminal label space.", ...(endpoints === undefined ? {} : { endpoints }) }] });
  try {
    assertFreshTerminalLabelPartition(input.contract, input.partition, input.sourceIdentity, input.pins, budget);
    if (input.strokeStyle !== undefined) {
      assertFreshSchematicStrokeStyleEvidence(input.strokeStyle, input.sourceIdentity);
      if (input.sourceBodyBoxes === undefined) throw new Error("Source body obstacles are required alongside current pin stroke envelopes.");
    }
    if (input.escapeGeometry !== undefined) {
      if (input.strokeStyle === undefined || input.escapeGeometry.length !== input.contract.components.length
        || new Set(input.escapeGeometry.map(value => value.reference)).size !== input.contract.components.length) throw new Error("Complete source-qualified first-escape inventory is required.");
      for (const value of input.escapeGeometry) {
        assertFreshSchematicEscapeGeometryCurrent(value, input.sourceIdentity, input.strokeStyle);
        const component = input.contract.components.find(component => component.reference === value.reference);
        const members = input.partition.groups.filter(group => group.reference === value.reference).flatMap(group => group.memberEndpointIds).sort();
        if (component?.symbolLibId !== value.symbolLibId || !equal([...value.pins.map(pin => pin.endpointId)].sort(), members)) throw new Error("First-escape geometry differs from the complete component pin inventory.");
      }
    }
  }
  catch (error) { return empty(budget.snapshot().status === "exhausted" ? "PLANNING_WORK_LIMIT" : "TERMINAL_LABEL_SOURCE_MISMATCH", error instanceof Error ? error.message : "Terminal partition unavailable."); }
  if (input.boxes.some(box => ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite) || box.minX > box.maxX || box.minY > box.maxY)
    || input.contract.components.some(component => !input.boxes.some(box => box.reference === component.reference))) return empty("TERMINAL_LABEL_SOURCE_MISMATCH", "Complete source body/pin and current native glyph obstacles are required.");
  const labels: FreshPlannedGlobalLabel[] = [], wires: FreshTerminalLabelWire[] = [], routes: string[] = [];
  const obstacles = [...input.boxes, ...(input.sourceBodyBoxes ?? [])];
  const pinTipMargin = input.strokeStyle === undefined ? 0
    : Math.max(input.strokeStyle.symbolDefaultStrokeWidthMm, input.strokeStyle.minimumPlotStrokeWidthMm) + 0.001;
  for (const group of input.partition.groups) {
    if (group.assignment.kind === "no_connect") continue;
    const pin = input.pins.get(group.memberEndpointIds[0]!)!, orientation = freshGlobalLabelOrientation(pin.angleDeg);
    const members = new Set(group.memberEndpointIds), name = group.assignment.net;
    const escapeGeometry = input.escapeGeometry?.find(value => value.reference === group.reference);
    const dx = pin.angleDeg === 0 ? -1 : pin.angleDeg === 180 ? 1 : 0, dy = pin.angleDeg === 90 ? 1 : pin.angleDeg === 270 ? -1 : 0;
    let selected: { label: FreshPlannedGlobalLabel; wire: FreshTerminalLabelWire } | undefined;
    for (const distance of [1.27, 2.54, 3.81, 5.08, 7.62, 10.16, 12.7, 15.24, 20.32, 25.4, 30.48, 38.1, 50.8]) {
      if (!budget.charge("label")) break;
      const at = { x: Number((pin.x + dx * distance).toFixed(4)), y: Number((pin.y + dy * distance).toFixed(4)) };
      if ([pin.x, pin.y, at.x, at.y].some(value => Math.abs(value / 1.27 - Math.round(value / 1.27)) > 1e-7)) continue;
      const bounds = approximateFreshGlobalLabelBounds(name, at, orientation.rotationDeg);
      if (bounds === null || bounds.minX < input.sheet.minX || bounds.maxX > input.sheet.maxX || bounds.minY < input.sheet.minY || bounds.maxY > input.sheet.maxY) continue;
      const wire = { x: pin.x, y: pin.y, endX: at.x, endY: at.y, net: name, edgeEndpoints: [...group.memberEndpointIds] }, segment = asWire(wire);
      // Replace only this anchor component's merged wire obstacle with every
      // qualified graphic and pin envelope; label envelopes remain conservative.
      if (escapeGeometry !== undefined && (escapeGeometry.graphics.some(graphic => !budget.charge("collision") || wireEntersBox(segment, graphic.bounds))
        || escapeGeometry.pins.some(other => {
          if (!budget.charge("collision")) return true;
          const ownTip = members.has(other.endpointId) && other.angleDeg === group.angleDeg
            && Math.abs(other.anchor.x - group.sourceTransformedAnchor.xMm) <= 1e-9 && Math.abs(other.anchor.y - group.sourceTransformedAnchor.yMm) <= 1e-9
            && !inBox(at, other.bounds);
          return wireEntersBox(segment, other.bounds) && !ownTip;
        }))) continue;
      if (obstacles.some(box => {
        if (!budget.charge("collision")) return true;
        const own = box.nativeText?.coveringLabel;
        const ownPersistedLabel = own !== null && own !== undefined && own.name === name && same(own.at, at) && own.rotationDeg === orientation.rotationDeg
          && box.minX >= bounds.minX && box.maxX <= bounds.maxX && box.minY >= bounds.minY && box.maxY <= bounds.maxY;
        const tipExit = pin.angleDeg === 0 ? pin.x - box.minX : pin.angleDeg === 180 ? box.maxX - pin.x
          : pin.angleDeg === 90 ? box.maxY - pin.y : pin.y - box.minY;
        const ownPinStrokeExit = box.reference === group.reference && box.nativeText === undefined && input.strokeStyle !== undefined
          && tipExit >= 0 && tipExit <= pinTipMargin + 1e-9 && !inBox(at, box);
        const qualifiedOwnAggregate = escapeGeometry !== undefined && box.nativeText === undefined
          && (box.reference === group.reference && equal({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, escapeGeometry.bounds)
            || box.reference === `@source-body:${group.reference}` && equal({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, escapeGeometry.bodyBounds));
        return !ownPersistedLabel && (boxesConflict(bounds, box) || wireEntersBox(segment, box) && !ownPinStrokeExit && !qualifiedOwnAggregate);
      }) || [...input.pins].some(([endpoint, other]) => !budget.charge("collision") || inBox(other, bounds)
        || onWire(other, segment) && !(members.has(endpoint) && same(other, pin)))
        || labels.some(label => !budget.charge("collision") || boxesConflict(bounds, label.bounds) || wireEntersBox(segment, label.bounds))
        || wires.some(previous => !budget.charge("collision") || wiresTouch(segment, asWire(previous)) || wireEntersBox(asWire(previous), bounds))) continue;
      selected = { label: { name, endpointId: group.id, at, ...orientation, fontMm: 1.524, bounds }, wire };
      break;
    }
    if (budget.snapshot().status === "exhausted") return empty("PLANNING_WORK_LIMIT", "Terminal label planning exhausted the shared work budget.");
    if (selected === undefined) return empty("TERMINAL_LABEL_SPACE_UNAVAILABLE", `No bounded outward stub and label fits ${group.id} on ${name}.`, group.memberEndpointIds);
    labels.push(selected.label); wires.push(selected.wire); routes.push(`${name}:${group.memberEndpointIds.join(",")}`);
  }
  return { wires, labels, routes, issues: [] };
}
