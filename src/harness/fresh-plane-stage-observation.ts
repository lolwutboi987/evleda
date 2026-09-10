import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { kicadPlaneStageInputSchema, type KicadPlaneStageInput } from "../integrations/kicad-plane-stage.js";
import { decodeKicadNativePadObservation, type KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { compareFreshPlaneRefillPreservation, parseFreshPcbDirectZoneSourceSpans, parseFreshPcbReferenceGeometry } from "./fresh-kicad-parser.js";
import { compareFreshPlaneLiteralMutation, compareFreshPlaneMutation, type PreparedFreshPlaneMutation } from "./fresh-plane-mutation.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

type Obj = Record<string, unknown>;
const MAX = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMON = "kiapi.common.commands.", BOARD = "kiapi.board.commands.", TYPE = "type.googleapis.com/kiapi.board.types.";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Plane stage observation: ${message}`); }
function obj(value: unknown, label: string): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); return value as Obj; }
function arr(value: unknown, label: string, max = 4096): unknown[] { check(Array.isArray(value) && value.length <= max, `${label} must be a bounded array`); return value; }
function keys(value: Obj, required: string[], optional: string[] = []) { check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "missing or unsupported record fields"); }
function str(value: unknown, label: string): string { check(typeof value === "string" && value.length > 0 && value.isWellFormed() && !value.includes("\0"), `${label} must be nonempty text`); return value; }
function id(value: unknown): string { const record = obj(value, "UUID"); keys(record, ["value"]); const result = str(record.value, "UUID"); check(UUID.test(result), "noncanonical UUID"); return result; }
function unique(values: readonly string[], label: string) { check(new Set(values).size === values.length, `${label} contains duplicate IDs`); }
function sameSet(a: readonly string[], b: readonly string[]) { return a.length === b.length && a.every(value => b.includes(value)); }
function withoutType(value: unknown, expected: string): Obj { const raw = obj(value, "native Any"); check(raw["@type"] === TYPE + expected, "wrong native Any type"); const { ["@type"]: _type, ...rest } = raw; return rest; }
function cacheless(raw: Obj): Obj { const { filled: _filled, filled_polygons: _polygons, ...rest } = raw; return rest; }

interface Zone { uuid: string; raw: Obj; filled: boolean; polygonCount: number }
function inventory(value: unknown): Zone[] {
  const zones = arr(value, "zone inventory", 32).map(value => {
    const zone = obj(value, "zone observation"); keys(zone, ["uuid", "filled", "raw", "filledPolygons", "fillCounts"]);
    const raw = obj(zone.raw, "zone proto"), uuid = id(raw.id);
    check(zone.uuid === uuid && raw.type === "ZT_COPPER" && typeof zone.filled === "boolean" && zone.filled === (raw.filled ?? false), "zone identity/type/filled summary differs from raw proto");
    const layers = arr(raw.layers, "zone layers", 32).map(layer => str(layer, "zone layer")); unique(layers, "zone layers");
    const polygons: Obj = {}; let holes = 0, nodes = 0, polygonCount = 0;
    for (const value of arr(raw.filled_polygons ?? [], "native fill layers", 32)) {
      const fill = obj(value, "native fill layer"); keys(fill, ["layer", "shapes"]);
      const layer = str(fill.layer, "fill layer"); check(layers.includes(layer) && !Object.hasOwn(polygons, layer), "duplicate or undeclared filled layer");
      const shapes = obj(fill.shapes, "fill shape set"); keys(shapes, [], ["polygons"]);
      const entries = arr(shapes.polygons ?? [], "filled polygons", 100_000); polygons[layer] = entries;
      for (const entry of entries) {
        const polygon = obj(entry, "native filled polygon"); keys(polygon, ["outline"], ["holes"]);
        const outline = obj(polygon.outline, "native contour"); keys(outline, ["nodes", "closed"]);
        check(outline.closed === true, "native fill contour is not closed");
        nodes += arr(outline.nodes, "fill contour nodes", 100_000).length;
        holes += arr(polygon.holes ?? [], "native typed holes", 100_000).length; polygonCount++;
      }
    }
    check(same(zone.filledPolygons, polygons) && same(zone.fillCounts, { layerCount: Object.keys(polygons).length, polygonCount, typedHoleCount: holes, outlineNodeCount: nodes }), "fill projection/counts differ from complete raw proto");
    return { uuid, raw, filled: zone.filled, polygonCount };
  });
  unique(zones.map(zone => zone.uuid), "zone inventory"); return zones;
}
function sourceInventory(source: string, zones: Zone[], unfilled = false) {
  check(sameSet(parseFreshPcbDirectZoneSourceSpans(source).map(zone => zone.uuid), zones.map(zone => zone.uuid)), "source and raw complete zone inventories differ");
  if (unfilled) for (const zone of parseFreshPcbReferenceGeometry(source).zones) {
    const fills = zone.settings.filter(setting => setting.name === "fill");
    check(zone.status === "supported" && !zone.filledCachePresent && fills.length === 1 && fills[0]!.values.every(value => value.value === "no" && !value.quoted), "unfilled source contains cache or a filled/ambiguous state");
  }
}
export interface FreshPlaneStageObservationExpected {
  readonly request: KicadPlaneStageInput;
  /** Saved preimage only. The adapter substitutes validated staged source for the pure PAD decoder. */
  readonly padExpected: KicadNativePadObservationExpected;
}

/** Validate the existing private producer transcript, not a replacement wire protocol. */
function decodeStage(receiptInput: unknown, expected: FreshPlaneStageObservationExpected) {
  const receipt = obj(hardenPortableValue(receiptInput, { maxBytes: MAX, maxStringBytes: 1024 * 1024, maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 256, maxKeyBytes: 1024 }), "receipt");
  keys(receipt, ["schemaVersion", "complete", "nativeSaveCalled", "mutationDispatched", "recoveryRequired", "request", "assurance", "document", "savedSourceBefore", "nativeSourceBefore", "zonesBefore", "zoneMutation", "zonesBeforeUnfill", "zonesUnfilled", "nativeSourceUnfilled", "zonesStaged", "epoch", "nativeSourceStaged", "padSnapshot", "savedSourceStaged", "identities", "counts", "rpc"]);
  const request = kicadPlaneStageInputSchema.parse(expected.request), mutation = request.request.mutation;
  check(mutation !== undefined && receipt.schemaVersion === "evleda.native-plane-stage.v1" && receipt.complete === true && receipt.nativeSaveCalled === false && receipt.mutationDispatched === true && receipt.recoveryRequired === false, "receipt is not a complete unsaved mutation stage");
  check(same(receipt.request, request.request) && same(receipt.assurance, { accepted: false, minimumSpokes: "not_configured_by_zone_api", highFrequencyValidity: "not_established" }), "request/assurance differs");
  const document = obj(receipt.document, "document"); keys(document, ["type", "board_filename", "project"]);
  const project = obj(document.project, "document project"); keys(project, ["name", "path"]);
  const filename = str(document.board_filename, "board filename"), projectPath = str(project.path, "project path"); str(project.name, "project name");
  check(document.type === "DOCTYPE_PCB" && filename === path.win32.basename(filename) && path.win32.isAbsolute(projectPath)
    && path.win32.isAbsolute(request.board_file) && path.win32.normalize(path.win32.join(projectPath, filename)).toLowerCase() === path.win32.normalize(request.board_file).toLowerCase()
    && path.win32.normalize(expected.padExpected.pcbPath).toLowerCase() === path.win32.normalize(request.board_file).toLowerCase(), "document differs from exact host PCB");
  const saved = str(receipt.savedSourceBefore, "saved preimage"), before = str(receipt.nativeSourceBefore, "native preimage"), unfilled = str(receipt.nativeSourceUnfilled, "unfilled source"), staged = str(receipt.nativeSourceStaged, "staged source");
  check(saved === expected.padExpected.pcbSource && saved === receipt.savedSourceStaged && same(contentIdentity(saved), request.request.expectedSavedIdentity)
    && same(contentIdentity(before), request.request.expectedLiveIdentity) && freshBoardSerializationsEqual(saved, before), "saved/native preimage is unbound or disk changed during unsaved stage");
  const identities = { savedSourceBefore: contentIdentity(saved), nativeSourceBefore: contentIdentity(before), nativeSourceUnfilled: contentIdentity(unfilled), savedSourceStaged: contentIdentity(saved), nativeSourceStaged: contentIdentity(staged) };
  check(same(receipt.identities, identities), "source identity summaries differ from exact source bytes");
  const initial = inventory(receipt.zonesBefore), baseline = inventory(receipt.zonesBeforeUnfill), empty = inventory(receipt.zonesUnfilled), filled = inventory(receipt.zonesStaged);
  check(sameSet(initial.map(zone => zone.uuid), request.zone_ids), "initial inventory differs from complete host selection"); sourceInventory(before, initial);
  const changed = obj(receipt.zoneMutation, "mutation receipt");
  keys(changed, ["operation", "zoneId", "request", "requestedProto", "returnedProto", "nativeIdentity", "minimumSpokes", "islandMinimumArea"]);
  const returned = obj(changed.returnedProto, "returned target"), requested = obj(changed.requestedProto, "requested target"), targetZoneUuid = id(returned.id);
  check(changed.operation === mutation.operation && changed.zoneId === targetZoneUuid && same(changed.request, mutation), "mutation receipt differs from host request");
  check(same(changed.nativeIdentity, { requestedId: mutation.operation === "create" ? "" : targetZoneUuid, returnedId: targetZoneUuid,
    requestedName: mutation.name, returnedName: mutation.name, uuidAssignedByNative: mutation.operation === "create", nameNormalized: false }), "native mutation identity summary differs");
  check(same(changed.minimumSpokes, mutation.connection === "thermal" ? { required: mutation.minimumSpokes, configured: false, enforcement: "requires_external_owned_DRC_rule_and_resolved_spoke_validation" }
    : { applicable: false, reason: "solid_connection" }), "minimum-spoke observation is not the external-only requested policy");
  check(same(changed.islandMinimumArea, mutation.islandPolicy === "area" ? { requiredNm2: mutation.minIslandAreaNm2, active: true }
    : { active: false, sourceRepresentation: "not_serialized", enforced: false, nativeProtoNm2: obj(returned.copper_settings, "returned copper settings").min_island_area ?? "0" }), "island-area summary differs from raw active/inactive observation");
  const requestedCompare = { ...returned }; if (mutation.operation === "create") delete requestedCompare.id;
  check(same(requestedCompare, requested), "native mutation did not preserve exact requested/default proto fields");
  const expectedIds = mutation.operation === "create" ? [...request.zone_ids, targetZoneUuid] : request.zone_ids;
  check(mutation.operation === "create" ? !request.zone_ids.includes(targetZoneUuid) : targetZoneUuid === mutation.zoneId && request.zone_ids.includes(targetZoneUuid), "wrong whole-zone UUID evolution");
  for (const zones of [baseline, empty, filled]) check(sameSet(zones.map(zone => zone.uuid), expectedIds), "postmutation whole-zone inventory changed");
  const beforeZoneProto = mutation.operation === "update" ? initial.find(zone => zone.uuid === targetZoneUuid)!.raw : null;
  for (const zone of baseline) check(same(zone.raw, zone.uuid === targetZoneUuid ? returned : initial.find(old => old.uuid === zone.uuid)!.raw), "postmutation baseline differs from returned target/untouched prior zone");
  const targetBaseline = baseline.find(zone => zone.uuid === targetZoneUuid)!;
  check(!targetBaseline.filled && targetBaseline.polygonCount === 0, "typed mutation did not return its characterized unfilled target");
  for (const zones of [empty, filled]) for (const zone of zones) check(same(cacheless(zone.raw), cacheless(baseline.find(old => old.uuid === zone.uuid)!.raw)), "unfill/fill changed retained non-cache zone fields");
  check(empty.every(zone => !zone.filled && zone.polygonCount === 0) && filled.every(zone => zone.filled && zone.polygonCount > 0), "raw unfill/fill did not establish false/empty then true/nonempty");
  sourceInventory(unfilled, empty, true); sourceInventory(staged, filled);
  const refill = compareFreshPlaneRefillPreservation({ beforePcbSource: unfilled, afterPcbSource: staged, zoneUuids: expectedIds });
  check(refill.equal, "refill changed non-cache source tokens");
  const epoch = obj(receipt.epoch, "epoch"); keys(epoch, ["unfillAction", "fillAction", "unfilledObserved", "filledObserved", "busyPollCount"]);
  check(epoch.unfillAction === "pcbnew.ZoneFiller.zoneUnfillAll" && epoch.fillAction === "pcbnew.ZoneFiller.zoneFillAll" && epoch.unfilledObserved === true && epoch.filledObserved === true
    && Number.isSafeInteger(epoch.busyPollCount) && (epoch.busyPollCount as number) >= 0, "invalid epoch summary");
  const snapshot = obj(receipt.padSnapshot, "PAD snapshot");
  check(snapshot.boardSourceBefore === staged && snapshot.boardSourceAfter === staged && same(snapshot.documentBefore, document) && same(snapshot.documentAfter, document), "PAD snapshot belongs to another source/document epoch");
  check(same(expected.padExpected.requestedPrimitiveIds, request.reference_pads.map(pad => pad.primitiveId)), "host PAD selection differs from stage request");
  const nativePads = decodeKicadNativePadObservation({ isError: false, content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot }, { ...expected.padExpected, pcbSource: staged });
  for (const pad of request.reference_pads) {
    const owners = nativePads.parsedBoard.footprints.filter(fp => fp.reference === pad.reference).flatMap(fp => fp.pads.filter(p => p.physical.id === pad.primitiveId && p.number === pad.pad));
    check(owners.length === 1, "host individual PAD reference/number/UUID ownership differs");
  }
  const rawPads = arr(snapshot.padRecords, "pad records").map(value => obj(value, "pad")), queries = arr(snapshot.connectivity, "PAD queries", 128).map(value => obj(value, "PAD query"));
  check(same(receipt.counts, { physicalPads: rawPads.length, individualQueries: queries.length, returnedPadsPerQuery: queries.map(query => arr(query.padRecordIndexes, "query indexes").length) }), "PAD count summaries differ");

  // Bind every observed summary to the raw calls, including order. Busy replies
  // are allowed only while polling the final zone inventory after the fixed fill.
  const calls = arr(receipt.rpc, "RPC transcript", 1024).map(value => obj(value, "RPC"));
  const zoneCalls: number[] = [], actionCalls: number[] = [], mutationCalls: number[] = [], padCalls: number[] = [], footprintCalls: number[] = [], presenceCalls: number[] = [], connectedCalls: number[] = [], enabledCalls: number[] = [], netCalls: number[] = [], busyCalls: number[] = [], sourceCalls: number[] = [], documentCalls: number[] = [];
  function itemResponse(call: Obj): { response: Obj; items: unknown[] } {
    const response = obj(call.response, "item response"); keys(response, ["status"], ["items", "header"]); check(response.status === "IRS_OK", "incomplete native item response");
    if (response.header !== undefined) {
      const header = obj(response.header, "item response header"); keys(header, [], ["document", "container", "field_mask"]);
      check((header.document === undefined || same(header.document, document)) && (header.container === undefined || same(header.container, {})) && (header.field_mask === undefined || same(header.field_mask, {})), "partial or different-document response header");
    }
    return { response, items: arr(response.items ?? [], "response items") };
  }
  for (const [index, call] of calls.entries()) {
    const kind = str(call.requestType, "RPC request type"), requestValue = obj(call.request, "RPC request");
    if (call.error !== undefined) {
      keys(call, ["requestType", "request", "error"]); const error = obj(call.error, "RPC error"); keys(error, ["type", "code", "message"]);
      // Pinned common/envelope.proto AS_BUSY=7, kipy exposes the numeric code.
      check(kind === COMMON + "GetItems" && same(requestValue, { header: { document }, types: ["KOT_PCB_ZONE"] }) && error.type === "ApiError" && error.code === 7 && typeof error.message === "string", "unqualified RPC error in completed stage"); busyCalls.push(index); continue;
    }
    keys(call, ["requestType", "request", "responseType", "response"]);
    if (kind === COMMON + "GetOpenDocuments") {
      check(call.responseType === COMMON + "GetOpenDocumentsResponse" && same(requestValue, { type: "DOCTYPE_PCB" }) && same(call.response, { documents: [document] }), "document RPC differs"); documentCalls.push(index);
    } else if (kind === COMMON + "SaveDocumentToString") {
      check(call.responseType === COMMON + "SavedDocumentResponse" && same(requestValue, { document }), "source RPC document differs");
      const response = obj(call.response, "source response"); keys(response, ["document", "contents"]); check(same(response.document, document), "source response document differs"); sourceCalls.push(index);
    } else if (kind === COMMON + "RunAction") {
      check(call.responseType === COMMON + "RunActionResponse" && same(call.response, { status: "RAS_OK" }), "action was not acknowledged"); actionCalls.push(index);
    } else if (kind === COMMON + "CreateItems" || kind === COMMON + "UpdateItems") {
      const operation = mutation.operation === "create" ? "CreateItems" : "UpdateItems", field = mutation.operation === "create" ? "created_items" : "updated_items";
      check(kind === COMMON + operation && call.responseType === COMMON + operation + "Response" && same(requestValue, { header: { document }, items: [{ "@type": TYPE + "Zone", ...requested }] }), "mutation RPC request differs");
      const response = obj(call.response, "mutation response"); keys(response, ["status", field], ["header"]); check(response.status === "IRS_OK", "mutation response is not complete");
      if (response.header !== undefined) check(same(response.header, {}) || same(response.header, { document }), "mutation response header differs or is partial");
      const entries = arr(response[field], "mutation results", 1); check(entries.length === 1, "mutation did not return exactly one item");
      const entry = obj(entries[0], "mutation item"); keys(entry, ["status", "item"]); check(same(entry.status, { code: "ISC_OK" }) && same(withoutType(entry.item, "Zone"), returned), "mutation item status/proto differs"); mutationCalls.push(index);
    } else if (kind === BOARD + "GetBoardEnabledLayers") {
      check(call.responseType === BOARD + "BoardEnabledLayersResponse" && same(requestValue, { board: document }) && same(call.response, obj(snapshot.enabledLayers, "enabled layers").response), "enabled-layer RPC differs"); enabledCalls.push(index);
    } else if (kind === BOARD + "GetNets") {
      check(call.responseType === BOARD + "NetsResponse" && same(requestValue, { board: document }), "net request differs");
      const nets = obj(call.response, "nets response"); keys(nets, ["nets"]); check(arr(nets.nets, "native nets").filter(value => obj(value, "net").name === mutation.netName).length === 1, "requested native net is missing or ambiguous"); netCalls.push(index);
    } else if (kind === COMMON + "GetItems") {
      check(call.responseType === COMMON + "GetItemsResponse", "wrong item response type"); const types = arr(requestValue.types, "item request types", 1);
      check(types.length === 1 && same(requestValue, { header: { document }, types }), "partial/unbound item selection"); itemResponse(call);
      if (types[0] === "KOT_PCB_ZONE") zoneCalls.push(index);
      else if (types[0] === "KOT_PCB_PAD") padCalls.push(index);
      else if (types[0] === "KOT_PCB_FOOTPRINT") footprintCalls.push(index);
      else check(false, "unqualified GetItems selection");
    } else if (kind === BOARD + "CheckPadstackPresenceOnLayers") {
      const projection = obj(snapshot.padstackPresence, "presence projection");
      check(call.responseType === projection.responseType && same(requestValue, projection.request) && same(call.response, projection.response), "presence RPC differs from source-bound PAD observation"); presenceCalls.push(index);
    } else if (kind === BOARD + "GetConnectedItems") {
      check(call.responseType === COMMON + "GetItemsResponse", "wrong connected-items response type"); itemResponse(call); connectedCalls.push(index);
    } else check(false, "unqualified RPC or hidden save/mutation in completed stage");
  }
  check(zoneCalls.length === 4 && actionCalls.length === 2 && mutationCalls.length === 1 && padCalls.length === 1 && footprintCalls.length === 1 && presenceCalls.length === 1 && connectedCalls.length === queries.length && enabledCalls.length === 2 && netCalls.length === 1, "missing/extra native calls in stage inventory");
  const [z0, z1, z2, z3] = zoneCalls as [number, number, number, number], [a0, a1] = actionCalls as [number, number], m = mutationCalls[0]!;
  check(z0 < enabledCalls[0]! && enabledCalls[0]! < netCalls[0]! && netCalls[0]! < m && m < z1 && z1 < a0 && a0 < z2 && z2 < a1 && a1 < z3
    && z3 < enabledCalls[1]! && enabledCalls[1]! < padCalls[0]! && padCalls[0]! < footprintCalls[0]! && footprintCalls[0]! < presenceCalls[0]!
    && connectedCalls.every((index, ordinal) => index > presenceCalls[0]! && (ordinal === 0 || index > connectedCalls[ordinal - 1]!)), "native mutation/unfill/fill/PAD calls are reordered");
  check(same(calls[a0]!.request, { action: epoch.unfillAction }) && same(calls[a1]!.request, { action: epoch.fillAction }) && busyCalls.length === epoch.busyPollCount && busyCalls.every(index => index > a1 && index < z3), "epoch actions/busy polls are not raw-transcript bound");
  const inventories = [initial, baseline, empty, filled];
  zoneCalls.forEach((index, ordinal) => check(same(itemResponse(calls[index]!).items.map(value => withoutType(value, "Zone")), inventories[ordinal]!.map(zone => zone.raw)), "zone summary differs from complete ordered native response"));
  check(sourceCalls.some(index => index < z0) && sourceCalls.some(index => index > netCalls[0]! && index < m) && sourceCalls.some(index => index > z2 && index < a1)
    && sourceCalls.some(index => index > z3 && index < enabledCalls[1]!) && sourceCalls.some(index => index > (connectedCalls.at(-1) ?? presenceCalls[0]!)), "missing native source epoch fences");
  for (const index of sourceCalls) check(obj(calls[index]!.response, "source response").contents === (index < m ? before : index > z2 && index < a1 ? unfilled : index > z3 ? staged : null), "native source RPC differs or occurs outside qualified epoch");
  check(documentCalls.some(index => index < z0) && documentCalls.some(index => index > netCalls[0]! && index < m) && documentCalls.some(index => index > z2 && index < a1) && documentCalls.at(-1)! > sourceCalls.at(-1)!, "missing unchanged-document epoch fences");
  check(same(itemResponse(calls[padCalls[0]!]!).items.map(value => withoutType(value, "Pad")), rawPads), "board PAD inventory differs from raw RPC");
  const footprintProjection = obj(snapshot.footprintInventory, "footprint projection"), footprints = arr(footprintProjection.footprints, "footprints");
  const nativeFootprints = itemResponse(calls[footprintCalls[0]!]!).items.map(value => withoutType(value, "FootprintInstance"));
  check(nativeFootprints.length === footprints.length, "footprint RPC is incomplete");
  nativeFootprints.forEach((raw, index) => {
    const projection = obj(footprints[index], "footprint summary"), definition = obj(raw.definition, "footprint definition");
    const reference = obj(obj(obj(raw.reference_field, "reference field").text, "reference text").text, "reference content").text;
    const pads = arr(definition.items ?? [], "footprint items").filter(item => obj(item, "footprint item")["@type"] === TYPE + "Pad").map(item => id(obj(item, "footprint pad").id));
    check(projection.footprintId === id(raw.id) && projection.reference === reference && same(pads, arr(projection.padRecordIndexes, "owner indexes").map(value => id(rawPads[value as number]!.id))), "physical PAD ownership summary differs from raw footprint response");
  });
  connectedCalls.forEach((index, ordinal) => {
    const query = queries[ordinal]!, call = calls[index]!;
    check(same(call.request, query.request) && same(itemResponse(call).items.map(value => withoutType(value, "Pad")), arr(query.padRecordIndexes, "query indexes").map(value => rawPads[value as number])), "individual source PAD query differs from raw ordered response");
  });
  return { receipt, request, before, staged, saved, targetZoneUuid, returned, beforeZoneProto, nativePads, refill, expectedIds };
}

function finish(stage: ReturnType<typeof decodeStage>, comparison: ReturnType<typeof compareFreshPlaneLiteralMutation> | ReturnType<typeof compareFreshPlaneMutation>) {
  check(comparison.valid, "requested mutation source/proto comparison failed");
  const payload = { schemaVersion: "evleda.fresh-plane-stage-observation.v1" as const, receiptIdentity: contentIdentity(canonicalJson(stage.receipt)),
    receiptIdentityEncoding: "canonical-json-observation" as const, nativeSourceBefore: stage.before, nativeSourceStaged: stage.staged,
    savedSourceIdentity: contentIdentity(stage.saved), targetZoneUuid: stage.targetZoneUuid, beforeZoneProto: stage.beforeZoneProto, comparison, nativePads: stage.nativePads,
    nativePadsSource: "validated-staged-native-not-saved" as const, zoneUuids: stage.expectedIds, refillSourcePreservation: stage.refill,
    epochStatus: "raw-transcript-observed-unfill-fill" as const, filledPolygonGeometricEquivalence: "not_evaluated" as const,
    savedAuthorityMinted: false, dcConnectivity: "not_evaluated" as const,
    thermalAcceptance: "not_evaluated" as const, highFrequencyValidity: "not_established" as const, acceptanceEvaluated: false };
  return freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
}
/** Native protocol qualification only: does not grant V2 design or host authority. */
export function validateFreshPlaneLiteralStageObservation(receipt: unknown, expected: FreshPlaneStageObservationExpected) {
  const stage = decodeStage(receipt, expected);
  return finish(stage, compareFreshPlaneLiteralMutation({ mutation: stage.request.request.mutation!, beforePcbSource: stage.saved, afterPcbSource: stage.staged,
    returnedZoneProto: stage.returned, ...(stage.beforeZoneProto === null ? {} : { beforeZoneProto: stage.beforeZoneProto }), phase: "refilled" }));
}
const validated = new WeakSet<object>();
export function validateFreshPlaneStageObservation(receipt: unknown, expected: FreshPlaneStageObservationExpected & { readonly prepared: PreparedFreshPlaneMutation }) {
  const stage = decodeStage(receipt, expected);
  check(same(expected.prepared.beforeSourceIdentity, contentIdentity(stage.saved)) && same(expected.prepared.beforeZoneUuids.slice().sort(), stage.request.zone_ids.slice().sort())
    && same(expected.prepared.mutation, stage.request.request.mutation), "prepared V2 spec differs from exact saved preimage/request");
  const result = finish(stage, compareFreshPlaneMutation({ prepared: expected.prepared, afterPcbSource: stage.staged, returnedZoneProto: stage.returned,
    ...(stage.beforeZoneProto === null ? {} : { beforeZoneProto: stage.beforeZoneProto }), phase: "refilled" }));
  validated.add(result); return result;
}
export type FreshPlaneStageObservation = ReturnType<typeof validateFreshPlaneStageObservation>;
/** In-process validation provenance only; filesystem/runtime ownership remains the calling host's responsibility. */
export function isValidatedFreshPlaneStageObservation(value: unknown): value is FreshPlaneStageObservation { return value !== null && typeof value === "object" && validated.has(value); }
