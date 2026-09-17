import { assessDifferentialPairGeometry, assessDifferentialTrackGaps, compareDifferentialPairLengths,
  type DifferentialPairGeometryAssessment, type DifferentialPairExactLength, type DifferentialPairGeometryCheck,
  type DifferentialPairRoute, type DifferentialPairTerminal } from "./differential-pair-geometry.js";
import type { PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
function nm(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000 || Number(value.toFixed(6)) !== value) throw new Error("Channel dimensions require exact integer nanometres.");
  return Math.round(value * 1e6);
}

type Pair = NonNullable<PcbPlaneDesignContract["interfaceRequirements"]>["interfaces"][number];
type Selected = DifferentialPairGeometryAssessment["selected"];
type Length = DifferentialPairExactLength;
const selector = (p: { readonly reference: string; readonly pin: string }): DifferentialPairTerminal => ({ reference: p.reference, pad: p.pin });
const key = (p: DifferentialPairTerminal) => `${p.reference}:${p.pad}`;
const zero = (): Length => ({ twiceAxisNm: "0", twiceDiagonalNm: "0" });
const add = (a: Length, b: Length): Length => ({ twiceAxisNm: String(BigInt(a.twiceAxisNm) + BigInt(b.twiceAxisNm)), twiceDiagonalNm: String(BigInt(a.twiceDiagonalNm) + BigInt(b.twiceDiagonalNm)) });
const subtract = (a: Length, b: Length): Length => ({ twiceAxisNm: String(BigInt(a.twiceAxisNm) - BigInt(b.twiceAxisNm)), twiceDiagonalNm: String(BigInt(a.twiceDiagonalNm) - BigInt(b.twiceDiagonalNm)) });
const absolute = (v: Length): Length => compareDifferentialPairLengths(v, zero()) < 0 ? subtract(zero(), v) : v;
const limit = (mm: number): Length => ({ twiceAxisNm: String(BigInt(nm(mm)) * 2n), twiceDiagonalNm: "0" });
const check = (status: DifferentialPairGeometryCheck["status"], ...reasons: string[]): DifferentialPairGeometryCheck => ({ status, reasons });
const all = (values: readonly DifferentialPairGeometryCheck[]): DifferentialPairGeometryCheck => check(values.some(v => v.status === "fail") ? "fail" : values.length && values.every(v => v.status === "pass") ? "pass" : "not_assessed", ...new Set(values.flatMap(v => v.reasons)));

export interface DifferentialChannelGeometryAssessment {
  readonly kind: "source_series";
  readonly launch: DifferentialPairGeometryAssessment;
  readonly receiverPaths: readonly Readonly<{ receiver: Pair["endpoints"]["receiver"]; geometry: DifferentialPairGeometryAssessment;
    positiveEtchLength: Length | null; negativeEtchLength: Length | null; etchSkew: Length | null }>[];
  readonly allTrackPairGaps: DifferentialPairGeometryAssessment["allTrackPairGaps"];
  readonly copperEtchLength: Readonly<{ positive: Length | null; negative: Length | null }>;
  readonly budgets: Readonly<{ pathLength: DifferentialPairGeometryCheck; totalCopperLength: DifferentialPairGeometryCheck; pathSkew: DifferentialPairGeometryCheck }>;
  readonly checks: DifferentialPairGeometryAssessment["checks"];
  readonly anchors: readonly Readonly<{ selector: DifferentialPairTerminal; net: string; matchingPadUuids: readonly string[]; contactNodeIds: readonly string[];
    status: DifferentialPairGeometryCheck["status"] }>[];
  readonly escapes: readonly Readonly<{ net: string; edgeId: string; widthNm: number; qualifyingTerminals: readonly DifferentialPairTerminal[];
    status: DifferentialPairGeometryCheck["status"] }>[];
  readonly inventoryComplete: boolean;
  readonly accepted: false;
}

/** Preserve locally observed counterexamples while withholding complete-route facts. */
export function incompleteDifferentialGeometry(geometry: DifferentialPairGeometryAssessment): DifferentialPairGeometryAssessment {
  const unknown = check("not_assessed", "SOURCE_PROJECTION_INCOMPLETE");
  const route = (r: DifferentialPairRoute): DifferentialPairRoute => ({ ...r, status: "not_assessed", reasons: unknown.reasons,
    contacts: null, nodes: null, edges: null, mainChain: null, runs: null, stubs: null, mainLength: null, totalEtchLength: null });
  return { ...geometry, inventoryComplete: false, diagnostics: [...geometry.diagnostics, "SOURCE_PROJECTION_INCOMPLETE"],
    checks: Object.fromEntries(Object.entries(geometry.checks).map(([k, v]) => [k, ["width", "minimumGap", "transitions"].includes(k) && v.status === "fail" ? v : unknown])) as unknown as typeof geometry.checks,
    routes: { positive: route(geometry.routes.positive), negative: route(geometry.routes.negative) }, coupling: null, etchSkew: null,
    sourceRoles: geometry.sourceRoles.map(r => ({ ...r, status: "not_assessed" })), terminationAnchors: geometry.terminationAnchors.map(r => ({ ...r, status: "not_assessed" })) };
}

/** Full four-net copper graph, with no invented segment through resistor or protection internals. */
export function assessDifferentialChannelGeometry(pair: Pair, selected: Selected, projectionComplete: boolean): DifferentialChannelGeometryAssessment {
  const c = pair.channel, series = pair.terminations.source;
  if (!c || series.kind !== "source_series") throw new Error("Bounded channel requires explicit source-series mappings.");
  const roles = (points: Pair["endpoints"]["source"]) => ({ positive: selector(points.positive), negative: selector(points.negative) });
  const resistor = (field: "sourcePin" | "linePin") => ({ positive: { reference: series.positive.componentReference, pad: series.positive[field] }, negative: { reference: series.negative.componentReference, pad: series.negative[field] } });
  const receivers = [pair.endpoints.receiver, ...c.additionalReceivers];
  const protection = c.protection.flatMap(p => [...p.positivePins, ...p.negativePins].map(pin => ({ reference: p.componentReference, pad: pin })));
  const lineAnchors = [...receivers.flatMap(r => [selector(r.positive), selector(r.negative)]), ...protection];
  const evaluate = (nets: Pair["nets"], source: ReturnType<typeof roles>, receiver: ReturnType<typeof roles>, anchors: DifferentialPairTerminal[], launch: boolean) => {
    const g = assessDifferentialPairGeometry({ ...selected, positiveNet: nets.positive, negativeNet: nets.negative, source, receiver, receiverMapping: "preserved", terminationAnchors: anchors,
      limits: { minimumWidthNm: 200_000, maximumWidthNm: nm(pair.geometry.traceWidthMm.maximumMm), minimumGapNm: nm(pair.geometry.edgeGapMm.minimumMm),
        maximumCoupledGapNm: nm(pair.geometry.edgeGapMm.maximumMm), maximumMainLengthNm: nm(launch ? c.maximumLaunchEtchLengthMm : pair.geometry.maxEtchLengthMm),
        // Launch skew has no separate caller budget. Its length cap implies
        // this bound; only the line pair and full channel impose skew limits.
        maximumSkewNm: nm(launch ? c.maximumLaunchEtchLengthMm : pair.geometry.maxEtchSkewMm), maximumStubLengthNm: nm(launch ? 0 : c.maximumBranchEtchLengthMm),
        maximumUncoupledLengthNm: nm(pair.geometry.maxUncoupledLengthMm), transitions: "forbidden", allowedLayers: pair.routing.allowedLayers } });
    return projectionComplete ? g : incompleteDifferentialGeometry(g);
  };
  const launch = evaluate(c.launchNets, roles(pair.endpoints.source), resistor("sourcePin"), [], true);
  const receiverPaths = receivers.map(receiver => {
    const geometry = evaluate(pair.nets, resistor("linePin"), roles(receiver), lineAnchors, false);
    const complete = launch.checks.topology.status === "pass" && geometry.checks.topology.status === "pass";
    const positiveEtchLength = complete ? add(launch.routes.positive.mainLength!, geometry.routes.positive.mainLength!) : null;
    const negativeEtchLength = complete ? add(launch.routes.negative.mainLength!, geometry.routes.negative.mainLength!) : null;
    return { receiver, geometry, positiveEtchLength, negativeEtchLength, etchSkew: complete ? absolute(subtract(positiveEtchLength!, negativeEtchLength!)) : null };
  });
  const views = [launch, ...receiverPaths.map(p => p.geometry)], routes = [launch.routes.positive, launch.routes.negative, receiverPaths[0]!.geometry.routes.positive, receiverPaths[0]!.geometry.routes.negative];
  const copperEtchLength = { positive: routes[0]!.status === "complete_source_tree" && routes[2]!.status === "complete_source_tree" ? add(routes[0]!.totalEtchLength!, routes[2]!.totalEtchLength!) : null,
    negative: routes[1]!.status === "complete_source_tree" && routes[3]!.status === "complete_source_tree" ? add(routes[1]!.totalEtchLength!, routes[3]!.totalEtchLength!) : null };
  const declared = [...launch.sourceRoles, ...receiverPaths[0]!.geometry.sourceRoles].map(role => ({ selector: role.selector, net: role.expectedNet }))
    .concat(receivers.flatMap(receiver => (["positive", "negative"] as const).map(p => ({ selector: selector(receiver[p]), net: pair.nets[p] }))),
      c.protection.flatMap(protection => (["positive", "negative"] as const).flatMap(p => protection[p === "positive" ? "positivePins" : "negativePins"].map(pin => ({ selector: { reference: protection.componentReference, pad: pin }, net: pair.nets[p] })))));
  const anchors = [...new Map(declared.map(a => [`${a.net}:${key(a.selector)}`, a])).values()].map(anchor => {
    const pads = selected.pads.filter(p => key(p) === key(anchor.selector)), route = routes.find(r => r.net === anchor.net);
    const nodes = route?.nodes?.filter(n => n.padUuids.some(uuid => pads.some(p => p.uuid === uuid))) ?? [];
    return { ...anchor, matchingPadUuids: pads.map(p => p.uuid), contactNodeIds: nodes.map(n => n.id),
      status: !projectionComplete ? "not_assessed" as const : pads.length === 1 && pads[0]!.net === anchor.net && route?.status === "complete_source_tree" && nodes.length === 1 ? "pass" as const : "fail" as const };
  });
  const escapes: DifferentialChannelGeometryAssessment["escapes"][number][] = [];
  const widthChecks: DifferentialPairGeometryCheck[] = [];
  for (const route of routes) {
    const netTracks = selected.tracks.filter(t => t.net === route.net);
    // Width upper/floor counterexamples are independent of connectivity.
    if (netTracks.some(t => t.widthNm < 200_000 || t.widthNm > nm(pair.geometry.traceWidthMm.maximumMm))) widthChecks.push(check("fail", "CHANNEL_WIDTH_OUTSIDE_AUTHORIZATION"));
    if (route.status !== "complete_source_tree") { widthChecks.push(check("not_assessed", "ESCAPE_REQUIRES_COMPLETE_TREE")); continue; }
    const distances = c.escapes.flatMap(escape => {
      const terminal = selector(escape.terminal), pads = selected.pads.filter(p => key(p) === key(terminal) && p.net === route.net);
      const nodes = route.nodes!.filter(n => n.padUuids.some(uuid => pads.some(p => p.uuid === uuid)));
      if (pads.length !== 1 || nodes.length !== 1) return [];
      const lengths = new Map<string, Length>([[nodes[0]!.id, zero()]]), pending = [nodes[0]!.id];
      while (pending.length) { const node = pending.pop()!; for (const edge of route.edges!) {
        const next = edge.startNode === node ? edge.endNode : edge.endNode === node ? edge.startNode : null;
        if (next !== null && !lengths.has(next)) { lengths.set(next, add(lengths.get(node)!, edge.length)); pending.push(next); }
      } }
      return [{ escape, terminal, lengths }];
    });
    for (const edge of route.edges!) {
      const body = edge.widthNm >= nm(pair.geometry.traceWidthMm.minimumMm) && edge.widthNm <= nm(pair.geometry.traceWidthMm.maximumMm);
      if (body) { widthChecks.push(check("pass", "BODY_WIDTH_INTERVAL")); continue; }
      const qualifyingTerminals = distances.filter(({ escape, lengths }) => edge.widthNm >= nm(escape.traceWidthMm.minimumMm) && edge.widthNm <= nm(escape.traceWidthMm.maximumMm)
        && [edge.startNode, edge.endNode].every(node => lengths.has(node) && compareDifferentialPairLengths(lengths.get(node)!, limit(escape.maximumRoutedLengthMm)) <= 0)).map(item => item.terminal);
      const status = qualifyingTerminals.length ? "pass" as const : "fail" as const;
      escapes.push({ net: route.net, edgeId: edge.id, widthNm: edge.widthNm, qualifyingTerminals, status });
      widthChecks.push(check(status, "EXACT_TERMINAL_ROUTED_ESCAPE_DISTANCE"));
    }
  }
  // Every graph leaf and multiway junction must be a declared, actually contacted pad.
  const boundedTrees = routes.map(route => {
    if (route.status !== "complete_source_tree") return check("not_assessed", "CHANNEL_TREE_UNAVAILABLE");
    const authorized = new Set(anchors.filter(a => a.net === route.net && a.status === "pass").flatMap(a => a.contactNodeIds));
    const valid = route.nodes!.every(node => { const degree = route.edges!.filter(e => e.startNode === node.id || e.endNode === node.id).length;
      return degree === 2 || authorized.has(node.id); });
    return check(valid ? "pass" : "fail", "ALL_LEAVES_AND_BRANCH_ATTACHMENTS_REQUIRE_DECLARED_PAD_CENTERS");
  });
  const gaps = assessDifferentialTrackGaps(selected.tracks.filter(t => [c.launchNets.positive, pair.nets.positive].includes(t.net)),
    selected.tracks.filter(t => [c.launchNets.negative, pair.nets.negative].includes(t.net)), nm(pair.geometry.edgeGapMm.minimumMm));
  const gapCheck = check(gaps.some(g => g.minimumGap === "fail") ? "fail" : projectionComplete && gaps.length && gaps.every(g => g.minimumGap === "pass") ? "pass" : "not_assessed", "ALL_FOUR_NET_OPPOSITE_POLARITY_CAPSULES");
  const checks = Object.fromEntries(Object.keys(launch.checks).map(name => [name, all(views.map(v => v.checks[name as keyof typeof v.checks]))])) as unknown as DifferentialPairGeometryAssessment["checks"];
  const budgets = { totalCopperLength: all(Object.values(copperEtchLength).map(v => check(v === null ? "not_assessed" : compareDifferentialPairLengths(v, limit(c.maxTotalCopperLengthMm)) <= 0 ? "pass" : "fail", "CHANNEL_TOTAL_COPPER_BUDGET_INCLUDING_BRANCHES"))),
    pathLength: all(receiverPaths.map(p => check(p.positiveEtchLength === null ? "not_assessed" : [p.positiveEtchLength, p.negativeEtchLength!].every(v => compareDifferentialPairLengths(v, limit(c.maxEtchLengthMm)) <= 0) ? "pass" : "fail", "FULL_CHANNEL_COPPER_ONLY_PATH_LENGTH"))),
    pathSkew: all(receiverPaths.map(p => check(p.etchSkew === null ? "not_assessed" : compareDifferentialPairLengths(p.etchSkew, limit(c.maxEtchSkewMm)) <= 0 ? "pass" : "fail", "FULL_CHANNEL_COPPER_ONLY_PATH_SKEW"))) };
  const aggregate = { ...checks, width: all(widthChecks), minimumGap: gapCheck,
    topology: all([checks.topology, ...boundedTrees, ...anchors.map(a => check(a.status, "EVERY_DECLARED_ANCHOR_REACHED"))]),
    length: all([checks.length, budgets.pathLength, budgets.totalCopperLength]), skew: all([checks.skew, budgets.pathSkew]) };
  const signalNets = routes.map(route => route.net);
  if (projectionComplete && selected.pads.some(pad => signalNets.includes(pad.net) && !declared.some(a => key(a.selector) === key(pad) && a.net === pad.net)))
    aggregate.topology = check("fail", "UNDECLARED_SOURCE_SIGNAL_PAD");
  const layers = new Set(selected.tracks.map(t => t.layer));
  if (layers.size > 1) aggregate.transitions = check("fail", "ALL_FOUR_NETS_REQUIRE_ONE_SIGNAL_LAYER");
  return { kind: "source_series", launch, receiverPaths, allTrackPairGaps: gaps, copperEtchLength, budgets, checks: aggregate, anchors, escapes,
    inventoryComplete: projectionComplete && views.every(v => v.inventoryComplete), accepted: false };
}
