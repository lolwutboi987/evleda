import type { ContentIdentity } from "../domain/types.js";

/** Pure numerical facts about caller-supplied source primitives. This module
 * cannot authenticate their extraction, saved bytes, libraries or native CAD. */
export interface DifferentialPairPointNm { readonly xNm: number; readonly yNm: number }
export interface DifferentialPairPointTwiceNm { readonly xTwiceNm: string; readonly yTwiceNm: string }
interface SourcePrimitive { readonly uuid: string; readonly net: string; readonly sourceIdentity?: ContentIdentity }
export interface DifferentialPairTrack extends SourcePrimitive {
  readonly layer: string; readonly widthNm: number;
  readonly start: DifferentialPairPointNm; readonly end: DifferentialPairPointNm;
}
export interface DifferentialPairPad extends SourcePrimitive {
  readonly reference: string; readonly pad: string; readonly layers: readonly string[]; readonly center: DifferentialPairPointNm;
}
export interface DifferentialPairVia extends SourcePrimitive {
  readonly center: DifferentialPairPointNm; readonly layers: readonly string[]; readonly diameterNm: number; readonly drillNm: number;
}
export interface DifferentialPairTerminal { readonly reference: string; readonly pad: string }
export interface DifferentialPairRoles { readonly positive: DifferentialPairTerminal; readonly negative: DifferentialPairTerminal }
export interface DifferentialPairGeometryLimits {
  readonly minimumWidthNm: number; readonly maximumWidthNm: number;
  readonly minimumGapNm: number; readonly maximumCoupledGapNm: number;
  readonly maximumMainLengthNm: number; readonly maximumSkewNm: number;
  readonly maximumStubLengthNm: number; readonly maximumUncoupledLengthNm: number;
  readonly transitions: "forbidden"; readonly allowedLayers?: readonly string[];
}
export interface DifferentialPairGeometryInput {
  readonly tracks: readonly DifferentialPairTrack[]; readonly pads: readonly DifferentialPairPad[]; readonly vias: readonly DifferentialPairVia[];
  readonly positiveNet: string; readonly negativeNet: string;
  readonly source: DifferentialPairRoles; readonly receiver: DifferentialPairRoles;
  readonly receiverMapping: "preserved" | "swapped";
  readonly terminationAnchors?: readonly DifferentialPairTerminal[];
  readonly limits: DifferentialPairGeometryLimits;
}
/** (twiceAxisNm + twiceDiagonalNm * sqrt(2)) / 2 nanometres.
 * Signed coefficients are intentional, including for the absolute skew. */
export interface DifferentialPairExactLength { readonly twiceAxisNm: string; readonly twiceDiagonalNm: string }
export interface DifferentialPairSquaredDistance { readonly numerator: string; readonly denominator: string }
export type DifferentialPairCheckStatus = "pass" | "fail" | "not_assessed";
export interface DifferentialPairGeometryCheck { readonly status: DifferentialPairCheckStatus; readonly reasons: readonly string[] }
export interface DifferentialPairMemberInterval {
  readonly uuid: string; readonly start: DifferentialPairPointNm; readonly end: DifferentialPairPointNm;
  readonly widthNm: number; readonly sourceIdentity?: ContentIdentity;
}
export interface DifferentialPairGraphEdge extends DifferentialPairMemberInterval {
  readonly id: string; readonly layer: string; readonly startNode: string; readonly endNode: string;
  readonly length: DifferentialPairExactLength;
}
export interface DifferentialPairRun {
  readonly index: number; readonly layer: string; readonly widthNm: number;
  readonly start: DifferentialPairPointNm; readonly end: DifferentialPairPointNm;
  readonly direction: Readonly<{ x: number; y: number }>;
  readonly members: readonly DifferentialPairMemberInterval[]; readonly length: DifferentialPairExactLength;
}
export interface DifferentialPairStub {
  readonly attachmentNode: string; readonly edges: readonly DifferentialPairGraphEdge[];
  readonly length: DifferentialPairExactLength; readonly leafNodes: readonly string[];
  readonly maximumAttachmentToLeafLength: DifferentialPairExactLength;
}
export interface DifferentialPairRoute {
  readonly net: string; readonly status: "complete_source_tree" | "incomplete" | "not_assessed"; readonly reasons: readonly string[];
  readonly contacts: readonly Readonly<{ kind: "proper_crossing" | "positive_overlap" | "endpoint_on_interior"; firstUuid: string; secondUuid: string }>[] | null;
  readonly nodes: readonly Readonly<{ id: string; layer: string; point: DifferentialPairPointNm; padUuids: readonly string[]; viaUuids: readonly string[] }>[] | null;
  readonly edges: readonly DifferentialPairGraphEdge[] | null;
  readonly mainChain: readonly DifferentialPairGraphEdge[] | null;
  readonly runs: readonly DifferentialPairRun[] | null; readonly stubs: readonly DifferentialPairStub[] | null;
  readonly mainLength: DifferentialPairExactLength | null; readonly totalEtchLength: DifferentialPairExactLength | null;
}
export interface DifferentialPairGapObservation {
  readonly positiveUuid: string; readonly negativeUuid: string;
  readonly layerRelationship: "same_layer" | "different_layer_not_assessed";
  readonly centerlineSquaredNm2: DifferentialPairSquaredDistance | null;
  readonly radiusSumTwiceNm: string; readonly minimumGap: DifferentialPairCheckStatus;
}
export interface DifferentialPairCouplingSpan {
  readonly positiveRunIndex: number; readonly negativeRunIndex: number;
  readonly positiveStart: DifferentialPairPointTwiceNm; readonly positiveEnd: DifferentialPairPointTwiceNm;
  readonly negativeStart: DifferentialPairPointTwiceNm; readonly negativeEnd: DifferentialPairPointTwiceNm;
  readonly positiveMemberUuids: readonly string[]; readonly negativeMemberUuids: readonly string[];
  readonly length: DifferentialPairExactLength; readonly centerlineSquaredNm2: DifferentialPairSquaredDistance;
  readonly radiusSumTwiceNm: string;
}
export interface DifferentialPairRouteCoverageInterval {
  readonly runIndex: number; readonly start: DifferentialPairPointTwiceNm; readonly end: DifferentialPairPointTwiceNm;
  readonly memberUuids: readonly string[]; readonly length: DifferentialPairExactLength;
  readonly status: "paired" | "unpaired" | "ambiguous";
  readonly candidateMateRunIndices: readonly number[]; readonly reasons: readonly string[];
}
export interface DifferentialPairCouplingAssessment {
  readonly status: "complete" | "ambiguous";
  readonly paired: readonly DifferentialPairCouplingSpan[];
  readonly positiveCoverage: readonly DifferentialPairRouteCoverageInterval[];
  readonly negativeCoverage: readonly DifferentialPairRouteCoverageInterval[];
  readonly positiveUncoupledLength: DifferentialPairExactLength;
  readonly negativeUncoupledLength: DifferentialPairExactLength;
  readonly reasons: readonly string[];
}
export const DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS = Object.freeze({ maximumSelectedTracks: 256, maximumSelectedPads: 512,
  maximumSelectedVias: 64, maximumSourcePrimitives: 8192, maximumGraphEdges: 4096, maximumCouplingIntervals: 16384, maximumCoordinateNm: 2_000_000_000 });
export interface DifferentialPairGeometryAssessment {
  readonly schemaVersion: "evleda.differential-pair-geometry.v1";
  readonly selected: Readonly<{ tracks: readonly DifferentialPairTrack[]; pads: readonly DifferentialPairPad[]; vias: readonly DifferentialPairVia[] }>;
  readonly inventoryComplete: boolean; readonly diagnostics: readonly string[];
  readonly sourceRoles: readonly Readonly<{ role: string; selector: DifferentialPairTerminal; expectedNet: string; matchingPadUuids: readonly string[]; status: DifferentialPairCheckStatus }>[];
  readonly terminationAnchors: readonly Readonly<{ selector: DifferentialPairTerminal; matchingPadUuids: readonly string[]; contactNodeIds: readonly string[]; status: DifferentialPairCheckStatus }>[];
  readonly routes: Readonly<{ positive: DifferentialPairRoute; negative: DifferentialPairRoute }>;
  readonly allTrackPairGaps: readonly DifferentialPairGapObservation[] | null;
  readonly coupling: DifferentialPairCouplingAssessment | null; readonly etchSkew: DifferentialPairExactLength | null;
  readonly viaObservations: readonly Readonly<{ uuid: string; layers: readonly string[]; transition: "forbidden_present";
    unusedBarrel: "not_assessed"; verticalLength: "not_assessed" }>[];
  readonly checks: Readonly<Record<"sourcePolarity" | "topology" | "width" | "minimumGap" | "coupledGap" | "length" | "skew" | "stubs" | "uncoupled" | "transitions", DifferentialPairGeometryCheck>>;
  readonly authority: "caller_supplied_source_geometry_only";
  readonly notEvaluated: readonly string[]; readonly accepted: false;
}

type Point = DifferentialPairPointNm;
type Length = DifferentialPairExactLength;
type Fraction = { n: bigint; d: bigint };
type Direction = { x: number; y: number };
const zero = (): Length => ({ twiceAxisNm: "0", twiceDiagonalNm: "0" });
const abs = (v: bigint) => v < 0n ? -v : v;
const sign = (v: bigint): -1 | 0 | 1 => v < 0n ? -1 : v > 0n ? 1 : 0;
/** Sign-aware exact ordering: squaring opposite-sign terms is only valid after
 * keeping the sign of the rational term. No floating point tolerance is used. */
export function compareDifferentialPairLengths(left: Length, right: Length): -1 | 0 | 1 {
  const a = BigInt(left.twiceAxisNm) - BigInt(right.twiceAxisNm), b = BigInt(left.twiceDiagonalNm) - BigInt(right.twiceDiagonalNm);
  if (a === 0n) return sign(b);
  if (b === 0n || sign(a) === sign(b)) return sign(a);
  return (sign(a) * sign(a * a - 2n * b * b)) as -1 | 0 | 1;
}
const add = (a: Length, b: Length): Length => ({ twiceAxisNm: String(BigInt(a.twiceAxisNm) + BigInt(b.twiceAxisNm)), twiceDiagonalNm: String(BigInt(a.twiceDiagonalNm) + BigInt(b.twiceDiagonalNm)) });
const subtract = (a: Length, b: Length): Length => ({ twiceAxisNm: String(BigInt(a.twiceAxisNm) - BigInt(b.twiceAxisNm)), twiceDiagonalNm: String(BigInt(a.twiceDiagonalNm) - BigInt(b.twiceDiagonalNm)) });
const absoluteLength = (v: Length): Length => compareDifferentialPairLengths(v, zero()) < 0 ? subtract(zero(), v) : v;
const limitLength = (nm: number): Length => ({ twiceAxisNm: String(2n * BigInt(nm)), twiceDiagonalNm: "0" });
const sumLengths = (items: readonly { readonly length: Length }[]) => items.reduce((sum, item) => add(sum, item.length), zero());
const check = (status: DifferentialPairCheckStatus, ...reasons: string[]): DifferentialPairGeometryCheck => ({ status, reasons });
const pointKey = (p: Point) => `${p.xNm},${p.yNm}`;
const nodeKey = (p: Point, layer: string) => `${layer}:${pointKey(p)}`;
const samePoint = (a: Point, b: Point) => a.xNm === b.xNm && a.yNm === b.yNm;
const cross = (a: Point, b: Point, c: Point) => BigInt(b.xNm - a.xNm) * BigInt(c.yNm - a.yNm) - BigInt(b.yNm - a.yNm) * BigInt(c.xNm - a.xNm);
const on = (p: Point, a: Point, b: Point) => cross(a, b, p) === 0n && p.xNm >= Math.min(a.xNm, b.xNm) && p.xNm <= Math.max(a.xNm, b.xNm)
  && p.yNm >= Math.min(a.yNm, b.yNm) && p.yNm <= Math.max(a.yNm, b.yNm);
const interior = (p: Point, a: Point, b: Point) => on(p, a, b) && !samePoint(p, a) && !samePoint(p, b);
const direction = (a: Point, b: Point): Direction | null => {
  const dx = b.xNm - a.xNm, dy = b.yNm - a.yNm;
  return dx === 0 && dy === 0 || dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy) ? null : { x: Math.sign(dx), y: Math.sign(dy) };
};
const dot = (p: Point, u: Direction) => BigInt(p.xNm) * BigInt(u.x) + BigInt(p.yNm) * BigInt(u.y);
const norm = (u: Direction) => BigInt(u.x * u.x + u.y * u.y);
const directionEqual = (a: Direction, b: Direction) => a.x === b.x && a.y === b.y;
const segmentLength = (a: Point, b: Point): Length => a.xNm === b.xNm || a.yNm === b.yNm
  ? { twiceAxisNm: String(2n * (abs(BigInt(b.xNm - a.xNm)) + abs(BigInt(b.yNm - a.yNm)))), twiceDiagonalNm: "0" }
  : { twiceAxisNm: "0", twiceDiagonalNm: String(2n * abs(BigInt(b.xNm - a.xNm))) };
const projectionLength = (a: bigint, b: bigint, u: Direction): Length => norm(u) === 1n
  ? { twiceAxisNm: String(2n * (b - a)), twiceDiagonalNm: "0" }
  : { twiceAxisNm: "0", twiceDiagonalNm: String(b - a) };
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) { const next = a % b; a = b; b = next; } return a; }
const fraction = (n: bigint, d: bigint): Fraction => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const serializedFraction = (value: Fraction): DifferentialPairSquaredDistance => ({ numerator: String(value.n), denominator: String(value.d) });
const compareFraction = (a: Fraction, b: Fraction) => sign(a.n * b.d - b.n * a.d);
function pointSquaredDistance(p: Point, a: Point, b: Point): Fraction {
  const vx = BigInt(b.xNm - a.xNm), vy = BigInt(b.yNm - a.yNm), wx = BigInt(p.xNm - a.xNm), wy = BigInt(p.yNm - a.yNm);
  const squared = vx * vx + vy * vy, projection = vx * wx + vy * wy;
  if (squared === 0n || projection <= 0n) return { n: wx * wx + wy * wy, d: 1n };
  if (projection >= squared) { const dx = BigInt(p.xNm - b.xNm), dy = BigInt(p.yNm - b.yNm); return { n: dx * dx + dy * dy, d: 1n }; }
  const determinant = vx * wy - vy * wx;
  return fraction(determinant * determinant, squared);
}
function intersectionKind(a: DifferentialPairTrack, b: DifferentialPairTrack): "proper_crossing" | "positive_overlap" | "endpoint_on_interior" | null {
  const c1 = cross(a.start, a.end, b.start), c2 = cross(a.start, a.end, b.end), c3 = cross(b.start, b.end, a.start), c4 = cross(b.start, b.end, a.end);
  if (c1 === 0n && c2 === 0n) {
    const axis = a.start.xNm !== a.end.xNm ? "xNm" : "yNm";
    if (Math.max(Math.min(a.start[axis], a.end[axis]), Math.min(b.start[axis], b.end[axis])) < Math.min(Math.max(a.start[axis], a.end[axis]), Math.max(b.start[axis], b.end[axis]))) return "positive_overlap";
  }
  if (sign(c1) * sign(c2) < 0 && sign(c3) * sign(c4) < 0) return "proper_crossing";
  return interior(a.start, b.start, b.end) || interior(a.end, b.start, b.end) || interior(b.start, a.start, a.end) || interior(b.end, a.start, a.end) ? "endpoint_on_interior" : null;
}
function segmentSquaredDistance(a: DifferentialPairTrack, b: DifferentialPairTrack): Fraction {
  if (intersectionKind(a, b) !== null || on(a.start, b.start, b.end) || on(a.end, b.start, b.end) || on(b.start, a.start, a.end) || on(b.end, a.start, a.end)) return { n: 0n, d: 1n };
  return [pointSquaredDistance(a.start, b.start, b.end), pointSquaredDistance(a.end, b.start, b.end),
    pointSquaredDistance(b.start, a.start, a.end), pointSquaredDistance(b.end, a.start, a.end)]
    .reduce((minimum, value) => compareFraction(value, minimum) < 0 ? value : minimum);
}
/** Compare sqrt(distanceSquared) - (positiveWidth + negativeWidth)/2 with
 * thresholdNm. Retain the sign before squaring, including negative thresholds. */
export function compareDifferentialPairCopperGap(distance: DifferentialPairSquaredDistance, positiveWidthNm: number, negativeWidthNm: number, thresholdNm: number): -1 | 0 | 1 {
  const n = BigInt(distance.numerator), d = BigInt(distance.denominator);
  if (n < 0n || d <= 0n || positiveWidthNm < 0 || negativeWidthNm < 0 || ![positiveWidthNm, negativeWidthNm, thresholdNm].every(Number.isSafeInteger)) throw new Error("Invalid exact copper-gap comparison input.");
  const twiceThreshold = 2n * BigInt(thresholdNm) + BigInt(positiveWidthNm) + BigInt(negativeWidthNm);
  if (twiceThreshold < 0n) return 1;
  return sign(4n * n - twiceThreshold * twiceThreshold * d);
}
/** Exact cross-section capsule inventory; callers must retain all selected nets. */
export function assessDifferentialTrackGaps(positive: readonly DifferentialPairTrack[], negative: readonly DifferentialPairTrack[], minimumGapNm: number): DifferentialPairGapObservation[] {
  if (positive.length + negative.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSelectedTracks) throw new Error("CHANNEL_TRACK_WORK_BOUND");
  if (!Number.isSafeInteger(minimumGapNm) || minimumGapNm < 0) throw new Error("CHANNEL_GAP_LIMIT_UNSUPPORTED");
  return positive.flatMap(p => negative.map(n => {
    const distance = p.layer === n.layer ? serializedFraction(segmentSquaredDistance(p, n)) : null;
    return { positiveUuid: p.uuid, negativeUuid: n.uuid, layerRelationship: distance ? "same_layer" as const : "different_layer_not_assessed" as const,
      centerlineSquaredNm2: distance, radiusSumTwiceNm: String(BigInt(p.widthNm) + BigInt(n.widthNm)),
      minimumGap: distance ? compareDifferentialPairCopperGap(distance, p.widthNm, n.widthNm, minimumGapNm) >= 0 ? "pass" as const : "fail" as const : "not_assessed" as const };
  }));
}
class WorkBound extends Error { }
const bounded = (condition: boolean, reason: string) => { if (!condition) throw new WorkBound(reason); };
function emptyRoute(net: string, reason: string): DifferentialPairRoute {
  return { net, status: "not_assessed", reasons: [reason], contacts: null, nodes: null, edges: null, mainChain: null, runs: null, stubs: null, mainLength: null, totalEtchLength: null };
}
function mergeRuns(chain: readonly DifferentialPairGraphEdge[]): DifferentialPairRun[] {
  const runs: DifferentialPairRun[] = [];
  for (const edge of chain) {
    const u = direction(edge.start, edge.end)!, previous = runs.at(-1);
    const member: DifferentialPairMemberInterval = { uuid: edge.uuid, start: edge.start, end: edge.end, widthNm: edge.widthNm, ...(edge.sourceIdentity ? { sourceIdentity: edge.sourceIdentity } : {}) };
    // Width changes retain a separate run so the capsule radius remains exact.
    if (previous && previous.layer === edge.layer && previous.widthNm === edge.widthNm && directionEqual(previous.direction, u)) {
      runs[runs.length - 1] = { ...previous, end: edge.end, members: [...previous.members, member], length: add(previous.length, edge.length) };
    } else runs.push({ index: runs.length, layer: edge.layer, widthNm: edge.widthNm, start: edge.start, end: edge.end, direction: u, members: [member], length: edge.length });
  }
  return runs;
}
function buildRoute(net: string, tracks: readonly DifferentialPairTrack[], pads: readonly DifferentialPairPad[], vias: readonly DifferentialPairVia[], source: DifferentialPairPad | undefined, receiver: DifferentialPairPad | undefined): DifferentialPairRoute {
  const reasons: string[] = [], contacts: NonNullable<DifferentialPairRoute["contacts"]>[number][] = [];
  const cuts = tracks.map(track => new Map<string, Point>([[pointKey(track.start), track.start], [pointKey(track.end), track.end]]));
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
    const a = tracks[i]!, b = tracks[j]!;
    if (a.layer !== b.layer) continue;
    const kind = intersectionKind(a, b);
    if (kind) contacts.push({ kind, firstUuid: a.uuid, secondUuid: b.uuid });
    if (kind === "proper_crossing" || kind === "positive_overlap") reasons.push(kind === "proper_crossing" ? "PROPER_CROSSING" : "POSITIVE_OVERLAP");
    for (const p of [a.start, a.end]) if (on(p, b.start, b.end)) cuts[j]!.set(pointKey(p), p);
    for (const p of [b.start, b.end]) if (on(p, a.start, a.end)) cuts[i]!.set(pointKey(p), p);
  }
  tracks.forEach((track, index) => {
    for (const pad of pads) if (pad.layers.includes(track.layer) && on(pad.center, track.start, track.end)) cuts[index]!.set(pointKey(pad.center), pad.center);
    for (const via of vias) if (via.layers.includes(track.layer) && on(via.center, track.start, track.end)) cuts[index]!.set(pointKey(via.center), via.center);
  });
  const nodes = new Map<string, { id: string; layer: string; point: Point; padUuids: string[]; viaUuids: string[] }>();
  const edges: DifferentialPairGraphEdge[] = [], adjacent = new Map<string, DifferentialPairGraphEdge[]>();
  const addNode = (p: Point, layer: string) => {
    const id = nodeKey(p, layer);
    if (!nodes.has(id)) {
      nodes.set(id, { id, layer, point: p, padUuids: pads.filter(pad => pad.layers.includes(layer) && samePoint(pad.center, p)).map(pad => pad.uuid),
        viaUuids: vias.filter(via => via.layers.includes(layer) && samePoint(via.center, p)).map(via => via.uuid) }); adjacent.set(id, []);
    }
    return id;
  };
  tracks.forEach((track, i) => {
    const u = direction(track.start, track.end)!;
    const ordered = [...cuts[i]!.values()].sort((a, b) => sign(dot(a, u) - dot(b, u)));
    for (let j = 1; j < ordered.length; j++) {
      const start = ordered[j - 1]!, end = ordered[j]!, startNode = addNode(start, track.layer), endNode = addNode(end, track.layer);
      const edge: DifferentialPairGraphEdge = { id: `${track.uuid}:${j - 1}`, uuid: track.uuid, layer: track.layer, widthNm: track.widthNm,
        start, end, startNode, endNode, length: segmentLength(start, end), ...(track.sourceIdentity ? { sourceIdentity: track.sourceIdentity } : {}) };
      edges.push(edge); adjacent.get(startNode)!.push(edge); adjacent.get(endNode)!.push(edge);
      bounded(edges.length <= DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumGraphEdges, "GRAPH_WORK_BOUND_EXCEEDED");
    }
  });
  const sourceNodes = source ? [...nodes.values()].filter(node => node.padUuids.includes(source.uuid)) : [];
  const receiverNodes = receiver ? [...nodes.values()].filter(node => node.padUuids.includes(receiver.uuid)) : [];
  if (sourceNodes.length !== 1 || receiverNodes.length !== 1) reasons.push("SOURCE_RECEIVER_ANCHOR_MISSING_OR_AMBIGUOUS");
  if (!tracks.length) reasons.push("NO_SELECTED_TRACKS");
  if (vias.length) reasons.push("VIA_TRANSITION_NOT_SUPPORTED");
  const startNode = sourceNodes[0]?.id, endNode = receiverNodes[0]?.id;
  if (startNode !== undefined && startNode === endNode) reasons.push("COINCIDENT_SOURCE_RECEIVER_ANCHORS");
  const parent = new Map<string, { previous: string; edge: DifferentialPairGraphEdge }>();
  const reached = new Set<string>();
  if (startNode !== undefined) {
    const pending = [startNode]; reached.add(startNode);
    while (pending.length) {
      const node = pending.pop()!;
      for (const edge of adjacent.get(node)!) {
        const next = edge.startNode === node ? edge.endNode : edge.startNode;
        if (!reached.has(next)) { reached.add(next); parent.set(next, { previous: node, edge }); pending.push(next); }
      }
    }
    if (reached.size !== nodes.size) reasons.push("DISCONNECTED_SELECTED_COPPER");
    if (edges.length !== nodes.size - 1) reasons.push("CYCLE_OR_DISCONNECTED_GRAPH");
    if (endNode !== undefined && !reached.has(endNode)) reasons.push("RECEIVER_NOT_REACHED");
  }
  const totalEtchLength = sumLengths(edges);
  const base = { net, contacts, nodes: [...nodes.values()], edges, totalEtchLength };
  if (reasons.length) return { ...base, status: "incomplete", reasons: [...new Set(reasons)], mainChain: null, runs: null, stubs: null, mainLength: null };
  const reversed: DifferentialPairGraphEdge[] = [];
  let cursor = endNode!;
  while (cursor !== startNode) {
    const entry = parent.get(cursor)!;
    const edge = entry.edge.startNode === entry.previous ? entry.edge : { ...entry.edge, start: entry.edge.end, end: entry.edge.start, startNode: entry.edge.endNode, endNode: entry.edge.startNode };
    reversed.push(edge); cursor = entry.previous;
  }
  const mainChain = reversed.reverse(), mainIds = new Set(mainChain.map(edge => edge.id));
  const chainNodes = new Set([startNode!, ...mainChain.map(edge => edge.endNode)]), consumed = new Set(mainIds), stubs: DifferentialPairStub[] = [];
  for (const attachmentNode of chainNodes) for (const first of adjacent.get(attachmentNode)!) {
    if (consumed.has(first.id)) continue;
    const stubEdges: DifferentialPairGraphEdge[] = [], leafNodes: string[] = [];
    let maximumAttachmentToLeafLength = zero();
    const pending = [{ node: attachmentNode, edge: first, length: zero() }];
    while (pending.length) {
      const entry = pending.pop()!;
      if (consumed.has(entry.edge.id)) continue;
      consumed.add(entry.edge.id);
      const oriented = entry.edge.startNode === entry.node ? entry.edge : { ...entry.edge, start: entry.edge.end, end: entry.edge.start, startNode: entry.edge.endNode, endNode: entry.edge.startNode };
      stubEdges.push(oriented);
      const length = add(entry.length, oriented.length), next = oriented.endNode;
      const onward = adjacent.get(next)!.filter(edge => !consumed.has(edge.id));
      if (!onward.length) { leafNodes.push(next); if (compareDifferentialPairLengths(length, maximumAttachmentToLeafLength) > 0) maximumAttachmentToLeafLength = length; }
      for (const edge of onward) pending.push({ node: next, edge, length });
    }
    stubs.push({ attachmentNode, edges: stubEdges, length: sumLengths(stubEdges), leafNodes, maximumAttachmentToLeafLength });
  }
  return { ...base, status: "complete_source_tree", reasons: [], mainChain, runs: mergeRuns(mainChain), stubs, mainLength: sumLengths(mainChain) };
}

interface Candidate { p: DifferentialPairRun; n: DifferentialPairRun; lo: bigint; hi: bigint; distance: Fraction; withinGap: boolean }
interface CoverageAtom { run: DifferentialPairRun; lo: bigint; hi: bigint; candidates: Candidate[]; far: boolean; status: "paired" | "unpaired" | "ambiguous"; reasons: string[] }
function clippedPoint(run: DifferentialPairRun, projection: bigint): DifferentialPairPointTwiceNm {
  const u = run.direction, displacementTwice = 2n * (projection - dot(run.start, u)) / norm(u);
  return { xTwiceNm: String(2n * BigInt(run.start.xNm) + BigInt(u.x) * displacementTwice), yTwiceNm: String(2n * BigInt(run.start.yNm) + BigInt(u.y) * displacementTwice) };
}
function memberUuids(run: DifferentialPairRun, lo: bigint, hi: bigint): string[] {
  return [...new Set(run.members.filter(member => dot(member.start, run.direction) < hi && dot(member.end, run.direction) > lo).map(member => member.uuid))];
}
function assessCoupling(positive: readonly DifferentialPairRun[], negative: readonly DifferentialPairRun[], maximumGapNm: number): DifferentialPairCouplingAssessment {
  const candidates: Candidate[] = [];
  for (const p of positive) for (const n of negative) {
    if (p.layer !== n.layer || !directionEqual(p.direction, n.direction)) continue;
    const u = p.direction, lo = dot(p.start, u) > dot(n.start, u) ? dot(p.start, u) : dot(n.start, u), hi = dot(p.end, u) < dot(n.end, u) ? dot(p.end, u) : dot(n.end, u);
    if (lo >= hi) continue;
    const k = BigInt(n.start.xNm - p.start.xNm) * BigInt(u.y) - BigInt(n.start.yNm - p.start.yNm) * BigInt(u.x);
    const distance = fraction(k * k, norm(u));
    candidates.push({ p, n, lo, hi, distance, withinGap: compareDifferentialPairCopperGap(serializedFraction(distance), p.widthNm, n.widthNm, maximumGapNm) <= 0 });
  }
  // Shared projection boundaries prevent ambiguity on half of one run from
  // spreading into the uniquely matched other half of its mate. Directions
  // and layers have distinct projection spaces; every interval is exact.
  const projectionKey = (run: DifferentialPairRun) => JSON.stringify([run.layer, run.direction.x, run.direction.y]);
  const projectionCuts = new Map<string, Set<bigint>>();
  for (const candidate of candidates) {
    const key = projectionKey(candidate.p), cuts = projectionCuts.get(key) ?? new Set<bigint>();
    cuts.add(candidate.lo); cuts.add(candidate.hi); projectionCuts.set(key, cuts);
  }
  let atomCount = 0;
  const atoms = (runs: readonly DifferentialPairRun[], side: "p" | "n") => runs.flatMap(run => {
    const matching = candidates.filter(candidate => candidate[side] === run), start = dot(run.start, run.direction), end = dot(run.end, run.direction);
    const cuts = new Set<bigint>([start, end]);
    for (const cut of projectionCuts.get(projectionKey(run)) ?? []) if (cut > start && cut < end) cuts.add(cut);
    const ordered = [...cuts].sort((a, b) => sign(a - b));
    const result: CoverageAtom[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const lo = ordered[i - 1]!, hi = ordered[i]!, covering = matching.filter(candidate => candidate.lo <= lo && candidate.hi >= hi);
      const eligible = covering.filter(candidate => candidate.withinGap);
      result.push({ run, lo, hi, candidates: eligible, far: covering.some(candidate => !candidate.withinGap),
        status: eligible.length === 1 ? "paired" : eligible.length ? "ambiguous" : "unpaired", reasons: [] });
      bounded(++atomCount <= DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumCouplingIntervals, "COUPLING_WORK_BOUND_EXCEEDED");
    }
    return result;
  });
  const pAtoms = atoms(positive, "p"), nAtoms = atoms(negative, "n");
  const atomKey = (run: DifferentialPairRun, lo: bigint, hi: bigint) => `${run.index}:${lo}:${hi}`;
  const pAtomMap = new Map(pAtoms.map(atom => [atomKey(atom.run, atom.lo, atom.hi), atom]));
  const nAtomMap = new Map(nAtoms.map(atom => [atomKey(atom.run, atom.lo, atom.hi), atom]));
  // A coupling span exists only when both endpoint degrees of the bipartite
  // correspondence graph are one. No iterative, whole-run contamination.
  for (const [own, other, otherSide] of [[pAtoms, nAtomMap, "n"], [nAtoms, pAtomMap, "p"]] as const) for (const atom of own) {
    if (atom.status !== "paired") continue;
    const candidate = atom.candidates[0]!, mate = other.get(atomKey(candidate[otherSide], atom.lo, atom.hi));
    if (!mate || mate.candidates.length !== 1) {
      atom.status = "ambiguous"; atom.reasons.push("NON_UNIQUE_MATE_COVERAGE");
    }
  }
  // Correspondence must preserve both source-to-receiver orders. Pairwise
  // crossings in the order relation are ambiguous; no nearest-mate heuristic.
  const eligible = pAtoms.filter(atom => atom.status === "paired");
  const orderConflicts = new Set<CoverageAtom>();
  let greatestMateIndex = -1, greatestMateEnd = 0n;
  for (const atom of eligible) {
    const mateIndex = atom.candidates[0]!.n.index;
    if (mateIndex < greatestMateIndex || mateIndex === greatestMateIndex && atom.lo < greatestMateEnd) orderConflicts.add(atom);
    if (mateIndex > greatestMateIndex) { greatestMateIndex = mateIndex; greatestMateEnd = atom.hi; }
    else if (mateIndex === greatestMateIndex && atom.hi > greatestMateEnd) greatestMateEnd = atom.hi;
  }
  // Mark both sides of an inversion, not just the later interval.
  let leastMateIndex = Number.POSITIVE_INFINITY, leastMateStart = 0n;
  for (const atom of [...eligible].reverse()) {
    const mateIndex = atom.candidates[0]!.n.index;
    if (mateIndex > leastMateIndex || mateIndex === leastMateIndex && atom.hi > leastMateStart) orderConflicts.add(atom);
    if (mateIndex < leastMateIndex) { leastMateIndex = mateIndex; leastMateStart = atom.lo; }
    else if (mateIndex === leastMateIndex && atom.lo < leastMateStart) leastMateStart = atom.lo;
  }
  for (const atom of orderConflicts) {
    atom.status = "ambiguous"; atom.reasons.push("NON_MONOTONE_CORRESPONDENCE");
    const candidate = atom.candidates[0]!;
    const mate = nAtomMap.get(atomKey(candidate.n, atom.lo, atom.hi))!;
    mate.status = "ambiguous"; mate.reasons.push("NON_MONOTONE_CORRESPONDENCE");
  }
  const serializeAtom = (atom: CoverageAtom, mateSide: "p" | "n"): DifferentialPairRouteCoverageInterval => ({ runIndex: atom.run.index,
    start: clippedPoint(atom.run, atom.lo), end: clippedPoint(atom.run, atom.hi), memberUuids: memberUuids(atom.run, atom.lo, atom.hi),
    length: projectionLength(atom.lo, atom.hi, atom.run.direction), status: atom.status,
    candidateMateRunIndices: atom.candidates.map(candidate => candidate[mateSide].index),
    reasons: [...new Set([...atom.reasons, ...(atom.status === "ambiguous" ? ["AMBIGUOUS_CORRESPONDENCE"] : atom.status === "unpaired" ? [atom.far ? "PARALLEL_GAP_EXCEEDS_COUPLING_MAXIMUM" : "NO_FORWARD_PARALLEL_MATE"] : [])])] });
  const positiveCoverage = pAtoms.map(atom => serializeAtom(atom, "n")), negativeCoverage = nAtoms.map(atom => serializeAtom(atom, "p"));
  const paired = pAtoms.filter(atom => atom.status === "paired").map(atom => {
    const candidate = atom.candidates[0]!;
    return { positiveRunIndex: atom.run.index, negativeRunIndex: candidate.n.index,
      positiveStart: clippedPoint(atom.run, atom.lo), positiveEnd: clippedPoint(atom.run, atom.hi), negativeStart: clippedPoint(candidate.n, atom.lo), negativeEnd: clippedPoint(candidate.n, atom.hi),
      positiveMemberUuids: memberUuids(atom.run, atom.lo, atom.hi), negativeMemberUuids: memberUuids(candidate.n, atom.lo, atom.hi),
      length: projectionLength(atom.lo, atom.hi, atom.run.direction), centerlineSquaredNm2: serializedFraction(candidate.distance), radiusSumTwiceNm: String(BigInt(atom.run.widthNm) + BigInt(candidate.n.widthNm)) };
  });
  const ambiguous = [...pAtoms, ...nAtoms].some(atom => atom.status === "ambiguous");
  return { status: ambiguous ? "ambiguous" : "complete", paired, positiveCoverage, negativeCoverage,
    positiveUncoupledLength: sumLengths(positiveCoverage.filter(atom => atom.status !== "paired")), negativeUncoupledLength: sumLengths(negativeCoverage.filter(atom => atom.status !== "paired")),
    reasons: ambiguous ? ["NON_UNIQUE_OR_NON_MONOTONE_CORRESPONDENCE"] : [] };
}

function validateInput(input: DifferentialPairGeometryInput, selected: DifferentialPairGeometryAssessment["selected"]): string[] {
  const diagnostics: string[] = [];
  const validName = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 1024;
  const validPoint = (p: Point) => [p.xNm, p.yNm].every(value => Number.isSafeInteger(value) && Math.abs(value) <= DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumCoordinateNm);
  const validDimension = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumCoordinateNm;
  if (!validName(input.positiveNet) || !validName(input.negativeNet) || input.positiveNet === input.negativeNet) diagnostics.push("DISTINCT_MEMBER_NETS_REQUIRED");
  if (!["preserved", "swapped"].includes(input.receiverMapping)) diagnostics.push("EXPLICIT_RECEIVER_MAPPING_REQUIRED");
  if (input.tracks.length + input.pads.length + input.vias.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSourcePrimitives) diagnostics.push("SOURCE_INVENTORY_WORK_BOUND_EXCEEDED");
  if (selected.tracks.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSelectedTracks || selected.pads.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSelectedPads || selected.vias.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSelectedVias) diagnostics.push("SELECTED_INVENTORY_WORK_BOUND_EXCEEDED");
  const ids = [...selected.tracks, ...selected.pads, ...selected.vias].map(item => item.uuid);
  if (ids.some(id => !validName(id)) || new Set(ids).size !== ids.length) diagnostics.push("PRIMITIVE_UUID_MISSING_OR_DUPLICATED");
  if (selected.tracks.some(track => !validPoint(track.start) || !validPoint(track.end) || !validDimension(track.widthNm) || !validName(track.layer))) diagnostics.push("INVALID_TRACK_GEOMETRY");
  if (selected.pads.some(pad => !validPoint(pad.center) || !validName(pad.reference) || !validName(pad.pad) || !pad.layers.length || pad.layers.some(layer => !validName(layer)) || new Set(pad.layers).size !== pad.layers.length)) diagnostics.push("INVALID_PAD_ANCHOR");
  if (selected.vias.some(via => !validPoint(via.center) || !validDimension(via.diameterNm) || !validDimension(via.drillNm) || via.drillNm >= via.diameterNm || via.layers.length < 2 || via.layers.some(layer => !validName(layer)) || new Set(via.layers).size !== via.layers.length)) diagnostics.push("INVALID_VIA_GEOMETRY");
  const limits = input.limits;
  const values = [limits.minimumWidthNm, limits.maximumWidthNm, limits.minimumGapNm, limits.maximumCoupledGapNm, limits.maximumMainLengthNm, limits.maximumSkewNm, limits.maximumStubLengthNm, limits.maximumUncoupledLengthNm];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000_000) || limits.minimumWidthNm === 0 || limits.maximumWidthNm < limits.minimumWidthNm
    || limits.maximumCoupledGapNm < limits.minimumGapNm || limits.transitions !== "forbidden" || limits.allowedLayers?.some(layer => !validName(layer)) || limits.allowedLayers?.length === 0) diagnostics.push("INVALID_GEOMETRIC_LIMITS");
  const selectors = [input.source.positive, input.source.negative, input.receiver.positive, input.receiver.negative, ...(input.terminationAnchors ?? [])];
  if (selectors.length > DIFFERENTIAL_PAIR_GEOMETRY_BOUNDS.maximumSelectedPads || selectors.some(selector => !validName(selector.reference) || !validName(selector.pad))) diagnostics.push("INVALID_OR_EXCESSIVE_TERMINAL_SELECTORS");
  if (new Set(selectors.slice(0, 4).map(selector => `${selector.reference}\u0000${selector.pad}`)).size !== 4) diagnostics.push("DISTINCT_SOURCE_RECEIVER_ROLES_REQUIRED");
  return diagnostics;
}
/** Assess complete selected-net source inventories. Failed geometry remains in
 * selected; unavailable derived inventories are null, never truncated passes.
 * Pad centres are source anchors only: no inferred pad-shape contacts, internal
 * pin ties, library membership, native connectivity or electrical permission. */
export function assessDifferentialPairGeometry(input: DifferentialPairGeometryInput): DifferentialPairGeometryAssessment {
  const selectedNet = (net: string) => net === input.positiveNet || net === input.negativeNet;
  const selected = structuredClone({ tracks: input.tracks.filter(track => selectedNet(track.net)), pads: input.pads.filter(pad => selectedNet(pad.net)), vias: input.vias.filter(via => selectedNet(via.net)) });
  const diagnostics = validateInput(input, selected), limits = input.limits;
  const roles = ([
    ["source.positive", input.source.positive, input.positiveNet], ["source.negative", input.source.negative, input.negativeNet],
    ["receiver.positive", input.receiver.positive, input.receiverMapping === "preserved" ? input.positiveNet : input.negativeNet],
    ["receiver.negative", input.receiver.negative, input.receiverMapping === "preserved" ? input.negativeNet : input.positiveNet],
  ] as const).map(([role, selector, expectedNet]) => {
    // Resolve against every supplied physical pad, including other nets. Do not
    // silently choose one physical member of a split logical pad number.
    const matches = input.pads.filter(pad => pad.reference === selector.reference && pad.pad === selector.pad);
    return { role, selector: structuredClone(selector), expectedNet, matchingPadUuids: matches.map(pad => pad.uuid), status: matches.length === 1 && matches[0]!.net === expectedNet ? "pass" as const : "fail" as const };
  });
  const rolePad = (role: string) => { const row = roles.find(row => row.role === role)!; return row.status === "pass" ? selected.pads.find(pad => pad.uuid === row.matchingPadUuids[0]) : undefined; };
  let positive = emptyRoute(input.positiveNet, "GEOMETRY_NOT_ASSESSED"), negative = emptyRoute(input.negativeNet, "GEOMETRY_NOT_ASSESSED");
  let allTrackPairGaps: DifferentialPairGapObservation[] | null = null, coupling: DifferentialPairCouplingAssessment | null = null, etchSkew: Length | null = null;
  const checks: Record<keyof DifferentialPairGeometryAssessment["checks"], DifferentialPairGeometryCheck> = {
    sourcePolarity: check(roles.every(row => row.status === "pass") ? "pass" : "fail", "DECLARED_SOURCE_PAD_NET_MAPPING_ONLY"), topology: check("not_assessed"), width: check("not_assessed"), minimumGap: check("not_assessed"),
    coupledGap: check("not_assessed"), length: check("not_assessed"), skew: check("not_assessed"), stubs: check("not_assessed"), uncoupled: check("not_assessed"), transitions: check("not_assessed"),
  };
  const pTracks = selected.tracks.filter(track => track.net === input.positiveNet), nTracks = selected.tracks.filter(track => track.net === input.negativeNet);
  if (!diagnostics.length) {
    checks.width = check(selected.tracks.length ? selected.tracks.every(track => track.widthNm >= limits.minimumWidthNm && track.widthNm <= limits.maximumWidthNm) ? "pass" : "fail" : "not_assessed", "ALL_SELECTED_TRACK_WIDTHS");
    const layers = new Set(selected.tracks.map(track => track.layer));
    checks.transitions = check(selected.vias.length || layers.size > 1 || selected.tracks.some(track => limits.allowedLayers && !limits.allowedLayers.includes(track.layer)) ? "fail" : selected.tracks.length ? "pass" : "not_assessed", "VIAS_AND_MEMBER_SIGNAL_LAYERS_RETAINED_NO_VERTICAL_LENGTH_OR_UNUSED_BARREL_MODEL");
    allTrackPairGaps = pTracks.flatMap(p => nTracks.map(n => {
      const sameLayer = p.layer === n.layer, distance = sameLayer ? serializedFraction(segmentSquaredDistance(p, n)) : null;
      return { positiveUuid: p.uuid, negativeUuid: n.uuid, layerRelationship: sameLayer ? "same_layer" as const : "different_layer_not_assessed" as const,
        centerlineSquaredNm2: distance, radiusSumTwiceNm: String(BigInt(p.widthNm) + BigInt(n.widthNm)),
        minimumGap: distance ? compareDifferentialPairCopperGap(distance, p.widthNm, n.widthNm, limits.minimumGapNm) >= 0 ? "pass" as const : "fail" as const : "not_assessed" as const };
    }));
    checks.minimumGap = check(allTrackPairGaps.some(gap => gap.minimumGap === "fail") ? "fail" : !allTrackPairGaps.length || allTrackPairGaps.some(gap => gap.minimumGap === "not_assessed") ? "not_assessed" : "pass", "ALL_P_N_TRACK_CAPSULES_INCLUDING_BENDS_ENDCAPS_AND_STUBS");
    const unsupported = selected.tracks.filter(track => direction(track.start, track.end) === null);
    if (unsupported.length) {
      diagnostics.push(...unsupported.map(track => `${samePoint(track.start, track.end) ? "ZERO_LENGTH_TRACK" : "UNSUPPORTED_NON_OCTILINEAR_TRACK"}:${track.uuid}`));
      positive = emptyRoute(input.positiveNet, "UNSUPPORTED_SELECTED_DIRECTION_OR_ZERO_LENGTH"); negative = emptyRoute(input.negativeNet, "UNSUPPORTED_SELECTED_DIRECTION_OR_ZERO_LENGTH");
    } else {
      for (const [side, net, tracks, source, receiver] of [
        ["positive", input.positiveNet, pTracks, rolePad("source.positive"), rolePad(input.receiverMapping === "preserved" ? "receiver.positive" : "receiver.negative")],
        ["negative", input.negativeNet, nTracks, rolePad("source.negative"), rolePad(input.receiverMapping === "preserved" ? "receiver.negative" : "receiver.positive")],
      ] as const) {
        let route: DifferentialPairRoute;
        try { route = buildRoute(net, tracks, selected.pads.filter(pad => pad.net === net), selected.vias.filter(via => via.net === net), source, receiver); }
        catch (error) { if (!(error instanceof WorkBound)) throw error; route = emptyRoute(net, error.message); diagnostics.push(error.message); }
        if (side === "positive") positive = route; else negative = route;
      }
      const complete = positive.status === "complete_source_tree" && negative.status === "complete_source_tree";
      checks.topology = check(complete ? "pass" : positive.status === "incomplete" || negative.status === "incomplete" ? "fail" : "not_assessed", ...new Set([...positive.reasons, ...negative.reasons]));
      if (complete) {
        etchSkew = absoluteLength(subtract(positive.mainLength!, negative.mainLength!));
        checks.length = check([positive, negative].every(route => compareDifferentialPairLengths(route.mainLength!, limitLength(limits.maximumMainLengthNm)) <= 0) ? "pass" : "fail", "SOURCE_TO_RECEIVER_MAIN_CHAIN_ETCH_LENGTH");
        checks.skew = check(compareDifferentialPairLengths(etchSkew, limitLength(limits.maximumSkewNm)) <= 0 ? "pass" : "fail", "EXACT_ABSOLUTE_MAIN_CHAIN_ETCH_SKEW_NOT_DELAY");
        checks.stubs = check([...positive.stubs!, ...negative.stubs!].every(stub => compareDifferentialPairLengths(stub.maximumAttachmentToLeafLength, limitLength(limits.maximumStubLengthNm)) <= 0) ? "pass" : "fail", "EVERY_ACYCLIC_TAP_ATTACHMENT_TO_LEAF_LENGTH_INCLUDING_TERMINATION_TAPS");
        try {
          coupling = assessCoupling(positive.runs!, negative.runs!, limits.maximumCoupledGapNm);
          checks.coupledGap = check(coupling.status === "ambiguous" ? "not_assessed" : coupling.paired.length ? "pass" : "not_assessed", "MAXIMUM_GAP_APPLIES_ONLY_TO_UNIQUE_FORWARD_PARALLEL_COUPLED_INTERVALS");
          checks.uncoupled = check(coupling.status === "ambiguous" ? "fail" : [coupling.positiveUncoupledLength, coupling.negativeUncoupledLength].every(length => compareDifferentialPairLengths(length, limitLength(limits.maximumUncoupledLengthNm)) <= 0) ? "pass" : "fail", ...coupling.reasons);
        } catch (error) { if (!(error instanceof WorkBound)) throw error; diagnostics.push(error.message); }
      }
    }
  }
  const terminationAnchors = (input.terminationAnchors ?? []).map(selector => {
    const matches = input.pads.filter(pad => pad.reference === selector.reference && pad.pad === selector.pad);
    const contactNodeIds = [...positive.nodes ?? [], ...negative.nodes ?? []].filter(node => node.padUuids.some(uuid => matches.some(pad => pad.uuid === uuid))).map(node => node.id);
    return { selector: structuredClone(selector), matchingPadUuids: matches.map(pad => pad.uuid), contactNodeIds,
      status: matches.length !== 1 || !selectedNet(matches[0]!.net) ? "fail" as const : positive.nodes === null || negative.nodes === null ? "not_assessed" as const : contactNodeIds.length === 1 ? "pass" as const : "fail" as const };
  });
  return { schemaVersion: "evleda.differential-pair-geometry.v1", selected, inventoryComplete: !diagnostics.some(reason => reason.includes("WORK_BOUND")), diagnostics,
    sourceRoles: roles, terminationAnchors, routes: { positive, negative }, allTrackPairGaps, coupling, etchSkew,
    viaObservations: selected.vias.map(via => ({ uuid: via.uuid, layers: via.layers, transition: "forbidden_present", unusedBarrel: "not_assessed", verticalLength: "not_assessed" })),
    checks, authority: "caller_supplied_source_geometry_only", notEvaluated: ["native_connectivity", "pad_shape_or_drill_clipped_contacts", "library_terminal_authority", "datasheet_polarity_permission", "via_vertical_length_and_unused_barrel", "electrical_delay", "electromagnetic_coupling", "impedance", "native_drc", "manufacturing"], accepted: false };
}
