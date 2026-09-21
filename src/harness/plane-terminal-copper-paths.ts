import type { FreshPlaneFilledComponent } from "./fresh-plane-filled-geometry.js";
import { boreAxisTwiceNm, segmentDistanceRelation, type PlaneBoreGeometry } from "./plane-bore-geometry.js";

type Point = Readonly<{ x: number; y: number }>;
export interface TerminalCopperPad {
  readonly uuid: string; readonly reference: string; readonly pin: string;
  readonly centerNm: Point; readonly layers: readonly string[];
  readonly platedThrough: boolean;
  /** Cardinal, normal padstack only; dimensions are already in board axes. */
  readonly shape: "rectangle" | "roundrect" | "oval" | "circle";
  readonly sizeNm: Point; readonly cornerRadiusNm: number;
}
export interface TerminalCopperVia {
  readonly uuid: string; readonly centerNm: Point; readonly diameterNm: number; readonly drillNm: number;
  readonly layers: readonly string[];
}
export interface TerminalCopperTrack {
  readonly uuid: string; readonly layer: string; readonly startNm: Point; readonly endNm: Point; readonly widthNm: number;
}
export interface TerminalCopperPlane {
  readonly id: string; readonly layer: string; readonly component: FreshPlaneFilledComponent;
}
export interface TerminalCopperPathInput {
  readonly boardBoundsNm: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
  readonly pads: readonly TerminalCopperPad[];
  readonly vias: readonly TerminalCopperVia[];
  readonly tracks: readonly TerminalCopperTrack[];
  readonly bores: readonly (PlaneBoreGeometry & { readonly uuid: string })[];
  /** Only components with separately authenticated connected drilled interiors. */
  readonly planes: readonly TerminalCopperPlane[];
  readonly targetPlaneId: string;
}
export interface TerminalCopperPathCalculation {
  readonly scope: "positive-width-copper-paths-to-connected-drilled-plane-interiors";
  readonly allTerminalsWitnessed: boolean;
  readonly terminals: readonly Readonly<{
    padUuid: string; reference: string; pin: string; status: "witnessed" | "unproven";
    reason: string; path: readonly string[];
  }>[];
  readonly primitiveInteriors: readonly Readonly<{ id: string; status: "verified" | "unproven"; reason: string }>[];
  /** Every port used by a published path is retained; other search samples are not evidence. */
  readonly witnessPorts: readonly Readonly<{ id: string; centerNm: Point; layer: string; radiusNm: number }>[];
  readonly witnessLinks: readonly Readonly<{ from: string; to: string; kind: "connected-interior" | "clear-track-capsule"; primitiveId: string; radiusNm: number | null }>[];
  readonly predicateOperations: number;
  readonly currentCapacityClaimed: false;
  readonly fabricationAuthorized: false;
}

const MAX_COORD = 2_000_000_000, MAX_ITEMS = 4096, MAX_SAMPLES = 16384, MAX_WORK = 4_000_000;
const MAX_GRAPH_NODES = 65536, MAX_GRAPH_LINKS = 131072;
const requireValue = (value: unknown, reason: string): void => { if (!value) throw new Error(`Terminal copper paths: ${reason}`); };
const sq = (a: Point, b: Point) => BigInt(a.x - b.x) ** 2n + BigInt(a.y - b.y) ** 2n;
const cross = (a: Point, b: Point, p: Point) => BigInt(b.x - a.x) * BigInt(p.y - a.y) - BigInt(b.y - a.y) * BigInt(p.x - a.x);
function floorSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let a = n, b = (n + 1n) / 2n;
  while (b < a) { a = b; b = (a + n / a) / 2n; }
  return a;
}
function distance(p: Point, a: Point, b: Point): { n: bigint; d: bigint } {
  const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y), length = dx * dx + dy * dy;
  const dot = BigInt(p.x - a.x) * dx + BigInt(p.y - a.y) * dy;
  if (length === 0n || dot <= 0n) return { n: sq(p, a), d: 1n };
  if (dot >= length) return { n: sq(p, b), d: 1n };
  return { n: cross(a, b, p) ** 2n, d: length };
}
function ceilDistance(p: Point, a: Point, b: Point): number {
  const { n, d } = distance(p, a, b), root = floorSqrt(n / d);
  return Number(root * root * d === n ? root : root + 1n);
}
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const pointKey = (p: Point) => `${p.x},${p.y}`;
const portKey = (p: Point, layer: string) => `port:${layer}:${pointKey(p)}`;
const boxOf = (center: Point, hx: number, hy: number) => ({ minX: center.x - hx, maxX: center.x + hx, minY: center.y - hy, maxY: center.y + hy });
type Box = ReturnType<typeof boxOf>;
const inBox = (p: Point, b: Box) => p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY;
const boxesSeparate = (a: Box, b: Box) => a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
const boxCorners = (b: Box): readonly Point[] => [{ x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }];
function padClearance(p: Point, pad: TerminalCopperPad): number {
  const hx = Math.floor(pad.sizeNm.x / 2), hy = Math.floor(pad.sizeNm.y / 2);
  const x = Math.abs(p.x - pad.centerNm.x), y = Math.abs(p.y - pad.centerNm.y);
  if (pad.shape === "rectangle") return Math.min(hx - x, hy - y);
  if (pad.shape === "roundrect") {
    const r = pad.cornerRadiusNm, dx = Math.max(0, x - (hx - r)), dy = Math.max(0, y - (hy - r));
    return Math.min(hx - x, hy - y, r - ceilDistance({ x: dx, y: dy }, { x: 0, y: 0 }, { x: 0, y: 0 }));
  }
  const radius = Math.min(hx, hy), delta = Math.abs(hx - hy), c = pad.centerNm;
  const a = hx >= hy ? { x: c.x - delta, y: c.y } : { x: c.x, y: c.y - delta };
  const b = hx >= hy ? { x: c.x + delta, y: c.y } : { x: c.x, y: c.y + delta };
  return radius - ceilDistance(p, a, b);
}

/** Pure nominal-geometry witness search, not native authority or ampacity.
 * Callers qualify source/net/layer correspondence and each supplied plane's
 * connected drilled interior. Unsupported contacts simply have no path. */
export function findTerminalCopperPaths(input: TerminalCopperPathInput): TerminalCopperPathCalculation {
  let work = 0;
  const step = () => { requireValue(++work <= MAX_WORK, "predicate work bound"); };
  const integer = (n: number) => requireValue(Number.isSafeInteger(n) && Math.abs(n) <= MAX_COORD, "coordinate or dimension bound");
  const checkPoint = (p: Point) => { integer(p.x); integer(p.y); };
  const outline = input.boardBoundsNm;
  Object.values(outline).forEach(integer);
  requireValue(outline.minX < outline.maxX && outline.minY < outline.maxY, "rectangular board bounds");
  const primitives = [...input.pads, ...input.vias, ...input.tracks];
  requireValue(primitives.length <= MAX_ITEMS && input.bores.length <= MAX_ITEMS && input.planes.length <= 128, "item count bound");
  requireValue(new Set(primitives.map(p => p.uuid)).size === primitives.length, "duplicate primitive identity");
  requireValue(new Set(input.bores.map(p => p.uuid)).size === input.bores.length, "duplicate bore identity");
  requireValue(input.planes.filter(p => p.id === input.targetPlaneId).length === 1, "one target plane component required");
  for (const id of [...primitives.map(p => p.uuid), ...input.bores.map(b => b.uuid), ...input.planes.map(p => p.id)])
    requireValue(typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id), "primitive identity");
  const layers = new Set([...input.pads.flatMap(p => p.layers), ...input.vias.flatMap(v => v.layers), ...input.tracks.map(t => t.layer), ...input.planes.map(p => p.layer)]);
  requireValue(layers.size > 0 && layers.size <= 32 && [...layers].every(l => /^(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/u.test(l)), "copper layers");
  for (const p of input.pads) {
    checkPoint(p.centerNm); checkPoint(p.sizeNm); integer(p.cornerRadiusNm);
    requireValue(p.sizeNm.x > 0 && p.sizeNm.y > 0 && p.layers.length > 0 && new Set(p.layers).size === p.layers.length, "pad dimensions or layers");
    requireValue(p.platedThrough ? p.layers.length >= 2 && input.bores.some(b => b.uuid === p.uuid) : p.layers.length === 1 && !input.bores.some(b => b.uuid === p.uuid), "pad drill and layer span");
    requireValue(["rectangle", "roundrect", "oval", "circle"].includes(p.shape), "pad shape");
    requireValue(p.shape !== "circle" || p.sizeNm.x === p.sizeNm.y, "noncircular circle pad");
    requireValue(p.shape === "roundrect" ? p.cornerRadiusNm > 0 && 2 * p.cornerRadiusNm <= Math.min(p.sizeNm.x, p.sizeNm.y) : p.cornerRadiusNm === 0, "corner radius");
  }
  const boreAxes = input.bores.map(b => {
    checkPoint(b.centerNm); integer(b.diameterNm); requireValue(b.diameterNm > 0, "bore diameter");
    if (b.slot) { integer(b.slot.majorDiameterNm); requireValue(b.slot.majorDiameterNm >= b.diameterNm && ["x", "y"].includes(b.slot.axis), "slot geometry"); }
    const [a, c] = boreAxisTwiceNm(b), r = b.diameterNm;
    return { bore: b, a, b: c, box: { minX: Math.floor((Math.min(a.x, c.x) - r) / 2), maxX: Math.ceil((Math.max(a.x, c.x) + r) / 2),
      minY: Math.floor((Math.min(a.y, c.y) - r) / 2), maxY: Math.ceil((Math.max(a.y, c.y) + r) / 2) } };
  });
  const samples = new Map<string, Point>(), sampleLayers = new Map<string, Set<string>>();
  const sample = (p: Point, onLayers: readonly string[]) => {
    checkPoint(p); const k = pointKey(p); samples.set(k, p);
    const known = sampleLayers.get(k) ?? new Set<string>(); onLayers.forEach(l => known.add(l)); sampleLayers.set(k, known);
    requireValue(samples.size <= MAX_SAMPLES, "sample count bound");
  };
  for (const p of input.pads) for (const x of [-3, -2, 0, 2, 3]) for (const y of [-3, -2, 0, 2, 3])
    sample({ x: p.centerNm.x + Math.trunc(p.sizeNm.x * x / 8), y: p.centerNm.y + Math.trunc(p.sizeNm.y * y / 8) }, p.layers);
  for (const v of input.vias) {
    checkPoint(v.centerNm); integer(v.diameterNm); integer(v.drillNm);
    requireValue(v.drillNm > 0 && v.diameterNm > v.drillNm && v.layers.length >= 2 && new Set(v.layers).size === v.layers.length, "via annulus or layers");
    const own = input.bores.find(b => b.uuid === v.uuid);
    requireValue(own !== undefined && !own.slot && own.diameterNm === v.drillNm && samePoint(own.centerNm, v.centerNm), "via bore absent or contradictory");
    const r = Math.floor((v.diameterNm + v.drillNm) / 4), a = Math.floor(3 * r / 5), b = Math.floor(4 * r / 5);
    for (const [x, y] of [[r,0],[-r,0],[0,r],[0,-r],[a,b],[a,-b],[-a,b],[-a,-b],[b,a],[b,-a],[-b,a],[-b,-a]])
      sample({ x: v.centerNm.x + x!, y: v.centerNm.y + y! }, v.layers);
  }
  for (const t of input.tracks) { checkPoint(t.startNm); checkPoint(t.endNm); integer(t.widthNm); requireValue(t.widthNm > 0 && !samePoint(t.startNm, t.endNm), "track geometry"); sample(t.startNm, [t.layer]); sample(t.endNm, [t.layer]); }
  let vertices = 0;
  for (const p of input.planes) {
    integer(p.component.nativePolygonIndex); requireValue(p.component.nativePolygonIndex >= 0, "component index");
    requireValue(p.component.topologyCertificate === "simple_outer_minus_strict_disjoint_holes", "qualified plane geometry required");
    for (const ring of [p.component.outer, ...p.component.holes]) {
      requireValue(ring.length >= 3, "short plane contour"); vertices += ring.length;
      requireValue(vertices <= 8192, "plane vertex bound");
      ring.forEach((q, i) => { checkPoint(q); requireValue(!samePoint(q, ring[(i + 1) % ring.length]!), "zero boundary edge");
        requireValue(q.x >= outline.minX && q.x <= outline.maxX && q.y >= outline.minY && q.y <= outline.maxY, "plane outside rectangular board"); });
    }
  }
  const boreClearance = new Map<string, number>();
  for (const [k, p] of samples) {
    let radius = Math.min(p.x - outline.minX, outline.maxX - p.x, p.y - outline.minY, outline.maxY - p.y) - 1;
    for (const b of boreAxes) {
      step(); const q = { x: 2 * p.x, y: 2 * p.y }, d = distance(q, b.a, b.b);
      radius = Math.min(radius, Math.floor((Number(floorSqrt(d.n / d.d)) - b.bore.diameterNm) / 2) - 1);
      if (radius <= 0) break;
    }
    boreClearance.set(k, radius);
  }
  const adjacency = new Map<string, Set<string>>(), ports = new Map<string, { id: string; centerNm: Point; layer: string; radiusNm: number }>();
  const links = new Map<string, { from: string; to: string; kind: "connected-interior" | "clear-track-capsule"; primitiveId: string; radiusNm: number | null }>();
  const add = (id: string) => { if (!adjacency.has(id)) adjacency.set(id, new Set()); requireValue(adjacency.size <= MAX_GRAPH_NODES, "graph node bound"); };
  const connect = (from: string, to: string, kind: "connected-interior" | "clear-track-capsule", primitiveId: string, radiusNm: number | null) => {
    step();
    add(from); add(to); adjacency.get(from)!.add(to); adjacency.get(to)!.add(from);
    const k = [from, to].sort().join("|"); if (!links.has(k)) links.set(k, { from, to, kind, primitiveId, radiusNm });
    requireValue(links.size <= MAX_GRAPH_LINKS, "graph link bound");
  };
  const port = (p: Point, layer: string, radius: number) => {
    const id = portKey(p, layer), old = ports.get(id); add(id);
    // Use the minimum certified radius where several primitives share a port.
    ports.set(id, { id, centerNm: p, layer, radiusNm: Math.min(old?.radiusNm ?? radius, radius) }); return id;
  };
  const interiors: { id: string; status: "verified" | "unproven"; reason: string }[] = [];
  const eligibleSamples = (box: Box, onLayers: readonly string[], clearance: (p: Point) => number) => [...samples.values()].flatMap(p => {
    step();
    if (!onLayers.some(l => sampleLayers.get(pointKey(p))!.has(l)) || !inBox(p, box) || boreClearance.get(pointKey(p))! <= 0) return [];
    step(); const radius = Math.min(clearance(p) - 1, boreClearance.get(pointKey(p))!);
    return radius > 0 ? [{ p, radius }] : [];
  });
  for (const p of input.pads) {
    const id = `pad:${p.uuid}`, box = boxOf(p.centerNm, Math.floor(p.sizeNm.x / 2), Math.floor(p.sizeNm.y / 2)); add(id);
    const inside: typeof boreAxes = []; let okay = boxCorners(box).every(q => inBox(q, outline));
    for (const b of boreAxes) {
      step(); if (boxesSeparate(box, b.box)) continue;
      if (!boxCorners(b.box).every(q => padClearance(q, p) > 0)) { okay = false; break; }
      inside.push(b);
    }
    for (let i = 0; okay && i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {
      step(); const a = inside[i]!, b = inside[j]!;
      if (segmentDistanceRelation(a.a, a.b, b.a, b.b, a.bore.diameterNm + b.bore.diameterNm) !== "separate") { okay = false; break; }
    }
    interiors.push({ id, status: okay ? "verified" : "unproven", reason: okay ? "Convex pad copper inside the board with strictly internal disjoint bores; every other bore strictly exterior." : "Pad extent touches the board edge, or a bore touches the conservative pad boundary or another interior bore." });
    if (okay) for (const { p: q, radius } of eligibleSamples(box, p.layers, q => padClearance(q, p))) for (const layer of p.layers)
      connect(id, port(q, layer, radius), "connected-interior", id, null);
  }
  for (const v of input.vias) {
    const id = `via:${v.uuid}`, radius = Math.floor(v.diameterNm / 2); add(id);
    const okay = boxCorners(boxOf(v.centerNm, Math.ceil(v.diameterNm / 2), Math.ceil(v.diameterNm / 2))).every(q => inBox(q, outline)) && boreAxes.every(b => {
      if (b.bore.uuid === v.uuid) return true;
      step(); const q = { x: 2 * v.centerNm.x, y: 2 * v.centerNm.y };
      return segmentDistanceRelation(q, q, b.a, b.b, v.diameterNm + b.bore.diameterNm) === "separate";
    });
    interiors.push({ id, status: okay ? "verified" : "unproven", reason: okay ? "Normal annulus and barrel inside the board; every foreign bore strictly outside the outer copper disk." : "Complete via annulus separation from foreign bores or the board edge is unproved." });
    if (okay) for (const { p, radius: r } of eligibleSamples(boxOf(v.centerNm, radius, radius), v.layers, q => radius - ceilDistance(q, v.centerNm, v.centerNm))) for (const layer of v.layers)
      connect(id, port(p, layer, r), "connected-interior", id, null);
  }
  const targets = new Set<string>();
  for (const plane of input.planes) {
    const c = plane.component, id = `plane:${plane.id}:${c.nativePolygonIndex}`;
    requireValue(!adjacency.has(id), "duplicate plane component"); add(id); if (plane.id === input.targetPlaneId) targets.add(id);
    const box = { minX: Math.min(...c.outer.map(p => p.x)), maxX: Math.max(...c.outer.map(p => p.x)), minY: Math.min(...c.outer.map(p => p.y)), maxY: Math.max(...c.outer.map(p => p.y)) };
    const clearance = (p: Point) => {
      let nearest = MAX_COORD;
      for (const [index, ring] of [c.outer, ...c.holes].entries()) {
        let winding = 0;
        for (let i = 0; i < ring.length; i++) {
          step(); const a = ring[i]!, b = ring[(i + 1) % ring.length]!, side = cross(a, b, p), d = distance(p, a, b);
          if (d.n === 0n) return 0;
          nearest = Math.min(nearest, Number(floorSqrt(d.n / d.d)));
          if (a.y <= p.y) { if (b.y > p.y && side > 0n) winding++; } else if (b.y <= p.y && side < 0n) winding--;
        }
        if ((index === 0) !== (winding !== 0)) return 0;
      }
      return nearest;
    };
    for (const { p, radius } of eligibleSamples(box, [plane.layer], clearance)) connect(id, port(p, plane.layer, radius), "connected-interior", id, null);
  }
  for (const t of input.tracks) {
    const half = Math.floor(t.widthNm / 2), box = { minX: Math.min(t.startNm.x, t.endNm.x) - half, maxX: Math.max(t.startNm.x, t.endNm.x) + half,
      minY: Math.min(t.startNm.y, t.endNm.y) - half, maxY: Math.max(t.startNm.y, t.endNm.y) + half };
    const found = eligibleSamples(box, [t.layer], p => half - ceilDistance(p, t.startNm, t.endNm));
    const dx = BigInt(t.endNm.x - t.startNm.x), dy = BigInt(t.endNm.y - t.startNm.y);
    const projection = (p: Point) => BigInt(p.x - t.startNm.x) * dx + BigInt(p.y - t.startNm.y) * dy;
    found.sort((a, b) => projection(a.p) < projection(b.p) ? -1 : projection(a.p) > projection(b.p) ? 1 : a.p.x - b.p.x || a.p.y - b.p.y);
    for (const f of found) port(f.p, t.layer, f.radius);
    for (let i = 1; i < found.length; i++) {
      const a = found[i - 1]!, b = found[i]!, radius = Math.min(a.radius, b.radius);
      const clear = boreAxes.every(bore => {
        step(); return segmentDistanceRelation({ x: 2 * a.p.x, y: 2 * a.p.y }, { x: 2 * b.p.x, y: 2 * b.p.y },
          bore.a, bore.b, 2 * radius + bore.bore.diameterNm) === "separate";
      });
      if (clear) connect(portKey(a.p, t.layer), portKey(b.p, t.layer), "clear-track-capsule", `track:${t.uuid}`, radius);
    }
  }
  const previous = new Map<string, string | null>(), queue = [...targets]; queue.forEach(k => previous.set(k, null));
  for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]!)!) if (!previous.has(next)) { previous.set(next, queue[i]!); queue.push(next); }
  const used = new Set<string>(), usedLinks = new Set<string>();
  const terminals = input.pads.map(p => {
    const start = `pad:${p.uuid}`, path: string[] = [];
    if (previous.has(start)) for (let next: string | null = start; next !== null; next = previous.get(next)!) { path.push(next); used.add(next); }
    for (let i = 1; i < path.length; i++) usedLinks.add([path[i - 1]!, path[i]!].sort().join("|"));
    return { padUuid: p.uuid, reference: p.reference, pin: p.pin, status: path.length ? "witnessed" as const : "unproven" as const,
      reason: path.length ? "A positive-width nominal copper path reaches the qualified target plane interior." : "No complete path was found through the supported connected interiors and bore-clear track capsules.", path };
  });
  return { scope: "positive-width-copper-paths-to-connected-drilled-plane-interiors", allTerminalsWitnessed: terminals.length > 0 && terminals.every(t => t.status === "witnessed"),
    terminals, primitiveInteriors: interiors, witnessPorts: [...ports.values()].filter(p => used.has(p.id)), witnessLinks: [...links].filter(([k]) => usedLinks.has(k)).map(([,v]) => v),
    predicateOperations: work, currentCapacityClaimed: false, fabricationAuthorized: false };
}
