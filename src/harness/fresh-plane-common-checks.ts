import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { assertPcbBoardFeatureInventory } from "./pcb-board-features.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { analyzeKicadPcbPractices, PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA, PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  type PcbPracticeAnalysis, type PcbPracticeAnalysisProfile } from "../integrations/pcb-practice-analyzer.js";
import { assertFreshPlaneReferenceCopperScope } from "./fresh-clearance-evidence.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbRouteSourceSpans, parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { isFreshPlaneConnectivityAssessment, type FreshPlaneConnectivityAssessment } from "./fresh-plane-connectivity.js";
import { isSavedFreshPlaneEvidence, type SavedFreshPlaneEvidence } from "./fresh-plane-evidence.js";
import { assertPlaneIncrementalRouteGeometry, planeRouteBinding } from "./fresh-plane-route-mutation.js";
import type { FreshContractPadPosition, FreshRouteSelectionItem } from "./kicad-tools.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { channelForNet, channelTrackWidthAllowed } from "./pcb-channel-width.js";
import { isPcbChannelFeedThroughOutputFork } from "./pcb-channel-feed-through.js";
import { validatedNativePadPositionMm } from "./fresh-route-native-units.js";

export const FRESH_PLANE_COMMON_CHECKS_SCHEMA_VERSION = "evleda.fresh-plane-common-checks.v1" as const;
export const FRESH_PLANE_COMMON_CHECKS_LIMITS = Object.freeze({ maximumPcbBytes: 2 * 1024 * 1024, maximumSegments: 1024,
  maximumVias: 256, maximumPhysicalPads: 512, maximumCoordinateNm: 2_000_000_000 });
export interface FreshPlaneCommonChecksInput {
  readonly compilationBundle: PcbPlaneCompilationBundle;
  readonly savedEvidence: SavedFreshPlaneEvidence;
  readonly pcbSource: string;
  readonly endpointConnectivity: FreshPlaneConnectivityAssessment;
}
export interface FreshPlaneCommonRow {
  readonly id: string;
  readonly kind: "outline" | "via_policy" | "trace_geometry";
  readonly status: "pass" | "fail" | "unknown";
  readonly reasons: readonly string[];
  readonly observations: Readonly<Record<string, unknown>>;
}
export interface FreshPlaneCommonChecksAssessment {
  readonly schemaVersion: typeof FRESH_PLANE_COMMON_CHECKS_SCHEMA_VERSION;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly verificationPlanIdentity: CanonicalIdentity;
  readonly savedEvidenceIdentity: CanonicalIdentity;
  readonly endpointConnectivityIdentity: CanonicalIdentity;
  readonly pcbSourceIdentity: ContentIdentity;
  readonly sourceInventory: Readonly<{ complete: boolean; footprintCount: number; physicalPadCount: number; trackCount: number; viaCount: number; zoneCount: number }>;
  readonly rows: readonly FreshPlaneCommonRow[];
  readonly evidence: Readonly<{ profile: PcbPracticeAnalysisProfile; analysis: PcbPracticeAnalysis | null }>;
  readonly scope: "saved-source-numerical-contract-checks-not-electrical-sizing";
  readonly numericalPolicy: Readonly<{ outlineAndViaDimensions: "exact-integer-nanometres"; traceValidatorToleranceMm: 0.000001 }>;
  readonly notEvaluated: readonly ["trace-connectivity", "drill-clipped-contact-continuity", "plane-access", "placement", "ampacity", "impedance", "manufacturing"];
  readonly accepted: false;
  readonly identity: CanonicalIdentity;
}
const assessments = new WeakSet<object>();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const sorted = (values: readonly string[]) => [...values].sort();
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Plane common checks: ${reason}`); }
const errorText = (error: unknown) => error instanceof Error ? error.message : "Unsupported or unavailable source evidence.";
function exactNm(value: number | string, maximum = 2_000_000_000): number {
  const text = String(value), match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  requireValue(text.length <= 128 && match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "dimension is not a finite decimal");
  const power = 6 + Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  requireValue(Number.isSafeInteger(power) && Math.abs(power) <= 100, "dimension exponent exceeds the exact bound");
  let integer = BigInt(match[2]! + (match[3] ?? ""));
  if (power >= 0) integer *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); requireValue(integer % divisor === 0n, "unsupported dimension: not exactly integer nanometres"); integer /= divisor; }
  if (match[1] === "-") integer = -integer;
  requireValue(integer >= -BigInt(maximum) && integer <= BigInt(maximum), "unsupported dimension: exceeds the exact coordinate bound"); return Number(integer);
}
/** Extraction profile derived directly from V2 values. Advisory output is not an acceptance policy. */
function extractionProfile(bundle: PcbPlaneCompilationBundle): PcbPracticeAnalysisProfile {
  const contract = bundle.contract, policy = contract.routingConstraints.viaPolicy;
  const prefix = "evleda.plane.common-source";
  return freezePcbPlaneArtifact({ schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: { mode: "production", supportedBoardVersions: [...PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS] },
    copperLayerOrder: [...contract.scope.board.copperLayers],
    netClasses: contract.netClasses.map(netClass => ({ id: netClass.id, sourceRuleId: `${prefix}.class.${netClass.id}`,
      severity: "error", minimumTrackWidthMm: netClass.traceWidthMm })),
    netClassByNet: Object.fromEntries(contract.nets.map(net => [net.name, net.netClassId])),
    viaRules: policy.mode === "forbidden" ? [] : [{ id: `${prefix}.via`, sourceRuleId: `${prefix}.via`, severity: "error",
      appliesTo: { netNames: contract.nets.map(net => net.name), viaTypes: ["through"] }, minimumPadDiameterMm: policy.diameterMm,
      minimumDrillDiameterMm: policy.drillMm, minimumAnnularRingMm: policy.minimumAnnularRingMm,
      allowedLayerTransitions: [{ startLayer: "F.Cu", endLayer: "B.Cu" }] }],
    advisories: { rightAngle: { sourceRuleId: prefix, toleranceDeg: 0 }, reversal: { sourceRuleId: prefix, maximumInteriorAngleDeg: 0 },
      adjacentHairpin: { sourceRuleId: prefix, parallelToleranceDeg: 0, maximumLegEdgeGapMm: 0, minimumParallelOverlapMm: 0, maximumConnectorPathLengthMm: 0 } },
    diagnostics: { invalidGeometrySourceRuleId: prefix, unboundNetSourceRuleId: prefix, unsupportedOutlineSourceRuleId: prefix,
      unsupportedRoutingSourceRuleId: prefix, junctionCoverageSourceRuleId: prefix, containmentSourceRuleId: prefix, duplicateTrackSourceRuleId: prefix },
    coordinateToleranceMm: 0.000000001 });
}

/** Structural token check on already parsed complete footprint spans. Quoted
 * property text is one token, so text resembling an S-expression is not geometry. */
function containsOutlineLayer(source: string): boolean {
  const tokens = [...source.matchAll(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/gu)].map(match => match[0]);
  const decode = (token: string) => token.startsWith('"') ? token.slice(1, -1).replace(/\\(.)/gu, "$1") : token;
  return tokens.some((token, index) => token === "(" && tokens[index + 1] === "layer"
    && tokens[index + 2] !== undefined && decode(tokens[index + 2]!) === "Edge.Cuts");
}
function outlineRow(bundle: PcbPlaneCompilationBundle, source: string, analysis: PcbPracticeAnalysis, nestedOutline: boolean): FreshPlaneCommonRow {
  const edges = analysis.extracted.boardEdges, widthNm = exactNm(bundle.contract.scope.board.widthMm), heightNm = exactNm(bundle.contract.scope.board.heightMm);
  const observations = { completeAnalyzedOutline: analysis.summary.outlineComplete, primitiveCount: edges.length,
    sourcePrimitiveKinds: [...new Set(edges.map(edge => edge.evidence.form))], footprintLocalOutlineContributors: nestedOutline, widthNm, heightNm };
  if (nestedOutline || !analysis.summary.outlineComplete || edges.length !== 4 || edges.some(edge => edge.kind !== "line" || edge.start === null || edge.end === null)) {
    return { id: "board:outline", kind: "outline", status: "fail", reasons: ["A complete four-line rectangle is required; missing, additional, curved or unclosed outline geometry cannot be discarded."], observations };
  }
  // The existing analyzer supplies complete structural extraction. Check its
  // source numeric atoms as well so binary64 underflow cannot hide sub-nm data.
  for (const fragment of new Set(edges.map(edge => source.slice(edge.evidence.startOffset, edge.evidence.endOffset)))) {
    for (const token of fragment.matchAll(/"(?:\\.|[^"\\])*"|[^\s()]+/gu)) {
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token[0])) exactNm(token[0]);
    }
  }
  const key = (a: readonly number[], b: readonly number[]) => sorted([a.join(","), b.join(",")]).join(";");
  const corners = [[0, 0], [widthNm, 0], [widthNm, heightNm], [0, heightNm]];
  const expected = corners.map((corner, i) => key(corner, corners[(i + 1) % 4]!));
  const actual = edges.map(edge => key([exactNm(edge.start!.x), exactNm(edge.start!.y)], [exactNm(edge.end!.x), exactNm(edge.end!.y)]));
  const matches = same(sorted(actual), sorted(expected));
  return { id: "board:outline", kind: "outline", status: matches ? "pass" : "fail",
    reasons: [matches ? "The complete extracted edges are exactly the declared rectangle at (0,0), with the verified two-layer source scope."
      : "The complete outline edge set differs from the exact declared rectangle, origin or dimensions."], observations: { ...observations, edgeKeysNm: actual } };
}

/** Exact dimensions and budget checks on the complete source via inventory. */
function viaRow(bundle: PcbPlaneCompilationBundle, netName: string, board: ReturnType<typeof parseFreshPcbSource>, analysis: PcbPracticeAnalysis): FreshPlaneCommonRow {
  const { netClass, access, route } = planeRouteBinding(bundle.contract, netName), policy = bundle.contract.routingConstraints.viaPolicy;
  const vias = board.vias.filter(via => via.netName === netName), issues: string[] = [];
  if (board.vias.length > policy.maxTotal) issues.push("The complete routed-via count exceeds the global budget.");
  if (vias.length > access.maxVias) issues.push("This net exceeds its explicit routed-via budget.");
  if (route.topology !== "plane" && route.referencePath.mode === "continuous_plane" && vias.length) issues.push("The referenced signal net contains a forbidden layer transition.");
  const dimensions = vias.map(via => {
    const diameterNm = exactNm(via.diameterMm), drillNm = exactNm(via.drillMm), xNm = exactNm(via.at.x), yNm = exactNm(via.at.y);
    if (policy.mode === "forbidden") issues.push("The contract forbids routed vias.");
    else if (diameterNm < exactNm(policy.diameterMm) || drillNm < exactNm(policy.drillMm)
        || diameterNm - drillNm < 2 * exactNm(policy.minimumAnnularRingMm)) issues.push(`Via ${via.id} violates an exact diameter, drill or annular-ring requirement.`);
    if (!same(via.layers, ["F.Cu", "B.Cu"]) || via.layers.some(layer => !netClass.allowedLayers.includes(layer as "F.Cu" | "B.Cu"))) issues.push(`Via ${via.id} has a forbidden or unsupported layer span.`);
    const edgeNm = exactNm(netClass.copperToEdgeMm), w = exactNm(bundle.contract.scope.board.widthMm), h = exactNm(bundle.contract.scope.board.heightMm);
    if (2 * xNm - diameterNm < 2 * edgeNm || 2 * yNm - diameterNm < 2 * edgeNm || 2 * (w - xNm) - diameterNm < 2 * edgeNm || 2 * (h - yNm) - diameterNm < 2 * edgeNm) issues.push(`Via ${via.id} violates the explicit copper-to-edge distance.`);
    return { uuid: via.id, diameterNm, drillNm, annularRingTwiceNm: diameterNm - drillNm, xNm, yNm, layers: via.layers };
  });
  const observed = analysis.extracted.vias.filter(via => via.netName === netName);
  requireValue(observed.length === vias.length && observed.every(via => via.type === "through" && vias.some(source => source.id === via.uuid)), "native-source analyzer omitted or retyped a via");
  return { id: `vias:${netName}`, kind: "via_policy", status: issues.length ? "fail" : "pass",
    reasons: issues.length ? [...new Set(issues)] : ["Every exact saved through-via satisfies the declared per-net and global budgets, dimensions, layer span and edge bound."],
    observations: { net: netName, viaCount: vias.length, globalViaCount: board.vias.length, perNetMaximum: access.maxVias, globalMaximum: policy.maxTotal,
      footprintDrillsAreNotRoutedVias: true, dimensions } };
}

/** No CAD calls or filesystem reads. The owning host keeps all current source/session guards active. */
export function assessFreshPlaneCommonChecks(input: FreshPlaneCommonChecksInput): FreshPlaneCommonChecksAssessment {
  const { compilationBundle: bundle, savedEvidence: saved, pcbSource, endpointConnectivity: endpoint } = input;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle) && isSavedFreshPlaneEvidence(saved) && isFreshPlaneConnectivityAssessment(endpoint), "original V2, saved-fill and native endpoint authorities are required");
  const sourceIdentity = contentIdentity(pcbSource);
  requireValue(same(saved.bundleIdentity, bundle.identity) && same(saved.contractIdentity, bundle.contract.identity) && same(saved.verificationPlanIdentity, bundle.verificationPlan.identity)
    && same(saved.savedPcbIdentity, sourceIdentity) && same(endpoint.savedSourceIdentity, sourceIdentity) && same(endpoint.bundleIdentity, bundle.identity)
    && same(endpoint.contractIdentity, bundle.contract.identity) && same(endpoint.verificationPlanIdentity, bundle.verificationPlan.identity)
    && same(endpoint.hostScopeIdentity, saved.sourceScopeIdentity), "the current source or V2 evidence identities disagree");
  requireValue(same(endpoint.nativeSourceIdentity, sourceIdentity) || same(endpoint.nativeSourceIdentity, contentIdentity(saved.stage.nativeSourceStaged)), "native endpoint source is not an authenticated saved or staged serialization");
  const profile = extractionProfile(bundle), rows: FreshPlaneCommonRow[] = bundle.verificationPlan.requirements.filter(row => row.kind === "outline" || row.kind === "via_policy" || row.kind === "trace_geometry")
    .map(row => ({ id: row.id, kind: row.kind as FreshPlaneCommonRow["kind"], status: "unknown", reasons: ["Complete common source evidence is unavailable."], observations: {} }));
  let analysis: PcbPracticeAnalysis | null = null, sourceInventory = { complete: false, footprintCount: 0, physicalPadCount: 0, trackCount: 0, viaCount: 0, zoneCount: 0 };
  const put = (row: FreshPlaneCommonRow) => { const index = rows.findIndex(entry => entry.id === row.id); requireValue(index >= 0 && rows[index]!.kind === row.kind, "check does not name an original V2 row"); rows[index] = row; };
  const finish = (): FreshPlaneCommonChecksAssessment => {
    const body = { schemaVersion: FRESH_PLANE_COMMON_CHECKS_SCHEMA_VERSION, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
      verificationPlanIdentity: bundle.verificationPlan.identity, savedEvidenceIdentity: saved.identity, endpointConnectivityIdentity: endpoint.identity,
      pcbSourceIdentity: sourceIdentity, sourceInventory, rows, evidence: { profile, analysis },
      scope: "saved-source-numerical-contract-checks-not-electrical-sizing" as const,
      numericalPolicy: { outlineAndViaDimensions: "exact-integer-nanometres" as const, traceValidatorToleranceMm: 0.000001 as const },
      notEvaluated: ["trace-connectivity", "drill-clipped-contact-continuity", "plane-access", "placement", "ampacity", "impedance", "manufacturing"] as const, accepted: false as const };
    const result: FreshPlaneCommonChecksAssessment = { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
    // Freeze in place while preserving the analyzer's existing tuple types.
    freezePcbPlaneArtifact(result); assessments.add(result); return result;
  };
  try {
    requireValue(sourceIdentity.size <= FRESH_PLANE_COMMON_CHECKS_LIMITS.maximumPcbBytes, "PCB exceeds the common source byte bound");
    const board = parseFreshPcbSource(pcbSource), reference = parseFreshPcbReferenceGeometry(pcbSource), spans = parseFreshPcbRouteSourceSpans(pcbSource);
    assertFreshPlaneReferenceCopperScope(pcbSource);
    const pads = board.footprints.flatMap(fp => fp.pads), native = saved.stage.nativePads.inventory;
    sourceInventory = { complete: false, footprintCount: board.footprints.length, physicalPadCount: pads.length, trackCount: board.segments.length, viaCount: board.vias.length, zoneCount: reference.zones.length };
    requireValue(board.segments.length <= FRESH_PLANE_COMMON_CHECKS_LIMITS.maximumSegments && board.vias.length <= FRESH_PLANE_COMMON_CHECKS_LIMITS.maximumVias && pads.length <= FRESH_PLANE_COMMON_CHECKS_LIMITS.maximumPhysicalPads, "source inventory exceeds common-check work bounds; no items were truncated");
    requireValue(reference.issues.length === 0 && reference.zones.every(zone => zone.status === "supported" && zone.kind === "copper"), "unknown or unsupported copper or rule geometry cannot be omitted");
    const viaSpans = spans.filter(span => span.kind === "via");
    requireValue(reference.unsupportedRouteItems.length === viaSpans.length && viaSpans.length === board.vias.length
      && reference.unsupportedRouteItems.every(item => item.kind === "via" && viaSpans.filter(span => pcbSource.slice(span.start, span.end) === item.source).length === 1), "unsupported route geometry has no exact characterized source span");
    requireValue(same(sorted(reference.zones.map(zone => zone.uuid!)), sorted(saved.stage.nativeFilledZones.map(zone => zone.uuid))), "source and staged zone inventories differ");
    assertPcbBoardFeatureInventory(bundle.contract, board, pcbSource);
    requireValue(board.footprints.every(fp => [...bundle.contract.components, ...(bundle.contract.boardFeatures ?? [])].some(component => component.reference === fp.reference && component.footprintLibId === fp.libraryId)), "source component and qualified-library inventory differs from V2");
    requireValue(native !== null && native.unsupportedPhysicalUuids.length === 0 && same(sorted(native.physicalPads.map(pad => pad.uuid)), sorted(pads.map(pad => pad.physical.id!)))
      && same(saved.stage.nativePads.physicalLibraryBindings, endpoint.physicalLibraryBindings), "complete supported source and native PAD and library evidence is required");
    const netNames = new Set(bundle.contract.nets.map(net => net.name));
    requireValue([...board.segments, ...board.vias].every(item => item.netName !== null && netNames.has(item.netName)), "uncontracted routed copper is present");
    analysis = analyzeKicadPcbPractices(pcbSource, profile, { sourcePath: "<current-v2-pcb>" });
    requireValue(analysis.extracted.routedArcs.length === 0 && same(sorted(analysis.extracted.segments.map(item => item.uuid!)), sorted(board.segments.map(item => item.id!)))
      && same(sorted(analysis.extracted.vias.map(item => item.uuid!)), sorted(board.vias.map(item => item.id!))), "complete analyzer route inventory differs from exact source spans");
    sourceInventory.complete = true;
    // The generic analyzer's aggregate pass/fail is deliberately not an
    // acceptance result; each original V2 row has its own complete check.
    const nestedOutline = reference.otherObservations.some(item => item.kind === "footprint" && containsOutlineLayer(item.source));
    put(outlineRow(bundle, pcbSource, analysis, nestedOutline));
    for (const route of bundle.contract.routingConstraints.nets) put(viaRow(bundle, route.net, board, analysis));
    const items: FreshRouteSelectionItem[] = [...board.segments.map(track => ({ kind: "track" as const, id: track.id!, net: track.netName!,
      start: { xMm: track.start.x, yMm: track.start.y }, end: { xMm: track.end.x, yMm: track.end.y }, widthMm: track.widthMm, layer: track.layer })),
    ...board.vias.map(via => ({ kind: "via" as const, id: via.id!, net: via.netName!, at: { xMm: via.at.x, yMm: via.at.y }, diameterMm: via.diameterMm, drillMm: via.drillMm, layers: via.layers }))];
    const positions: FreshContractPadPosition[] = board.footprints.flatMap(fp => fp.pads.flatMap(pad => {
      const observed = native.physicalPads.find(value => value.uuid === pad.physical.id)!;
      if (observed.role !== "numbered-copper" || observed.issues.length || observed.observedUsableCopperLayers === null || pad.physical.sizeMm === null || fp.id === null || pad.physical.id === null || pad.physical.padType === null || pad.physical.shape === null) return [];
      return [{ reference: fp.reference, pad: pad.number, net: pad.netName, ...validatedNativePadPositionMm(observed.rawNative),
        layers: observed.observedUsableCopperLayers.map(layer => layer.replace(/^BL_/u, "").replaceAll("_", ".")),
        physical: { id: pad.physical.id, footprintId: fp.id, padType: pad.physical.padType, shape: pad.physical.shape, sizeMm: pad.physical.sizeMm, drill: pad.physical.drill } }];
    }));
    for (const route of bundle.contract.routingConstraints.nets) if (route.topology !== "plane") {
      const tracks = board.segments.filter(track => track.netName === route.net), netClass = bundle.contract.netClasses.find(netClass => netClass.id === bundle.contract.nets.find(net => net.name === route.net)!.netClassId)!;
      let status: FreshPlaneCommonRow["status"] = "unknown", reasons = ["No saved width-bearing trace geometry exists for this declared route."];
      if (tracks.length) try {
        const trackIds = new Set(tracks.map(track => track.id));
        requireValue(!analysis.findings.some(finding => ["DUPLICATE_ROUTED_TRACK", "OVERLAPPING_ROUTED_TRACKS"].includes(finding.code)
          && finding.evidence.some(entry => entry.location.form === "segment" && trackIds.has(entry.location.uuid))),
        "complete source analysis reports duplicate or overlapping copper tracks; physical PAD contacts cannot exempt overlap");
        requireValue(tracks.every(track => channelForNet(bundle.contract, route.net)
          ? channelTrackWidthAllowed(bundle.contract, route.net, track.widthMm) : exactNm(track.widthMm) >= exactNm(netClass.traceWidthMm)), "a saved track is outside its exact declared width authorization");
        const vectors = tracks.map(track => {
          const dx = Math.abs(exactNm(track.end.x) - exactNm(track.start.x)), dy = Math.abs(exactNm(track.end.y) - exactNm(track.start.y));
          return { dx: BigInt(dx), dy: BigInt(dy) };
        });
        requireValue(vectors.every(vector => vector.dx === 0n || vector.dy === 0n || vector.dx === vector.dy),
          "unsupported source orientation: exact horizontal, vertical or 45-degree segments are required by this bounded evaluator, not inferred as a universal routing rule");
        // In this explicit source scope, track length is a + b*sqrt(2). Compare
        // the squared nonnegative remainder, without enlarging a declared bound.
        if (route.routeLength.mode === "bounded") {
          const axis = vectors.reduce((sum, v) => sum + (v.dx === 0n || v.dy === 0n ? v.dx + v.dy : 0n), 0n);
          const diagonal = vectors.reduce((sum, v) => sum + (v.dx !== 0n && v.dy !== 0n ? v.dx : 0n), 0n);
          const remaining = BigInt(exactNm(route.routeLength.maximumMm, 5_000_000_000)) - axis;
          requireValue(remaining >= 0n && 2n * diagonal * diagonal <= remaining * remaining, "saved tracks exceed the exact declared route-length bound");
        }
        const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
        for (const turn of analysis.extracted.turns.filter(turn => turn.netName === route.net)) {
          if (isPcbChannelFeedThroughOutputFork(bundle.contract, route.net, { xMm: turn.vertex.x, yMm: turn.vertex.y }, turn.layer, positions)) continue;
          const pivot = [exactNm(turn.vertex.x), exactNm(turn.vertex.y)];
          const legs = turn.segmentOrdinals.map(ordinal => {
            const segment = analysis!.extracted.segments.find(segment => segment.ordinal === ordinal)!;
            const a = [exactNm(segment.start.x), exactNm(segment.start.y)], b = [exactNm(segment.end.x), exactNm(segment.end.y)];
            requireValue(same(pivot, a) || same(pivot, b), "unsupported turn without an exact source endpoint");
            const other = same(pivot, a) ? b : a, dx = other[0]! - pivot[0]!, dy = other[1]! - pivot[1]!;
            return { index: directions.findIndex(([x, y]) => x === Math.sign(dx) && y === Math.sign(dy)), lengthSquared: BigInt(dx) ** 2n + BigInt(dy) ** 2n };
          });
          requireValue(legs.every(leg => leg.index >= 0), "unsupported source direction at a turn");
          const difference = Math.abs(legs[0]!.index - legs[1]!.index), angle = 180 - 45 * Math.min(difference, 8 - difference);
          requireValue(angle <= bundle.contract.routingConstraints.maximumTurnAngleDeg, "source grid turn exceeds the exact declared angle bound");
          if (angle > 0) requireValue(legs.every(leg => leg.lengthSquared >= BigInt(exactNm(bundle.contract.routingConstraints.minimumStraightBeforeTurnMm)) ** 2n),
            "source leg is below the exact minimum straight length before a turn");
        }
        assertPlaneIncrementalRouteGeometry(bundle.contract, route.net, items, positions);
        status = "pass"; reasons = ["Complete saved tracks satisfy the existing V2 numerical width, layer, length, turn and intersection checks; connectivity and drill-clipped contacts are separate."];
      } catch (error) { const reason = errorText(error); status = /unsupported|uncharacterized/iu.test(reason) ? "unknown" : "fail"; reasons = [reason]; }
      put({ id: `trace-geometry:${route.net}`, kind: "trace_geometry", status, reasons,
        observations: { net: route.net, trackUuids: tracks.map(track => track.id), fullRouteInventorySupplied: true, padExemptionsSource: "current-source-and-qualified-native-pad-inventory", numericalToleranceMm: 0.000001 } });
    }
  } catch (error) {
    for (const row of rows) put({ ...row, status: "unknown", reasons: [errorText(error)], observations: {} });
  }
  return finish();
}
export function isFreshPlaneCommonChecksAssessment(value: unknown): value is FreshPlaneCommonChecksAssessment {
  return value !== null && typeof value === "object" && assessments.has(value);
}
