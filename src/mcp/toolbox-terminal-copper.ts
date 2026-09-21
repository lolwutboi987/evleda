import type { TerminalCopperPathCalculation } from "../harness/plane-terminal-copper-paths.js";
import { sanitizePcbDiagnosticText } from "./toolbox-interface-report.js";

interface Observation {
  readonly status: "verified" | "failed" | "unknown"; readonly reasons: readonly string[];
  readonly net: string; readonly calculation: TerminalCopperPathCalculation | null;
}
const check = (v: unknown, reason: string): void => { if (!v) throw new Error(`Terminal copper projection: ${reason}`); };
const text = (s: string): string => { check(typeof s === "string", "text field"); return sanitizePcbDiagnosticText(s); };
const integer = (n: number, positive = false): number => { check(Number.isSafeInteger(n) && Math.abs(n) <= 2_000_000_000 && (!positive || n > 0), "integer field"); return n; };
const id = (s: string): string => { check(typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s), "object identity"); return s; };
const node = (s: string): string => {
  check(typeof s === "string" && (/^(?:pad|via|track):[A-Za-z0-9_-]{1,128}$/u.test(s)
    || /^plane:[A-Za-z0-9_-]{1,128}:[0-9]{1,10}$/u.test(s)
    || /^port:(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu:-?[0-9]{1,10},-?[0-9]{1,10}$/u.test(s)), "graph identity");
  return s;
};
const edgeKey = (a: string, b: string) => JSON.stringify([a, b].sort());

/** Closed, lossless projection of the path witnesses; no native records or
 * arbitrary source/path metadata are forwarded. This does not mint authority. */
export function summarizeTerminalCopperConnectivity(value: Observation, expectedPadUuids: readonly string[], planeId: string) {
  check(["verified", "failed", "unknown"].includes(value.status), "observation status");
  const base = { status: value.status, reasons: value.reasons.map(text), net: text(value.net) };
  const c = value.calculation;
  if (c === null) { check(value.status !== "verified", "verified observation requires witnesses"); return { ...base, calculation: null }; }
  check(c.scope === "positive-width-copper-paths-to-connected-drilled-plane-interiors" && c.currentCapacityClaimed === false && c.fabricationAuthorized === false, "unsupported scope or approval claim");
  check(c.terminals.length <= 4096 && c.primitiveInteriors.length <= 4096 && c.witnessPorts.length <= 16384 * 32
    && c.witnessLinks.length <= 1_000_000, "inventory bounds");
  check(new Set(expectedPadUuids).size === expectedPadUuids.length && new Set(c.terminals.map(t => t.padUuid)).size === c.terminals.length
    && c.terminals.length === expectedPadUuids.length && c.terminals.every(t => expectedPadUuids.includes(t.padUuid)), "complete physical terminal inventory differs");
  const primitiveInteriors = c.primitiveInteriors.map(p => {
    check(p.status === "verified" || p.status === "unproven", "interior status");
    check(/^(?:pad|via):/u.test(p.id), "interior kind");
    return { id: node(p.id), status: p.status, reason: text(p.reason) };
  });
  check(new Set(primitiveInteriors.map(p => p.id)).size === primitiveInteriors.length, "duplicate interior identity");
  const interiors = new Map(primitiveInteriors.map(p => [p.id, p]));
  const witnessPorts = c.witnessPorts.map(p => {
    const x = integer(p.centerNm.x), y = integer(p.centerNm.y), radiusNm = integer(p.radiusNm, true);
    check(p.id === `port:${p.layer}:${x},${y}`, "port coordinate identity differs");
    return { id: node(p.id), centerNm: { x, y }, layer: p.layer, radiusNm };
  });
  check(new Set(witnessPorts.map(p => p.id)).size === witnessPorts.length, "duplicate port identity");
  const ports = new Map(witnessPorts.map(p => [p.id, p]));
  const witnessLinks = c.witnessLinks.map(l => {
    const from = node(l.from), to = node(l.to), primitiveId = node(l.primitiveId);
    check(from !== to, "zero-length graph link");
    check(l.kind === "connected-interior" || l.kind === "clear-track-capsule", "link kind");
    if (l.kind === "connected-interior") {
      check(l.radiusNm === null && (from === primitiveId || to === primitiveId), "interior link ownership");
      const p = from === primitiveId ? to : from;
      check(ports.has(p), "interior port missing");
      check(primitiveId.startsWith(`plane:${planeId}:`) || interiors.get(primitiveId)?.status === "verified", "unproved interior used by path");
    } else {
      check(primitiveId.startsWith("track:") && ports.has(from) && ports.has(to) && ports.get(from)!.layer === ports.get(to)!.layer, "track link endpoints");
      integer(l.radiusNm!, true);
    }
    return { from, to, kind: l.kind, primitiveId, radiusNm: l.radiusNm };
  });
  const links = new Map(witnessLinks.map(l => [edgeKey(l.from, l.to), l]));
  check(links.size === witnessLinks.length, "duplicate witness link");
  const usedNodes = new Set<string>(), usedLinks = new Set<string>();
  const terminals = c.terminals.map(t => {
    check(t.status === "witnessed" || t.status === "unproven", "terminal status");
    const padUuid = id(t.padUuid), path = t.path.map(node);
    check(path.length <= 16384 * 32 + 4096 && new Set(path).size === path.length, "path size or repeated node");
    if (t.status === "unproven") check(path.length === 0, "unproven terminal has a claimed path");
    else {
      check(path.length >= 3 && path[0] === `pad:${padUuid}` && path.at(-1)!.startsWith(`plane:${planeId}:`), "path terminal or target differs");
      path.forEach(n => usedNodes.add(n));
      for (let i = 1; i < path.length; i++) { const k = edgeKey(path[i - 1]!, path[i]!); check(links.has(k), "discontinuous path"); usedLinks.add(k); }
    }
    return { padUuid, reference: text(t.reference), pin: text(t.pin), status: t.status, reason: text(t.reason), path };
  });
  check(witnessPorts.every(p => usedNodes.has(p.id)) && usedLinks.size === witnessLinks.length, "orphan witness evidence");
  const all = terminals.length > 0 && terminals.every(t => t.status === "witnessed");
  check(c.allTerminalsWitnessed === all && (value.status !== "verified" || all), "inconsistent all-terminal claim");
  const predicateOperations = integer(c.predicateOperations);
  check(predicateOperations >= 0 && predicateOperations <= 4_000_000, "predicate work bound");
  return { ...base, calculation: { scope: c.scope, allTerminalsWitnessed: all, terminals, primitiveInteriors,
    witnessPorts, witnessLinks, predicateOperations, currentCapacityClaimed: false, fabricationAuthorized: false } };
}
