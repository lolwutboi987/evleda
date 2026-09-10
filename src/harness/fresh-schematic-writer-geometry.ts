import type { FreshPoint, FreshSchematicWire } from "./fresh-kicad-parser.js";
import { FreshSchematicWorkBudget, withFreshSchematicWorkBudget } from "./fresh-schematic-work-budget.js";

export interface FreshSchematicWriterGeometry {
  readonly wires: readonly FreshSchematicWire[];
  readonly junctions: readonly FreshPoint[];
}

/**
 * Expected geometry for the pinned kicad-mcp-pro 3.33.3 writer, not a general
 * schematic equivalence test. tools/schematic.py formats coordinates with
 * Python round(value, 4), deduplicates reversed endpoints, unions touching
 * collinear runs (SNAP_TOLERANCE_MM = 1e-6), then inserts endpoint/interior T
 * junctions. Every transactional write repeats this process. Existing
 * junctions are retained, including ones inserted by earlier wire prefixes.
 * Re-audit this model and its captured Python oracle when the writer changes.
 */
const WRITER_TOLERANCE_MM = 1e-6;

// Round the exact IEEE-754 value, including ties-to-even, just like Python's
// round(value, 4). Math.round(value * 10000) and toFixed(4) disagree at ties.
function writerCoordinate(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Expected schematic geometry contains a non-finite coordinate.");
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value));
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent === 0 ? 0n : 1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  const numerator = significand * 10_000n;
  let rounded: bigint;
  if (power >= 0) rounded = numerator << BigInt(power);
  else {
    const denominator = 1n << BigInt(-power);
    rounded = numerator / denominator;
    const doubledRemainder = (numerator % denominator) * 2n;
    if (doubledRemainder > denominator || (doubledRemainder === denominator && rounded % 2n !== 0n)) rounded += 1n;
  }
  return Number(`${value < 0 && rounded !== 0n ? "-" : ""}${rounded}e-4`);
}

const pointOrder = (left: FreshPoint, right: FreshPoint): number => left.x - right.x || left.y - right.y;
const pointKey = (point: FreshPoint): string => JSON.stringify([point.x, point.y]);
const wireKey = (wire: FreshSchematicWire): string => JSON.stringify(
  (pointOrder(wire.start, wire.end) <= 0 ? [wire.start, wire.end] : [wire.end, wire.start]).map((point) => [point.x, point.y]),
);
const roundedPoint = (point: FreshPoint): FreshPoint => ({ x: writerCoordinate(point.x), y: writerCoordinate(point.y) });

function mergedWires(wires: readonly FreshSchematicWire[]): readonly FreshSchematicWire[] {
  const unique = new Map<string, FreshSchematicWire>();
  for (const wire of wires) {
    if (Math.abs(wire.start.x - wire.end.x) <= WRITER_TOLERANCE_MM
      && Math.abs(wire.start.y - wire.end.y) <= WRITER_TOLERANCE_MM) continue;
    const start = roundedPoint(wire.start);
    const end = roundedPoint(wire.end);
    const canonical = pointOrder(start, end) <= 0 ? { start, end } : { start: end, end: start };
    if (!unique.has(wireKey(canonical))) unique.set(wireKey(canonical), canonical);
  }
  const horizontal = new Map<number, [number, number][]>();
  const vertical = new Map<number, [number, number][]>();
  const diagonal: FreshSchematicWire[] = [];
  for (const wire of unique.values()) {
    const { start, end } = wire;
    const isHorizontal = Math.abs(start.y - end.y) <= WRITER_TOLERANCE_MM;
    const isVertical = Math.abs(start.x - end.x) <= WRITER_TOLERANCE_MM;
    if (!isHorizontal && !isVertical) { diagonal.push(wire); continue; }
    const groups = isHorizontal ? horizontal : vertical;
    const axis = isHorizontal ? start.y : start.x;
    const first = isHorizontal ? start.x : start.y;
    const last = isHorizontal ? end.x : end.y;
    const intervals = groups.get(axis) ?? [];
    intervals.push([Math.min(first, last), Math.max(first, last)]);
    groups.set(axis, intervals);
  }
  const result: FreshSchematicWire[] = [];
  for (const [groups, isHorizontal] of [[horizontal, true], [vertical, false]] as const) {
    for (const [axis, intervals] of [...groups].sort(([left], [right]) => left - right)) {
      const merged: [number, number][] = [];
      for (const [start, end] of intervals.sort(([a, b], [c, d]) => a - c || b - d)) {
        const previous = merged.at(-1);
        if (previous !== undefined && start <= previous[1] + WRITER_TOLERANCE_MM) previous[1] = Math.max(previous[1], end);
        else merged.push([start, end]);
      }
      for (const [start, end] of merged) result.push(isHorizontal
        ? { start: { x: start, y: axis }, end: { x: end, y: axis } }
        : { start: { x: axis, y: start }, end: { x: axis, y: end } });
    }
  }
  result.push(...diagonal);
  // The pinned normalizer returns the original content when no nonzero wire
  // survives. Validated host plans do not contain these zero-length segments.
  return result.length === 0 ? wires : result;
}

function isInterior(point: FreshPoint, wire: FreshSchematicWire): boolean {
  if (pointKey(point) === pointKey(wire.start) || pointKey(point) === pointKey(wire.end)) return false;
  if (Math.abs(wire.start.x - wire.end.x) <= WRITER_TOLERANCE_MM) return Math.abs(point.x - wire.start.x) <= WRITER_TOLERANCE_MM
    && Math.min(wire.start.y, wire.end.y) + WRITER_TOLERANCE_MM < point.y
    && point.y < Math.max(wire.start.y, wire.end.y) - WRITER_TOLERANCE_MM;
  if (Math.abs(wire.start.y - wire.end.y) <= WRITER_TOLERANCE_MM) return Math.abs(point.y - wire.start.y) <= WRITER_TOLERANCE_MM
    && Math.min(wire.start.x, wire.end.x) + WRITER_TOLERANCE_MM < point.x
    && point.x < Math.max(wire.start.x, wire.end.x) - WRITER_TOLERANCE_MM;
  return false;
}

/** Derive only from the validated request sequence, never persisted readback. */
export function expectedFreshSchematicGeometryPrefixes(wires: readonly FreshSchematicWire[]): readonly FreshSchematicWriterGeometry[] {
  const prefixes: FreshSchematicWriterGeometry[] = [{ wires: [], junctions: [] }];
  for (const wire of wires) {
    const previous = prefixes.at(-1)!;
    // wire_block formats the new request before the normalizer reads it.
    const normalized = mergedWires([...previous.wires, { start: roundedPoint(wire.start), end: roundedPoint(wire.end) }]);
    const junctions = new Map(previous.junctions.map((point) => [pointKey(point), point]));
    for (const [index, segment] of normalized.entries()) for (const point of [segment.start, segment.end]) {
      if (normalized.some((other, otherIndex) => otherIndex !== index && isInterior(point, other))) junctions.set(pointKey(point), point);
    }
    prefixes.push({ wires: normalized, junctions: [...junctions.values()].sort(pointOrder) });
  }
  return prefixes;
}

export const FRESH_SCHEMATIC_COMPLETE_PLAN_NORMALIZATION_VERSION = "doc2-complete-plan-v1" as const;

/**
 * Versioned complete-plan expectation, deliberately NOT the last sequential
 * prefix. Inputs are exact four-decimal coordinates. Collinear spans merge
 * once; required T junctions and intentional crossings at original planned
 * endpoints are explicit. Existing historical prefix oracles remain unchanged.
 * The caller must already have rejected cross-net contacts/crossings.
 */
export function expectedFreshSchematicCompletePlanGeometry(wires: readonly FreshSchematicWire[], budget = new FreshSchematicWorkBudget()) {
  return withFreshSchematicWorkBudget(budget, (work): FreshSchematicWriterGeometry => {
    if (!Array.isArray(wires) || wires.length > 4096) throw new Error("Complete schematic batch wire inventory exceeds its bounded profile.");
    const seen = new Set<string>();
    const endpoints = new Set<string>();
    for (const wire of wires) {
      if (!work.charge("input")) return { wires: [], junctions: [] };
      for (const point of [wire.start, wire.end]) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 2000 || Math.abs(point.y) > 2000
            || writerCoordinate(point.x) !== point.x || writerCoordinate(point.y) !== point.y) {
          throw new Error("Complete batch coordinates must already be exact finite four-decimal millimetres; no snapping is permitted.");
        }
        endpoints.add(pointKey(point));
      }
      if (pointKey(wire.start) === pointKey(wire.end) || wire.start.x !== wire.end.x && wire.start.y !== wire.end.y) throw new Error("Complete batch wires must be nonzero and orthogonal.");
      const key = wireKey(wire);
      if (seen.has(key)) throw new Error("Complete batch contains a duplicate or reversed-duplicate submitted wire.");
      seen.add(key);
    }
    if (!work.charge("route", Math.max(1, wires.length * Math.max(1, Math.ceil(Math.log2(wires.length + 1)))))) return { wires: [], junctions: [] };
    const normalized = mergedWires(wires);
    const junctions = new Map<string, FreshPoint>();
    for (let index = 0; index < normalized.length; index += 1) for (let otherIndex = index + 1; otherIndex < normalized.length; otherIndex += 1) {
      if (!work.charge("route")) return { wires: [], junctions: [] };
      const left = normalized[index]!;
      const right = normalized[otherIndex]!;
      const leftVertical = left.start.x === left.end.x;
      const rightVertical = right.start.x === right.end.x;
      if (leftVertical === rightVertical) continue;
      const vertical = leftVertical ? left : right;
      const horizontal = leftVertical ? right : left;
      const point = { x: vertical.start.x, y: horizontal.start.y };
      const onBoth = point.y >= Math.min(vertical.start.y, vertical.end.y) && point.y <= Math.max(vertical.start.y, vertical.end.y)
        && point.x >= Math.min(horizontal.start.x, horizontal.end.x) && point.x <= Math.max(horizontal.start.x, horizontal.end.x);
      if (!onBoth) continue;
      const verticalInterior = isInterior(point, vertical);
      const horizontalInterior = isInterior(point, horizontal);
      if (verticalInterior !== horizontalInterior || verticalInterior && endpoints.has(pointKey(point))) junctions.set(pointKey(point), point);
    }
    return { wires: normalized, junctions: [...junctions.values()].sort(pointOrder) };
  });
}

/**
 * Compare actual records exactly (apart from record order/wire direction).
 * Do not round, deduplicate, merge, or repair actual records: an extra wire,
 * duplicate, split run, changed endpoint, or wrong junction must fail closed.
 */
export function exactFreshSchematicGeometryMatches(actual: FreshSchematicWriterGeometry, expected: FreshSchematicWriterGeometry): boolean {
  const recordsMatch = <T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean => left.length === right.length
    && JSON.stringify(left.map(key).sort()) === JSON.stringify(right.map(key).sort());
  return recordsMatch(actual.wires, expected.wires, wireKey) && recordsMatch(actual.junctions, expected.junctions, pointKey);
}
