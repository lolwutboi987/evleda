import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { assertPcbLibrarySourcesCurrent } from "./pcb-library-source-binding.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { parseFreshPcbSourceDocument, type FreshKicadSourceNode as Node } from "./fresh-kicad-parser.js";
import { segmentDistanceRelation } from "./plane-bore-geometry.js";

type Point = Readonly<{ x: number; y: number }>;
type Box = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
type Status = "pass" | "fail" | "unknown";
const issued = new WeakSet<object>();
const requireValue = (v: unknown, why: string): void => { if (!v) throw new Error(`Plane placement: ${why}`); };
const field = (node: Node, name: string): Node => {
  const values = node.children.filter(c => c.name === name); requireValue(values.length === 1, `expected one ${name}`); return values[0]!;
};
function nm(text: string): number {
  requireValue(text.length <= 96, "decimal length");
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text); requireValue(m !== null, "decimal quantity");
  const exponent = Number(m![4] ?? 0), power = 6 + exponent - (m![3]?.length ?? 0);
  requireValue(Number.isSafeInteger(exponent) && Math.abs(power) <= 30, "decimal exponent");
  let n = BigInt(m![2]! + (m![3] ?? ""));
  if (power >= 0) n *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); requireValue(n % divisor === 0n, "sub-nanometre quantity"); n /= divisor; }
  const value = Number(m![1] === "-" ? -n : n); requireValue(Number.isSafeInteger(value) && Math.abs(value) <= 2_000_000_000, "coordinate bound"); return value;
}
const point = (node: Node): Point => {
  requireValue(node.children.length === 0 && node.values.length === 2 && node.values.every(v => !v.quoted), "point shape");
  return { x: nm(node.values[0]!.value), y: nm(node.values[1]!.value) };
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const key = (p: Point) => `${p.x},${p.y}`;
/** Complete simple orthogonal contours; curves and disconnected outlines remain unsupported. */
function boundary(fp: Node, layer: string, rectKind: string, lineKind: string) {
  const shapes = fp.children.filter(n => n.children.some(c => c.name === "layer" && c.values[0]?.value === layer));
  let edges: (readonly [Point, Point])[];
  if (shapes.length === 1 && shapes[0]!.name === rectKind) {
    const a = point(field(shapes[0]!, "start")), b = point(field(shapes[0]!, "end"));
    const ring = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    edges = ring.map((p,i) => [p,ring[(i+1)%ring.length]!] as const);
  }
  else {
    requireValue(shapes.length >= 4 && shapes.length <= 128 && shapes.every(s => s.name === lineKind), "unsupported complete courtyard boundary");
    edges = shapes.map(s => [point(field(s, "start")), point(field(s, "end"))] as const);
  }
  const neighbors = new Map<string, Point[]>(), positions = new Map<string, Point>();
  for (const [a,b] of edges) {
    requireValue((a.x === b.x) !== (a.y === b.y), "non-cardinal or zero courtyard edge");
    for (const [p,q] of [[a,b],[b,a]]) { positions.set(key(p!),p!); neighbors.set(key(p!),[...(neighbors.get(key(p!))??[]),q!]); }
  }
  requireValue([...neighbors.values()].every(v => v.length === 2) && new Set(edges.map(([a,b])=>[key(a),key(b)].sort().join("|"))).size === edges.length, "open or repeated boundary");
  for (let i=0;i<edges.length;i++) for (let j=i+1;j<edges.length;j++) {
    const [a,b]=edges[i]!,[c,d]=edges[j]!, shared=[a,b].find(p=>key(p)===key(c)||key(p)===key(d));
    if (shared===undefined) requireValue(segmentDistanceRelation(a,b,c,d,0)==="separate", "self-intersecting courtyard");
    else {
      const p=key(a)===key(shared)?b:a,q=key(c)===key(shared)?d:c;
      requireValue(BigInt(p.x-shared.x)*BigInt(q.x-shared.x)+BigInt(p.y-shared.y)*BigInt(q.y-shared.y)<=0n, "overlapping adjacent boundary edges");
    }
  }
  const first=[...positions.keys()].sort()[0]!, points: Point[]=[];
  let current=positions.get(first)!, previous: string|undefined;
  do { requireValue(points.length < edges.length, "disconnected courtyard cycles"); points.push(current);
    const next=neighbors.get(key(current))!.find(p=>key(p)!==previous)!; previous=key(current); current=next;
  } while(key(current)!==first);
  requireValue(points.length===edges.length,"disconnected courtyard cycles");
  for(let i=0;points.length>4&&i<points.length;) {
    const a=points[(i+points.length-1)%points.length]!,b=points[i]!,c=points[(i+1)%points.length]!;
    if((a.x===b.x&&b.x===c.x)||(a.y===b.y&&b.y===c.y)){points.splice(i,1);i=0;}else i++;
  }
  const area=points.reduce((s,p,i)=>{const q=points[(i+1)%points.length]!;return s+BigInt(p.x)*BigInt(q.y)-BigInt(q.x)*BigInt(p.y);},0n);
  requireValue(area!==0n,"zero-area courtyard");
  const box = { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
  const encodings=[points,[...points].reverse()].flatMap(r=>r.map((_,i)=>canonicalJson([...r.slice(i),...r.slice(0,i)])));
  return {box,shapeIdentity:encodings.sort()[0]!,rectangular:points.length===4&&new Set(points.map(p=>p.x)).size===2&&new Set(points.map(p=>p.y)).size===2};
}
const courtyard = (fp: Node) => boundary(fp, "F.CrtYd", "fp_rect", "fp_line");
function pose(fp: Node) {
  const at = field(fp, "at"); requireValue(at.children.length === 0 && [2,3].includes(at.values.length) && at.values.every(v => !v.quoted), "footprint pose");
  const angle = nm(at.values[2]?.value ?? "0"), normalized = ((angle % 360_000_000) + 360_000_000) % 360_000_000;
  requireValue(normalized % 90_000_000 === 0, "non-cardinal footprint pose");
  return { x: nm(at.values[0]!.value), y: nm(at.values[1]!.value), rotationDeg: normalized / 1e6 };
}
function transform(box: Box, at: ReturnType<typeof pose>): Box {
  const points = [box.minX, box.maxX].flatMap(x => [box.minY, box.maxY].map(y => {
    const p = at.rotationDeg === 0 ? { x, y } : at.rotationDeg === 90 ? { x: y, y: -x }
      : at.rotationDeg === 180 ? { x: -x, y: -y } : { x: -y, y: x };
    return { x: at.x + p.x, y: at.y + p.y };
  }));
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}
export interface FreshPlanePlacementRow {
  readonly id: string; readonly kind: "placement"; readonly status: Status; readonly reasons: readonly string[];
  readonly reference: string;
  readonly observations: Readonly<{
    poseNm: (Point & { readonly rotationDeg: number }) | null; courtyardNm: Box | null;
    libraryCourtyardMatched: boolean; rectangularCourtyard: boolean | null; sideMatches: boolean | null; regionMatches: boolean | null; rotationMatches: boolean | null;
    edgeClearancesNm: Readonly<{ left: number; right: number; top: number; bottom: number }> | null;
    minimumEdgeClearanceNm: number; edgePreference: string; edgePreferenceMatches: boolean | null;
    pairs: readonly Readonly<{ reference: string; requiredNm: number; distanceSquaredNm2: string | null; distanceBasis: "exact-rectangles" | "conservative-enclosures" | null; interiorsOverlap: boolean | null; status: Status }>[];
  }>;
}

/** Source-only calculations over the actual authenticated V2 contract. Host
 * reads bracket the entire native project and approved libraries; this neither
 * changes placement nor declares electrical or mechanical assembly approval. */
export function assessFreshPlanePlacement(input: { readonly compilationBundle: PcbPlaneCompilationBundle; readonly pcbSource: string; readonly libraryResolver: PcbReadOnlyLibraryResolver }) {
  const bundle = input.compilationBundle; requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated V2 bundle required");
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, input.libraryResolver);
  const board = bundle.contract.scope.board, root = parseFreshPcbSourceDocument(input.pcbSource), nodes = root.children.filter(n => n.name === "footprint");
  const observedRefs = nodes.flatMap(fp => fp.children.filter(n => n.name === "property" && n.values[0]?.value === "Reference").map(n => n.values[1]?.value ?? ""));
  const expectedRefs = [...bundle.contract.components, ...(bundle.contract.boardFeatures ?? [])].map(c => c.reference).sort();
  const inventoryExact = observedRefs.length === nodes.length && same([...observedRefs].sort(), expectedRefs);
  let outline: Box | null = null, outlineError: string | null = null;
  try {
    requireValue(!nodes.some(fp => fp.children.some(n => n.children.some(c => c.name === "layer" && c.values[0]?.value === "Edge.Cuts"))), "footprint-local board outline unsupported");
    const contour = boundary(root, "Edge.Cuts", "gr_rect", "gr_line"); requireValue(contour.rectangular,"nonrectangular board outline"); outline = contour.box;
  } catch (error) { outlineError = error instanceof Error ? error.message : "Unsupported board outline."; }
  const outlineMatches = outline !== null && same(outline, { minX: 0, minY: 0, maxX: nm(String(board.widthMm)), maxY: nm(String(board.heightMm)) });
  const parsed = bundle.contract.placementConstraints.map(c => {
    const component = bundle.contract.components.find(p => p.reference === c.reference)!;
    const matches = nodes.filter(n => n.children.some(p => p.name === "property" && p.values[0]?.value === "Reference" && p.values[1]?.value === c.reference));
    const observations = { poseNm: null as ReturnType<typeof pose> | null, courtyardNm: null as Box | null, libraryCourtyardMatched: false, rectangularCourtyard: null as boolean|null,
      sideMatches: null as boolean | null, regionMatches: null as boolean | null, rotationMatches: null as boolean | null,
      edgeClearancesNm: null as { left: number; right: number; top: number; bottom: number } | null,
      minimumEdgeClearanceNm: nm(String(c.minimumEdgeClearanceMm)), edgePreference: c.edgePreference, edgePreferenceMatches: null as boolean | null,
      pairs: [] as { reference: string; requiredNm: number; distanceSquaredNm2: string | null; distanceBasis: "exact-rectangles" | "conservative-enclosures" | null; interiorsOverlap: boolean | null; status: Status }[] };
    let status: Status = "unknown", reasons: string[] = [];
    if (matches.length !== 1) return { c, status: "fail" as Status, reasons: ["The declared footprint does not occur exactly once."], observations };
    try {
      const fp = matches[0]!, at = pose(fp);
      observations.poseNm = at;
      observations.sideMatches = field(fp, "layer").values[0]!.value === (c.side === "front" ? "F.Cu" : "B.Cu");
      const r = c.regionMm;
      observations.regionMatches = at.x >= nm(String(r.minXmm)) && at.x <= nm(String(r.maxXmm)) && at.y >= nm(String(r.minYmm)) && at.y <= nm(String(r.maxYmm));
      observations.rotationMatches = c.allowedRotationsDeg.includes(at.rotationDeg as 0 | 90 | 180 | 270);
      requireValue(c.side === "front", "back-side courtyard transformation unsupported");
      const local = courtyard(fp), world = transform(local.box, at);
      observations.courtyardNm = world; observations.rectangularCourtyard=local.rectangular;
      const library = input.libraryResolver.readFootprintSource?.(component.footprintLibId);
      requireValue(library !== null && library !== undefined && same(contentIdentity(library.source), library.sourceIdentity), "current approved footprint source unavailable");
      const pin = bundle.libraryBinding.sourceSelection?.records.find(r => r.kind === "footprint" && r.libraryId === component.footprintLibId);
      requireValue(pin !== undefined && same(pin.sourceIdentity, library!.sourceIdentity), "courtyard source differs from the approved binding");
      const approved = parseFreshPcbSourceDocument(`(kicad_pcb ${library!.source})`).children.filter(n => n.name === "footprint");
      requireValue(approved.length === 1, "approved footprint source inventory");
      observations.libraryCourtyardMatched = local.shapeIdentity===courtyard(approved[0]!).shapeIdentity;
      requireValue(outline !== null, outlineError ?? "missing board outline");
      const edges = { left: world.minX, right: nm(String(board.widthMm)) - world.maxX, top: world.minY, bottom: nm(String(board.heightMm)) - world.maxY };
      observations.edgeClearancesNm = edges;
      observations.edgePreferenceMatches = c.edgePreference === "none" || edges[c.edgePreference] === Math.min(...Object.values(edges));
      const okay = outlineMatches && observations.libraryCourtyardMatched && observations.sideMatches && observations.regionMatches && observations.rotationMatches
        && observations.edgePreferenceMatches && Object.values(edges).every(v => v >= observations.minimumEdgeClearanceNm);
      status = okay ? "pass" : "fail";
      reasons = [okay ? "Exact cardinal pose and approved courtyard bounds satisfy the side, region, rotation and board-edge constraints."
        : "The saved pose, approved courtyard, side, region, rotation or board-edge condition differs from the declared placement constraints."];
    } catch (error) {
      status = [observations.sideMatches, observations.regionMatches, observations.rotationMatches].includes(false) ? "fail" : "unknown";
      reasons = [error instanceof Error ? error.message : "Unsupported placement geometry."];
      if (status === "fail") reasons.push("A known side, region or rotation mismatch remains a failure despite incomplete courtyard evidence.");
    }
    if (!inventoryExact) { status = "fail"; reasons.push("The complete footprint reference inventory differs from the bound design; unknown footprints cannot be ignored for placement."); }
    return { c, status, reasons, observations };
  });
  for (let i = 0; i < parsed.length; i++) for (let j = i + 1; j < parsed.length; j++) {
    const a = parsed[i]!, b = parsed[j]!, x = a.observations.courtyardNm, y = b.observations.courtyardNm;
    const requiredNm = Math.max(nm(String(a.c.minimumCourtyardClearanceMm)), nm(String(b.c.minimumCourtyardClearanceMm)));
    let distanceSquaredNm2: string | null = null, distanceBasis: "exact-rectangles" | "conservative-enclosures" | null = null, interiorsOverlap: boolean | null = null, status: Status = "unknown";
    if (x !== null && y !== null && a.observations.libraryCourtyardMatched && b.observations.libraryCourtyardMatched) {
      const dx = Math.max(0, x.minX - y.maxX, y.minX - x.maxX), dy = Math.max(0, x.minY - y.maxY, y.minY - x.maxY), d = BigInt(dx) ** 2n + BigInt(dy) ** 2n;
      const overlap = x.minX < y.maxX && y.minX < x.maxX && x.minY < y.maxY && y.minY < x.maxY;
      const exact = a.observations.rectangularCourtyard && b.observations.rectangularCourtyard;
      distanceBasis = exact ? "exact-rectangles" : "conservative-enclosures";
      interiorsOverlap = exact ? overlap : overlap ? null : false;
      distanceSquaredNm2 = d.toString(); status = !overlap && d >= BigInt(requiredNm) ** 2n ? "pass" : exact ? "fail" : "unknown";
    }
    for (const [item, other] of [[a,b],[b,a]] as const) {
      item.observations.pairs.push({ reference: other.c.reference, requiredNm, distanceSquaredNm2, distanceBasis, interiorsOverlap, status });
      if (status === "fail") { item.status = "fail"; item.reasons.push(`Courtyard separation from ${other.c.reference} is below the declared pairwise requirement.`); }
      else if (status === "unknown" && item.status !== "fail") { item.status = "unknown"; item.reasons.push(`Complete approved courtyard geometry for ${other.c.reference} is unavailable.`); }
    }
  }
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, input.libraryResolver);
  const rows: FreshPlanePlacementRow[] = parsed.map(p => ({ id: `placement:${p.c.reference}`, kind: "placement", reference: p.c.reference, status: p.status, reasons: p.reasons, observations: p.observations }));
  const payload = { schemaVersion: "evleda.fresh-plane-placement-checks.v1" as const, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
    verificationPlanIdentity: bundle.verificationPlan.identity, pcbIdentity: contentIdentity(input.pcbSource), libraryBindingIdentity: bundle.libraryBinding.identity, rows,
    scope: "exact-cardinal-front-placement-with-approved-courtyard-enclosures" as const, assemblyClearanceClaimed: false as const, accepted: false as const };
  const result = freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) }); issued.add(result); return result;
}
export type FreshPlanePlacementAssessment = ReturnType<typeof assessFreshPlanePlacement>;
export function isFreshPlanePlacementAssessment(value: unknown): value is FreshPlanePlacementAssessment { return value !== null && typeof value === "object" && issued.has(value); }
