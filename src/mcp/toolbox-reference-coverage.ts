import { z } from "zod";
import { canonicalJson } from "../core/canonical.js";
import { parseFreshPcbReferenceGeometry } from "../harness/fresh-kicad-parser.js";
import { createKicadSavedSourceReader } from "../integrations/kicad-saved-source.js";
import { referenceCoverageRequestSchema, type ReferenceCoverageCalculator, type ReferenceCoverageRequest } from "../integrations/kicad-reference-coverage.js";

const net = z.string().min(1).max(128);
const layer = z.string().regex(/^(?:F|B|In[1-9][0-9]*)\.Cu$/u);
export const toolboxReferenceCoverageQuerySchema = z.object({
  signalNets: z.array(net).min(1).max(16), signalLayer: layer,
  referenceNet: net, referenceLayer: layer,
  zoneIds: z.array(z.string().uuid()).min(1).max(32).optional(),
  segmentIds: z.array(z.string().uuid()).min(1).max(64).optional(),
  marginNm: z.number().int().min(0).max(50_000_000).describe("Explicit geometric margin beyond the trace edge, integer nm; 100000 nm is 0.1 mm. Supports the plane contract's 0–50 mm range; no electrical default is supplied."),
  marginBasis: z.string().trim().min(1).max(1024).describe("Caller-stated source/reason for this margin; retained, not independently approved"),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().superRefine((request, ctx) => {
  for (const values of [request.signalNets, request.zoneIds, request.segmentIds]) {
    if (values !== undefined && new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Selection arrays must not contain duplicates." });
  }
  if (request.signalLayer === request.referenceLayer) ctx.addIssue({ code: "custom", message: "This projection checks a distinct reference copper layer, not coplanar ground." });
});
export type ToolboxReferenceCoverageQuery = z.infer<typeof toolboxReferenceCoverageQuerySchema>;

/** Inspect current SAVED segment and zone-fill geometry, never model-supplied geometry. */
export async function createToolboxReferenceCoverage(input: { readonly pcbPath: string; readonly calculator: ReferenceCoverageCalculator }) {
  const observe = await createKicadSavedSourceReader({ pcbPath: input.pcbPath });
  const calculator = input.calculator;
  return async (argument: unknown) => {
    const query = toolboxReferenceCoverageQuerySchema.parse(argument);
    const before = await observe(parseFreshPcbReferenceGeometry);
    if (query.expectedSourceSha256 !== undefined && query.expectedSourceSha256 !== before.sourceIdentity.digest) throw new Error("Saved PCB differs from the selected source revision; inspect it again.");
    if (canonicalJson(before.value.sourceIdentity) !== canonicalJson(before.sourceIdentity)) throw new Error("Reference parser/source identities disagree.");
    const source = before.value;
    const matchingSegments = source.segments.filter(segment => query.signalNets.includes(segment.netName ?? "") && segment.layer === query.signalLayer);
    const selectedSegments = query.segmentIds === undefined ? matchingSegments : matchingSegments.filter(segment => query.segmentIds!.includes(segment.uuid));
    const matchingZones = source.zones.filter(zone => zone.netName === query.referenceNet && zone.layers.includes(query.referenceLayer) && zone.kind === "copper");
    const selectedZones = query.zoneIds === undefined ? matchingZones : matchingZones.filter(zone => query.zoneIds!.includes(zone.uuid ?? ""));
    const base = {
      schemaVersion: "evleda.toolbox-reference-coverage.v1" as const, sourceIdentity: before.sourceIdentity, request: query,
      scope: "Projected Euclidean ribbons of selected saved straight segments against selected saved copper-zone fill caches only.",
      selectedSegments: selectedSegments.map(({ source: _source, ...segment }) => segment),
      selectedZones: selectedZones.map(zone => ({ uuid: zone.uuid, netName: zone.netName, layers: zone.layers, status: zone.status,
        sourceIdentity: zone.sourceIdentity, filledCachePresent: zone.filledCachePresent,
        fillGroups: zone.filledPolygons.map(group => ({ index: group.index, layer: group.layer, status: group.status, islandFlag: group.islandFlag })) })),
      selectionCoverage: { allMatchingStraightSegmentsSelected: selectedSegments.length === matchingSegments.length,
        allMatchingZonesSelected: selectedZones.length === matchingZones.length,
        inventory: "supported_saved_straight_segments_and_declared_copper_zones" as const,
        omittedMatchingSegmentIds: matchingSegments.filter(segment => !selectedSegments.includes(segment)).map(segment => segment.uuid),
        omittedMatchingZoneIds: matchingZones.filter(zone => !selectedZones.includes(zone)).map(zone => zone.uuid), fullBoardGeometry: false },
      unmodeledSource: { issues: source.issues,
        routeItems: source.unsupportedRouteItems.map(({ source: _source, ...observation }) => observation),
        otherItems: source.otherObservations.map(({ source: _source, ...observation }) => observation) },
      evidenceStatus: { fillFreshness: "unverified_saved_cache" as const, dcConnectivity: "not_evaluated" as const,
        referenceCopperEligibility: "selected_by_declared_net_and_layer_only" as const,
        stackupAndLayerAdjacency: "not_evaluated" as const, marginBasis: "caller_stated_not_approved" as const,
        impedance: "not_evaluated" as const, highFrequencyValidity: "not_established" as const },
      limitations: [
        "A geometric certificate applies only to the selected saved fill data. Cached polygons and a shared net name do not prove current fill, electrical connection or reference eligibility.",
        "The margin is explicitly beyond the trace edge. No universal margin or board-level impedance/return-path approval is inferred.",
        "Uncovered outer-envelope polygons are diagnostic conservative geometry, not the exact missing area of the physical rounded trace ribbon.",
        "Footprint-local copper, vias, arcs, transitions, launch exceptions and unselected routes are not certified by this straight-segment projection.",
        "Native fresh fill and individual-terminal connectivity evidence are separate requirements before accepting a reference path.",
      ],
    };
    const notAssessed = (reason: string) => ({ ...base, status: "not_assessed" as const, reason, geometricStatus: "not_assessed" as const });
    if (query.segmentIds !== undefined && selectedSegments.length !== query.segmentIds.length) return notAssessed("A requested segment does not belong to the selected saved nets/layer.");
    if (query.zoneIds !== undefined && selectedZones.length !== query.zoneIds.length) return notAssessed("A requested zone does not belong to the selected saved reference net/layer.");
    if (selectedSegments.length === 0 || query.signalNets.some(name => !selectedSegments.some(segment => segment.netName === name))) return notAssessed("No supported selected segment exists for one or more requested signal nets.");
    if (selectedSegments.length > 64) return { ...notAssessed("Select at most 64 segment IDs per calculation; no segment was truncated into a pass."), status: "selection_required" as const };
    if (selectedZones.length === 0) return notAssessed("No matching saved copper-zone fill is available.");
    if (selectedZones.length > 32) return { ...notAssessed("Select at most 32 zone IDs per calculation; no zone was truncated into a pass."), status: "selection_required" as const };
    const groups: ReferenceCoverageRequest["groups"] = [];
    for (const zone of selectedZones) {
      if (zone.status !== "supported" || zone.uuid === null) return notAssessed("Selected zone source contains unsupported or ambiguous settings/geometry.");
      const fills = zone.filledPolygons.filter(group => group.layer === query.referenceLayer);
      if (!zone.filledCachePresent || fills.length === 0) return notAssessed("A selected zone has no interpretable saved fill on the reference layer; empty/missing cache is not a freshness receipt.");
      for (const group of fills) {
        // Saved filled_polygon has one ordered fractured contour. Repeated pts
        // forms are not assumed to mean explicit holes without source evidence.
        if (group.status !== "supported" || group.contourGroup.length !== 1 || group.contourGroup[0]!.status !== "supported"
            || group.contourGroup[0]!.pointsNm === null) return notAssessed("A selected saved fill group cannot be interpreted without discarding source information.");
        const points = group.contourGroup[0]!.pointsNm!;
        groups.push({ rings: [points.map(point => [point.x, point.y])] });
      }
    }
    const request = referenceCoverageRequestSchema.safeParse({ groups, routes: selectedSegments.map(segment => ({ x1Nm: segment.startNm.x, y1Nm: segment.startNm.y,
      x2Nm: segment.endNm.x, y2Nm: segment.endNm.y, widthNm: segment.widthNm, marginNm: query.marginNm })) });
    if (!request.success) return notAssessed("Selected saved geometry is outside the calculator's supported integer-coordinate, contour, or workload bounds; no geometry was discarded.");
    const calculation = await calculator.calculate(request.data);
    const after = await observe(() => null);
    if (canonicalJson(before.sourceIdentity) !== canonicalJson(after.sourceIdentity)) throw new Error("Saved PCB changed during reference coverage calculation; discard this result.");
    if (calculation === null || !Array.isArray(calculation.routes) || calculation.routes.length !== selectedSegments.length
        || calculation.coordinateUnit !== "nm" || calculation.dcConnectivityClaimed !== false || calculation.hfElectricalValidityClaimed !== false) {
      throw new Error("Reference coverage calculator did not return one scoped geometric result per selected segment.");
    }
    for (const [index, route] of calculation.routes.entries()) {
      const expectedCertificate = route.status === "covered" ? "exact_outer_envelope_containment"
        : route.status === "uncovered" ? "exact_inner_envelope_outside_witness"
          : route.status === "boundary_uncertain" ? "no_exact_certificate" : null;
      if (route.routeIndex !== index || expectedCertificate === null || route.certificate !== expectedCertificate) throw new Error("Reference coverage calculator route indices or geometric statuses are inconsistent.");
    }
    const geometricStatus = calculation.routes.some(route => route.status === "uncovered") ? "uncovered"
      : calculation.routes.some(route => route.status === "boundary_uncertain") ? "boundary_uncertain" : "covered";
    return { ...base, status: "computed" as const, geometricStatus,
      routeResults: calculation.routes.map(route => ({ ...route, segmentId: selectedSegments[route.routeIndex]!.uuid,
        netName: selectedSegments[route.routeIndex]!.netName })),
      calculation: { implementationRevision: calculation.implementationRevision, sourceCommit: calculation.sourceCommit,
        clipperVersion: calculation.clipperVersion, executableIdentity: calculation.executableIdentity,
        diagnosticGeometry: calculation.diagnosticGeometry, envelopeModel: calculation.envelopeModel,
        coverageMeaning: calculation.coverageMeaning, artifacts: calculation.artifacts }, sourceUnchanged: true };
  };
}
export type ToolboxReferenceCoverage = Awaited<ReturnType<typeof createToolboxReferenceCoverage>>;
