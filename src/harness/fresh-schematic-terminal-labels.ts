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
export interface FreshTerminalLabelPlanningInput {
  readonly contract: FreshConnectivityContract; readonly partition: FreshSchematicTerminalPartition; readonly sourceIdentity: ContentIdentity;
  readonly pins: ReadonlyMap<string, Pin>; readonly boxes: readonly FreshTerminalLabelObstacle[]; readonly sheet: FreshBounds;
  readonly strokeStyle?: FreshSchematicStrokeStyleEvidence;
  readonly sourceBodyBoxes?: readonly FreshTerminalLabelObstacle[];
  readonly escapeGeometry?: readonly FreshSchematicEscapeGeometry[];
}
export interface FreshTerminalLabelPlanningSession {
  readonly plan: FreshTerminalLabelPlan;
  /** Host-only synchronous continuation; never serialized as geometry authority. */
  retryDeclaredPowerAnchor(endpoint: string): FreshTerminalLabelPlan | null;
}
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
export function planFreshTerminalGlobalLabels(input: FreshTerminalLabelPlanningInput, budget = new FreshSchematicWorkBudget()): FreshTerminalLabelPlan {
  return createFreshTerminalLabelPlanningSession(input, budget).plan;
}

/** Private choices are retained only for declared flag-anchor retries on this budget. */
export function createFreshTerminalLabelPlanningSession(input: FreshTerminalLabelPlanningInput,
  budget = new FreshSchematicWorkBudget()): FreshTerminalLabelPlanningSession {
  const empty = (code: string, message: string, endpoints?: readonly string[]): FreshTerminalLabelPlan => ({ wires: [], labels: [], routes: [],
    issues: [{ code, message, remediation: "Keep connectivity unchanged; resolve source evidence or reserve collision-free terminal label space.", ...(endpoints === undefined ? {} : { endpoints }) }] });
  const finished = (plan: FreshTerminalLabelPlan): FreshTerminalLabelPlanningSession => ({ plan, retryDeclaredPowerAnchor: () => null });
  try {
    assertFreshTerminalLabelPartition(input.contract, input.partition, input.sourceIdentity, input.pins, budget);
    if (input.strokeStyle !== undefined) {
      assertFreshSchematicStrokeStyleEvidence(input.strokeStyle, input.sourceIdentity);
      if (!input.strokeStyle.globalLabelPlanning.supported) throw new Error(`Global label style is outside the native-qualified stock envelope: ${input.strokeStyle.globalLabelPlanning.unsupported.join(", ")}.`);
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
  catch (error) { return finished(empty(budget.snapshot().status === "exhausted" ? "PLANNING_WORK_LIMIT" : "TERMINAL_LABEL_SOURCE_MISMATCH", error instanceof Error ? error.message : "Terminal partition unavailable.")); }
  if (input.boxes.some(box => ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite) || box.minX > box.maxX || box.minY > box.maxY)
    || input.contract.components.some(component => !input.boxes.some(box => box.reference === component.reference))) return finished(empty("TERMINAL_LABEL_SOURCE_MISMATCH", "Complete source body/pin and current native glyph obstacles are required."));
  const labels: FreshPlannedGlobalLabel[] = [], wires: FreshTerminalLabelWire[] = [], routes: string[] = [];
  // Snapshot value geometry; issued source/style objects and immutable groups
  // retain their original authority. Returned plans cannot alter this state.
  const pins = new Map([...input.pins].map(([endpoint, pin]) => [endpoint, { ...pin }]));
  const obstacles = [...input.boxes, ...(input.sourceBodyBoxes ?? [])].map(box => ({ ...box,
    ...(box.nativeText === undefined ? {} : { nativeText: { ...box.nativeText, coveringLabel: box.nativeText.coveringLabel === null ? null
      : { ...box.nativeText.coveringLabel, at: { ...box.nativeText.coveringLabel.at } } } }) }));
  const sheet = { ...input.sheet };
  const strokeStyle = input.strokeStyle, escapes = [...input.escapeGeometry ?? []], larger = input.contract.components.length > 8;
  const pinTipMargin = strokeStyle === undefined ? 0
    : Math.max(strokeStyle.symbolDefaultStrokeWidthMm, strokeStyle.minimumPlotStrokeWidthMm) + 0.001;
  const distances = [1.27, 2.54, 3.81, 5.08, 7.62, 10.16, 12.7, 15.24, 20.32, 25.4, 30.48, 38.1, 50.8];
  type Group = FreshSchematicTerminalPartition["groups"][number];
  type Selection = { label: FreshPlannedGlobalLabel; wire: FreshTerminalLabelWire; distanceIndex: number };
  const choices: { group: Group; distanceIndex: number }[] = [];
  const groups = input.partition.groups.filter(group => group.assignment.kind === "net").map(group => ({ ...group,
    memberEndpointIds: [...group.memberEndpointIds], assignment: { ...group.assignment }, sourceTransformedAnchor: { ...group.sourceTransformedAnchor } }));
  const minimumIndices = new Map<string, number>();
  const select = (group: Group, startIndex = 0): Selection | undefined => {
    if (group.assignment.kind === "no_connect") return undefined;
    const pin = pins.get(group.memberEndpointIds[0]!)!, orientation = freshGlobalLabelOrientation(pin.angleDeg);
    const members = new Set(group.memberEndpointIds), name = group.assignment.net;
    const escapeGeometry = escapes.find(value => value.reference === group.reference);
    const dx = pin.angleDeg === 0 ? -1 : pin.angleDeg === 180 ? 1 : 0, dy = pin.angleDeg === 90 ? 1 : pin.angleDeg === 270 ? -1 : 0;
    for (let distanceIndex = Math.max(startIndex, minimumIndices.get(group.id) ?? 0); distanceIndex < distances.length; distanceIndex++) {
      if (!budget.charge("label")) break;
      const distance = distances[distanceIndex]!;
      const at = { x: Number((pin.x + dx * distance).toFixed(4)), y: Number((pin.y + dy * distance).toFixed(4)) };
      if ([pin.x, pin.y, at.x, at.y].some(value => Math.abs(value / 1.27 - Math.round(value / 1.27)) > 1e-7)) continue;
      const bounds = approximateFreshGlobalLabelBounds(name, at, orientation.rotationDeg);
      if (bounds === null || bounds.minX < sheet.minX || bounds.maxX > sheet.maxX || bounds.minY < sheet.minY || bounds.maxY > sheet.maxY) continue;
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
        const ownPinStrokeExit = box.reference === group.reference && box.nativeText === undefined && strokeStyle !== undefined
          && tipExit >= 0 && tipExit <= pinTipMargin + 1e-9 && !inBox(at, box);
        const qualifiedOwnAggregate = escapeGeometry !== undefined && box.nativeText === undefined
          && (box.reference === group.reference && equal({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, escapeGeometry.bounds)
            || box.reference === `@source-body:${group.reference}` && equal({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, escapeGeometry.bodyBounds));
        return !ownPersistedLabel && (boxesConflict(bounds, box) || wireEntersBox(segment, box) && !ownPinStrokeExit && !qualifiedOwnAggregate);
      }) || [...pins].some(([endpoint, other]) => !budget.charge("collision") || inBox(other, bounds)
        || onWire(other, segment) && !(members.has(endpoint) && same(other, pin)))
        || labels.some(label => !budget.charge("collision") || boxesConflict(bounds, label.bounds) || wireEntersBox(segment, label.bounds))
        || wires.some(previous => !budget.charge("collision") || wiresTouch(segment, asWire(previous)) || wireEntersBox(asWire(previous), bounds))) continue;
      return { label: { name, endpointId: group.id, at, ...orientation, fontMm: 1.524, bounds }, wire, distanceIndex };
    }
    return undefined;
  };
  const append = (group: Group, selected: Selection): void => {
    labels.push(selected.label); wires.push(selected.wire); routes.push(`${selected.label.name}:${group.memberEndpointIds.join(",")}`);
    choices.push({ group, distanceIndex: selected.distanceIndex });
    if (minimumIndices.has(group.id)) minimumIndices.set(group.id, Math.max(minimumIndices.get(group.id)!, selected.distanceIndex));
  };
  const removeLast = (): void => { labels.pop(); wires.pop(); routes.pop(); choices.pop(); };
  const snapshot = (): FreshTerminalLabelPlan => ({
    wires: wires.map(wire => ({ ...wire, edgeEndpoints: [...wire.edgeEndpoints] })),
    labels: labels.map(label => ({ ...label, at: { ...label.at }, bounds: { ...label.bounds } })), routes: [...routes], issues: [],
  });
  const completeSuffix = (start: number): FreshTerminalLabelPlan => {
  for (let index = start; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.assignment.kind !== "net") throw new Error("Functional terminal inventory changed.");
    let selected = select(group);
    // Keep successful greedy plans and the legacy <=8-component path unchanged.
    // On a dead end, vary only the preceding functional choice. Each candidate
    // pair is tried once, in distance order, against the unchanged earlier prefix
    // and every original source/ink/pin/wire constraint. There is no recursive
    // search: a local retry visits at most distances.length squared candidates.
    if (selected === undefined && larger && choices.length > start && budget.snapshot().status !== "exhausted") {
      const previous = choices.at(-1)!;
      removeLast();
      for (let nextIndex = previous.distanceIndex + 1; nextIndex < distances.length;) {
        // Charge retry bookkeeping as well as every candidate/collision below.
        if (!budget.charge("label")) break;
        const alternate = select(previous.group, nextIndex);
        if (alternate === undefined) break;
        append(previous.group, alternate);
        selected = select(group);
        if (selected !== undefined) break;
        removeLast();
        if (budget.snapshot().status === "exhausted") break;
        nextIndex = alternate.distanceIndex + 1;
      }
    }
    if (budget.snapshot().status === "exhausted") return empty("PLANNING_WORK_LIMIT", "Terminal label planning exhausted the shared work budget.");
    if (selected === undefined) return empty("TERMINAL_LABEL_SPACE_UNAVAILABLE", `No bounded outward stub and label fits ${group.id} on ${group.assignment.net}.`, group.memberEndpointIds);
    append(group, selected);
  }
  return snapshot();
  };
  const plan = completeSuffix(0);
  if (plan.issues.length > 0 || !larger) return finished(plan);
  const declared = new Map<string, { net: string; index?: number }>((input.contract.derivedPowerBinding ?? input.contract.externalPowerBinding)?.flags
    .map(flag => [id(flag.anchorEndpoint), { net: flag.net }]) ?? []);
  let stopped = false;
  const exhausted = (): FreshTerminalLabelPlan => {
    stopped = true;
    return empty("PLANNING_WORK_LIMIT", "Terminal label and flag planning exhausted the shared work budget.");
  };
  const truncate = (length: number): boolean => {
    const removed = choices.length - length;
    if (removed > 0 && !budget.charge("label", removed)) return false;
    while (choices.length > length) removeLast();
    return true;
  };
  return { plan, retryDeclaredPowerAnchor(endpoint) {
    const flag = declared.get(endpoint);
    if (stopped || flag === undefined || choices.length !== groups.length) return null;
    // Resolve only after a declared flag actually fails. Preserve no-retry work
    // counters and charge every visited group/member before inspecting it.
    if (flag.index === undefined) {
      flag.index = -1;
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        if (!budget.charge("terminal_group", 1 + group.memberEndpointIds.length)) return exhausted();
        if (group.assignment.kind === "net" && group.assignment.net === flag.net && group.memberEndpointIds.includes(endpoint)) { flag.index = index; break; }
      }
    }
    const index = flag.index;
    if (index < 0) return null;
    const group = groups[index]!, previousIndex = choices[index]!.distanceIndex;
    // Floors survive suffix rebuilds, including retries of earlier anchors.
    // Every continuation advances one declared anchor; no state can recur.
    minimumIndices.set(group.id, Math.max(previousIndex + 1, minimumIndices.get(group.id) ?? 0));
    if (!truncate(index)) return exhausted();
    for (let nextIndex = minimumIndices.get(group.id)!; nextIndex < distances.length;) {
      if (!budget.charge("label")) break;
      const alternate = select(group, nextIndex);
      if (alternate === undefined) break;
      minimumIndices.set(group.id, alternate.distanceIndex);
      append(group, alternate);
      const candidate = completeSuffix(index + 1);
      if (candidate.issues.length === 0) return candidate;
      nextIndex = alternate.distanceIndex + 1;
      minimumIndices.set(group.id, nextIndex);
      if (!truncate(index)) break;
      if (budget.snapshot().status === "exhausted") break;
    }
    stopped = true;
    return budget.snapshot().status === "exhausted" ? exhausted() : null;
  } };
}
