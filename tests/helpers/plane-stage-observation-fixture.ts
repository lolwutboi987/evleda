/** Synthetic offline producer-shaped receipts; never native evidence. */
import path from "node:path";
import { contentIdentity } from "../../src/core/canonical.js";
import { parseFreshPcbDirectZoneSourceSpans, parseFreshPcbReferenceGeometry } from "../../src/harness/fresh-kicad-parser.js";
import type { KicadPlaneStageInput, PlaneRectangleMutation } from "../../src/integrations/kicad-plane-stage.js";
import { nativePadObservationFixture } from "./native-pad-observation-fixture.js";

type Raw = Record<string, any>;
const COMMON = "kiapi.common.commands.", BOARD = "kiapi.board.commands.", TYPE = "type.googleapis.com/kiapi.board.types.";
const decimal = (value: bigint, scale: number) => { const text = value.toString().padStart(scale + 1, "0"), fraction = text.slice(-scale).replace(/0+$/u, ""); return text.slice(0, -scale) + (fraction ? "." + fraction : ""); };
const mm = (nm: number) => decimal(BigInt(nm), 6);
function targetProto(m: PlaneRectangleMutation, uuid: string, old?: Raw): Raw {
  const r = m.rectangleNm, raw: Raw = old ? structuredClone(old) : { type: "ZT_COPPER", copper_settings: { connection: { thermal_spokes: { gap: {}, width: {} } },
    hatch_settings: { thickness: {}, gap: {}, orientation: {}, border_mode: "ZHFBM_USE_MIN_ZONE_THICKNESS" }, teardrop: { type: "TDT_NONE" } }, border: { style: "ZBS_DIAGONAL_EDGE", pitch: { value_nm: "500000" } } };
  raw.id = { value: uuid }; raw.name = m.name; raw.layers = [`BL_${m.layer.replace(".","_")}`];
  if (m.priority) raw.priority = m.priority; else delete raw.priority;
  raw.outline = { polygons: [{ outline: { closed: true, nodes: [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]].map(([x, y]) => ({ point: { x_nm: String(x), y_nm: String(y) } })) } }] };
  const settings = raw.copper_settings; settings.net = { name: m.netName }; settings.clearance = { value_nm: String(m.clearanceNm) }; settings.min_thickness = { value_nm: String(m.minWidthNm) };
  settings.fill_mode = "ZFM_SOLID"; settings.island_mode = { always: "IRM_ALWAYS", never: "IRM_NEVER", area: "IRM_AREA" }[m.islandPolicy];
  if (m.islandPolicy === "area") settings.min_island_area = m.minIslandAreaNm2;
  settings.connection.zone_connection = m.connection === "thermal" ? "ZCS_THERMAL" : "ZCS_FULL";
  if (m.connection === "thermal") { settings.connection.thermal_spokes.gap = { value_nm: String(m.thermalGapNm) }; settings.connection.thermal_spokes.width = { value_nm: String(m.thermalSpokeWidthNm) }; }
  delete raw.filled; raw.filled_polygons = [{ layer: raw.layers[0], shapes: {} }]; return raw;
}
function targetSource(m: PlaneRectangleMutation, raw: Raw, filledContoursNm?: readonly (readonly (readonly [number, number])[])[]): string {
  const r = m.rectangleNm, points = `(xy ${mm(r.x1)} ${mm(r.y1)}) (xy ${mm(r.x2)} ${mm(r.y1)}) (xy ${mm(r.x2)} ${mm(r.y2)}) (xy ${mm(r.x1)} ${mm(r.y2)})`;
  const thermal = raw.copper_settings.connection.thermal_spokes;
  const style = ({ ZBS_DIAGONAL_EDGE: "edge", ZBS_DIAGONAL_FULL: "full", ZBS_SOLID: "none" } as Raw)[raw.border.style];
  return `(zone (net ${JSON.stringify(m.netName)}) (layer ${JSON.stringify(m.layer)}) (uuid "${raw.id.value}") (name ${JSON.stringify(m.name)})
    (hatch ${style} ${mm(Number(raw.border.pitch.value_nm ?? 0))}) ${m.priority ? `(priority ${m.priority})` : ""}
    (connect_pads ${m.connection === "full" ? "yes" : ""} (clearance ${mm(m.clearanceNm)})) (min_thickness ${mm(m.minWidthNm)})
    (fill yes (thermal_gap ${mm(Number(thermal.gap.value_nm ?? 0))}) (thermal_bridge_width ${mm(Number(thermal.width.value_nm ?? 0))})
      (island_removal_mode ${{ always: 0, never: 1, area: 2 }[m.islandPolicy]}) ${m.islandPolicy === "area" ? `(island_area_min ${decimal(BigInt(m.minIslandAreaNm2), 12)})` : ""})
    (polygon (pts ${points})) ${filledContoursNm === undefined ? `(filled_polygon (layer ${JSON.stringify(m.layer)}) (pts ${points}))`
      : filledContoursNm.map(ring => `(filled_polygon (layer ${JSON.stringify(m.layer)}) (pts ${ring.map(([x,y])=>`(xy ${mm(x)} ${mm(y)})`).join(" ")}))`).join(" ")})`;
}
const inventory = (raws: Raw[]) => raws.map(raw => {
  const filledPolygons = Object.fromEntries(raw.filled_polygons.map((entry: Raw) => [entry.layer, entry.shapes.polygons ?? []]));
  const polys = Object.values(filledPolygons).flat() as Raw[];
  return { uuid: raw.id.value, filled: raw.filled ?? false, raw, filledPolygons,
    fillCounts: { layerCount: Object.keys(filledPolygons).length, polygonCount: polys.length, typedHoleCount: polys.reduce((n, p) => n + (p.holes?.length ?? 0), 0), outlineNodeCount: polys.reduce((n, p) => n + p.outline.nodes.length, 0) } };
});

export async function planeStageObservationFixture(input: { beforePcbSource: string; mutation?: PlaneRectangleMutation; request?: KicadPlaneStageInput; zoneId?: string; beforeZoneProtos?: readonly Raw[]; boardPath?: string;
  filledContoursNm?: readonly (readonly (readonly [number, number])[])[] }) {
  const before = input.beforePcbSource, m = input.request?.request.mutation ?? input.mutation, old = structuredClone(input.beforeZoneProtos ?? []) as Raw[];
  if (!m) throw new Error("Synthetic fixture requires a mutation");
  const spans = parseFreshPcbDirectZoneSourceSpans(before);
  if (spans.length !== old.length || spans.some(span => !old.some(raw => raw.id.value === span.uuid))) throw new Error("Synthetic fixture requires complete beforeZoneProtos for existing zones");
  const uuid = m.operation === "update" ? m.zoneId : input.zoneId ?? "99999999-9999-4999-8999-999999999999";
  const returned = targetProto(m, uuid, m.operation === "update" ? old.find(raw => raw.id.value === uuid) : undefined), requested = structuredClone(returned);
  if (m.operation === "create") delete requested.id;
  const inserted = targetSource(m, returned, input.filledContoursNm), targetSpan = spans.find(span => span.uuid === uuid);
  const stagedSource = m.operation === "create" ? before.slice(0, before.lastIndexOf(")")) + inserted + before.slice(before.lastIndexOf(")"))
    : before.slice(0, targetSpan!.start) + inserted + before.slice(targetSpan!.end);
  let unfilledSource = stagedSource;
  for (const zone of parseFreshPcbReferenceGeometry(stagedSource).zones) {
    for (const fill of zone.filledPolygons) unfilledSource = unfilledSource.replace(fill.source, "");
    const fill = zone.settings.find(setting => setting.name === "fill")!;
    unfilledSource = unfilledSource.replace(fill.source, fill.source.replace("(fill yes", "(fill"));
  }
  const baseline = m.operation === "create" ? [...old, returned] : old.map(raw => raw.id.value === uuid ? returned : raw);
  const empty = baseline.map(raw => { const next = structuredClone(raw); delete next.filled; next.filled_polygons = next.layers.map((layer: string) => ({ layer, shapes: {} })); return next; });
  const filled = baseline.map(raw => { const next = structuredClone(raw); next.filled = true;
    if (raw.id.value === uuid) next.filled_polygons = [{ layer: next.layers[0], shapes: { polygons: input.filledContoursNm === undefined ? structuredClone(next.outline.polygons)
      : input.filledContoursNm.map(ring=>({outline:{closed:true,nodes:ring.map(([x,y])=>({point:{x_nm:String(x),y_nm:String(y)}}))}})) } }]; return next; });
  const pads = await nativePadObservationFixture(stagedSource, before), snapshot: Raw = structuredClone(pads.observation.rawSnapshot);
  const boardPath = input.request?.board_file ?? input.boardPath ?? pads.expected.pcbPath, document = { type: "DOCTYPE_PCB", board_filename: path.win32.basename(boardPath), project: { name: path.win32.basename(boardPath, ".kicad_pcb"), path: path.win32.dirname(boardPath) } };
  // Rebind only known document fields, never perform a recursive string rewrite.
  snapshot.documentBefore = document; snapshot.documentAfter = document; snapshot.enabledLayers.request.board = document;
  snapshot.footprintInventory.request.header.document = document; snapshot.padstackPresence.request.board = document;
  for (const query of snapshot.connectivity) query.request.header.document = document;
  if (input.request) snapshot.connectivity = input.request.reference_pads.map(ref => {
    const query = snapshot.connectivity.find((query: Raw) => query.sourcePrimitiveId === ref.primitiveId);
    if (!query) throw new Error("Synthetic requested PAD missing from full source fixture"); return query;
  });
  const reference_pads = snapshot.connectivity.map((query: Raw) => {
    const index = snapshot.padRecords.findIndex((pad: Raw) => pad.id.value === query.sourcePrimitiveId), owner = snapshot.footprintInventory.footprints.find((fp: Raw) => fp.padRecordIndexes.includes(index));
    return { reference: owner.reference, pad: snapshot.padRecords[index].number, primitiveId: query.sourcePrimitiveId };
  });
  const request: KicadPlaneStageInput = input.request ?? { board_file: boardPath, zone_ids: old.map(raw => raw.id.value), reference_pads,
    request: { expectedSavedIdentity: contentIdentity(before), expectedLiveIdentity: contentIdentity(before), mutation: m } };
  const rpc: Raw[] = [];
  const call = (requestType: string, request: unknown, responseType: string, response: unknown) => rpc.push({ requestType, request, responseType, response });
  const doc = () => call(COMMON + "GetOpenDocuments", { type: "DOCTYPE_PCB" }, COMMON + "GetOpenDocumentsResponse", { documents: [document] });
  const source = (contents: string) => call(COMMON + "SaveDocumentToString", { document }, COMMON + "SavedDocumentResponse", { document, contents });
  const items = (type: string, values: Raw[]) => call(COMMON + "GetItems", { header: { document }, types: ["KOT_PCB_" + type.toUpperCase()] }, COMMON + "GetItemsResponse", { status: "IRS_OK", items: values.map(value => ({ "@type": TYPE + type, ...value })) });
  const enabled = () => call(BOARD + "GetBoardEnabledLayers", { board: document }, BOARD + "BoardEnabledLayersResponse", snapshot.enabledLayers.response);
  doc(); source(before); items("Zone", old); enabled(); call(BOARD + "GetNets", { board: document }, BOARD + "NetsResponse", { nets: [{ name: m.netName, code: { value: 1 } }] }); doc(); source(before);
  const operation = m.operation === "create" ? "CreateItems" : "UpdateItems", itemField = m.operation === "create" ? "created_items" : "updated_items";
  call(COMMON + operation, { header: { document }, items: [{ "@type": TYPE + "Zone", ...requested }] }, COMMON + operation + "Response", { status: "IRS_OK", [itemField]: [{ status: { code: "ISC_OK" }, item: { "@type": TYPE + "Zone", ...returned } }] });
  items("Zone", baseline); call(COMMON + "RunAction", { action: "pcbnew.ZoneFiller.zoneUnfillAll" }, COMMON + "RunActionResponse", { status: "RAS_OK" });
  items("Zone", empty); source(unfilledSource); doc(); call(COMMON + "RunAction", { action: "pcbnew.ZoneFiller.zoneFillAll" }, COMMON + "RunActionResponse", { status: "RAS_OK" });
  items("Zone", filled); source(stagedSource); doc(); enabled(); items("Pad", snapshot.padRecords);
  call(COMMON + "GetItems", snapshot.footprintInventory.request, COMMON + "GetItemsResponse", { status: "IRS_OK", items: snapshot.footprintInventory.footprints.map((fp: Raw) => ({
    "@type": TYPE + "FootprintInstance", id: { value: fp.footprintId }, reference_field: { text: { text: { text: fp.reference } } },
    definition: { items: fp.padRecordIndexes.map((index: number) => ({ "@type": TYPE + "Pad", ...snapshot.padRecords[index] })) } })) });
  call(BOARD + "CheckPadstackPresenceOnLayers", snapshot.padstackPresence.request, snapshot.padstackPresence.responseType, snapshot.padstackPresence.response);
  for (const query of snapshot.connectivity) call(query.requestType, query.request, query.responseType, { status: "IRS_OK", items: query.padRecordIndexes.map((index: number) => ({ "@type": TYPE + "Pad", ...snapshot.padRecords[index] })) });
  source(stagedSource); doc();
  const receipt: Raw = { schemaVersion: "evleda.native-plane-stage.v1", complete: true, nativeSaveCalled: false, mutationDispatched: true, recoveryRequired: false, request: request.request,
    assurance: { accepted: false, minimumSpokes: "not_configured_by_zone_api", highFrequencyValidity: "not_established" }, document, savedSourceBefore: before, nativeSourceBefore: before,
    zonesBefore: inventory(old), zoneMutation: { operation: m.operation, zoneId: uuid, request: m, requestedProto: requested, returnedProto: returned,
      nativeIdentity: { requestedId: m.operation === "create" ? "" : uuid, returnedId: uuid, requestedName: m.name, returnedName: m.name, uuidAssignedByNative: m.operation === "create", nameNormalized: false },
      minimumSpokes: m.connection === "thermal" ? { required: m.minimumSpokes, configured: false, enforcement: "requires_external_owned_DRC_rule_and_resolved_spoke_validation" } : { applicable: false, reason: "solid_connection" },
      islandMinimumArea: m.islandPolicy === "area" ? { requiredNm2: m.minIslandAreaNm2, active: true } : { active: false, sourceRepresentation: "not_serialized", enforced: false, nativeProtoNm2: returned.copper_settings.min_island_area ?? "0" } },
    zonesBeforeUnfill: inventory(baseline), zonesUnfilled: inventory(empty), nativeSourceUnfilled: unfilledSource, zonesStaged: inventory(filled),
    epoch: { unfillAction: "pcbnew.ZoneFiller.zoneUnfillAll", fillAction: "pcbnew.ZoneFiller.zoneFillAll", unfilledObserved: true, filledObserved: true, busyPollCount: 0 },
    nativeSourceStaged: stagedSource, padSnapshot: snapshot, savedSourceStaged: before,
    identities: Object.fromEntries(Object.entries({ savedSourceBefore: before, nativeSourceBefore: before, nativeSourceUnfilled: unfilledSource, savedSourceStaged: before, nativeSourceStaged: stagedSource }).map(([key, value]) => [key, contentIdentity(value)])),
    counts: { physicalPads: snapshot.padRecords.length, individualQueries: snapshot.connectivity.length, returnedPadsPerQuery: snapshot.connectivity.map((query: Raw) => query.padRecordIndexes.length) }, rpc };
  return { receipt, request, padExpected: { ...pads.expected, pcbPath: boardPath, pcbSource: before, requestedPrimitiveIds: request.reference_pads.map(pad => pad.primitiveId) }, stagedSource, stagedZoneProto: filled.find(raw => raw.id.value === uuid)!, returnedZoneProto: returned };
}
