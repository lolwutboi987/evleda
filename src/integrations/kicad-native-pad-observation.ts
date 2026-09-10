import type { CallToolResult } from "@modelcontextprotocol/client";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { freshBoardSerializationsEqual } from "../harness/fresh-board-serialization.js";
import { parseFreshPcbSource, type FreshParsedPcb, type FreshPcbPad } from "../harness/fresh-kicad-parser.js";
import { buildPadTerminalInventory, type JsonObject, type NativePadClusterCapture, type PadInventory } from "../harness/fresh-pcb-pad-model.js";
import type { KiCadStockFootprintInspection } from "../harness/kicad-library-resolver.js";

export const KICAD_NATIVE_PAD_SNAPSHOT_SCHEMA_VERSION = "evleda.kicad-live-pcb-pad-snapshot.v1" as const;
export const KICAD_NATIVE_PAD_OBSERVATION_SCHEMA_VERSION = "evleda.kicad-native-pad-observation.v1" as const;
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CU = /^BL_(?:F|B|In(?:[1-9]|[12][0-9]|30))_Cu$/u;
const LIMITS = { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024, maxDepth: 32, maxNodes: 300_000, maxOwnKeys: 128, maxKeyBytes: 256, maxArrayLength: 131_072 };
const hostObservations = new WeakSet<object>();
type Obj = Readonly<Record<string, unknown>>;

export interface KicadNativePadObservationExpected {
  /** Exact already-verified marker-bound path/source; this module does not establish filesystem ownership. */
  readonly pcbPath: string;
  readonly pcbSource: string;
  readonly requestedPrimitiveIds: readonly string[];
  readonly enabledCopperLayers: readonly string[];
  /** Current marker/compilation or native-validation source authority, supplied only by the host. */
  readonly scopeIdentity: CanonicalIdentity;
  readonly physicalFootprintResolver?: Readonly<{ inspectFootprint(libraryId: string): KiCadStockFootprintInspection | null }>;
  /** Exact host-selected library source pins, not model-supplied pad counts/ordinals. */
  readonly physicalFootprints?: readonly Readonly<{ reference: string; libraryId: string; sourceIdentity: ContentIdentity }>[];
}
export interface KicadPhysicalLibraryBinding {
  readonly reference: string;
  readonly libraryId: string;
  readonly sourceIdentity: ContentIdentity;
  readonly physicalInventoryIdentity: CanonicalIdentity;
  readonly physicalPadCount: number;
  readonly logicalTerminalCount: number;
}
export interface KicadNativePadObservation {
  readonly schemaVersion: typeof KICAD_NATIVE_PAD_OBSERVATION_SCHEMA_VERSION;
  readonly expectedIdentity: CanonicalIdentity;
  readonly savedPcbIdentity: ContentIdentity;
  readonly nativePcbIdentity: ContentIdentity;
  readonly rawEnvelopeIdentity: ContentIdentity;
  readonly physicalLibraryBindings: readonly KicadPhysicalLibraryBinding[];
  readonly inventory: PadInventory | null;
  readonly clusters: NativePadClusterCapture;
  readonly parsedBoard: FreshParsedPcb;
  /** Exact complete decoded private payload, never sent to model tools as a PASS receipt. */
  readonly rawSnapshot: JsonObject;
}
export interface KicadNativePadReadPort {
  readLivePcbPadSnapshot(requestedPrimitiveIds: readonly string[]): Promise<CallToolResult>;
}

function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Native pad observation: ${message}`); }
function obj(value: unknown, label: string): Obj { requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is not an object`); return value as Obj; }
function keys(value: Obj, required: readonly string[], label: string, optional: readonly string[] = []): void {
  requireValue(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), `${label} has missing/extra fields`);
}
function array(value: unknown, label: string, maximum = 4096): readonly unknown[] { requireValue(Array.isArray(value) && value.length <= maximum, `${label} is not a bounded array`); return value; }
function string(value: unknown, label: string, allowEmpty = false): string {
  requireValue(typeof value === "string" && value.isWellFormed() && (allowEmpty || value.length > 0) && !value.includes("\0"), `${label} is invalid text`); return value;
}
function strings(value: unknown, label: string, maximum = 4096): readonly string[] { return array(value, label, maximum).map(entry => string(entry, label)); }
function unique(values: readonly unknown[], label: string): void { requireValue(new Set(values).size === values.length, `${label} contains duplicates`); }
function equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every(value => right.includes(value)); }
function identity(value: unknown, label: string): string { const record = obj(value, label); keys(record, ["value"], label); const id = string(record.value, label); requireValue(UUID.test(id), `${label} is not a canonical UUID`); return id; }
function nm(value: unknown): number { if (value === undefined) return 0; requireValue(typeof value === "number" || typeof value === "string" && /^-?[0-9]+$/u.test(value), "invalid native coordinate"); const number = Number(value); requireValue(Number.isSafeInteger(number), "unsafe native coordinate"); return number; }
function nativePoint(value: unknown): readonly [number, number] { const p = obj(value, "native point"); keys(p, [], "native point", ["x_nm", "y_nm"]); return [nm(p.x_nm), nm(p.y_nm)]; }
function sameMm(nativeNm: number, mm: number): boolean { return Math.abs(nativeNm / 1_000_000 - mm) <= 0.0000005; }
function canonicalNativeLayer(layer: string): string {
  if (layer === "*.Cu") return layer;
  const match = /^(F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/u.exec(layer);
  if (match) return `BL_${match[1]}_Cu`;
  if (/^[FB]\.(Mask|Paste)$/u.test(layer)) return `BL_${layer.replace(".", "_")}`;
  return `UNSUPPORTED:${layer}`;
}
function expandedNativeLayers(layers: readonly string[]): readonly string[] {
  return [...new Set(layers.flatMap(layer=>layer==="*.Cu"?["BL_F_Cu","BL_B_Cu",...Array.from({length:30},(_,i)=>`BL_In${i+1}_Cu`)]
    :layer==="F&B.Cu"?["BL_F_Cu","BL_B_Cu"]:layer==="*.Mask"?["BL_F_Mask","BL_B_Mask"]:layer==="*.Paste"?["BL_F_Paste","BL_B_Paste"]:[canonicalNativeLayer(layer)]))];
}
/** Reproduce complete physical library geometry against source-pinned approved inspections.
 * Instance UUID/net/placement are checked separately; no positional ordinal matching is used.
 */
export function bindKicadPhysicalFootprintLibraries(board: FreshParsedPcb, expected: KicadNativePadObservationExpected): readonly KicadPhysicalLibraryBinding[] {
  if (expected.physicalFootprints === undefined && expected.physicalFootprintResolver === undefined) return Object.freeze([]);
  requireValue(expected.physicalFootprints !== undefined && expected.physicalFootprintResolver !== undefined, "physical library claims need source pins and the approved resolver");
  unique(expected.physicalFootprints.map(fp => fp.reference), "physical library references");
  const normalize = (angle: number): number => ((angle % 360) + 360) % 360;
  return Object.freeze(expected.physicalFootprints.map(binding => {
    const inspected = expected.physicalFootprintResolver!.inspectFootprint(binding.libraryId);
    requireValue(inspected !== null && inspected.libraryId === binding.libraryId && equal(inspected.sourceIdentity, binding.sourceIdentity), "physical library source is absent or changed from its host pin");
    const matches = board.footprints.filter(fp => fp.reference === binding.reference);
    requireValue(matches.length === 1, "physical library reference is missing or duplicated");
    const placed = matches[0]!, leaf = binding.libraryId.slice(binding.libraryId.indexOf(":") + 1);
    const matchingLeaves = expected.physicalFootprints!.filter(fp => fp.libraryId.slice(fp.libraryId.indexOf(":") + 1) === leaf);
    requireValue(placed.libraryId === binding.libraryId || !placed.libraryId.includes(":") && placed.libraryId === leaf && new Set(matchingLeaves.map(fp => fp.libraryId)).size === 1, "physical footprint library ID is not exact or uniquely bound");
    // Back-side transforms require their own native proof; do not silently mirror a library source.
    requireValue(inspected.side === "front" && placed.layer === "F.Cu", "physical library placement side is outside front-footprint coverage");
    const stockTuples = inspected.physicalPads.map(pad => canonicalJson([pad.definitionKey, pad.at.xMm, pad.at.yMm, normalize(pad.at.rotationDeg)])).sort();
    const placedTuples = placed.pads.map(pad => canonicalJson([pad.physical.definitionKey, pad.physical.relativeAt.x, pad.physical.relativeAt.y, normalize(pad.physical.rotationDeg - placed.rotationDeg)])).sort();
    requireValue(equal(stockTuples, placedTuples), `physical library pad inventory/geometry differs for ${binding.reference}; removed apertures, changed drills/layers or duplicate physical features are not accepted`);
    return Object.freeze({reference:binding.reference,libraryId:binding.libraryId,sourceIdentity:inspected.sourceIdentity,
      physicalInventoryIdentity:canonicalIdentity(stockTuples,"evleda.physical-footprint-pad-definition-set.v1"),
      physicalPadCount:inspected.physicalPads.length,logicalTerminalCount:inspected.pads.length});
  }));
}
function expectedIdentity(expected: KicadNativePadObservationExpected): CanonicalIdentity {
  requireValue(path.win32.isAbsolute(expected.pcbPath) && path.win32.extname(expected.pcbPath).toLowerCase() === ".kicad_pcb" && !/[\0-\x1f\x7f]/u.test(expected.pcbPath), "expected board path is invalid");
  requireValue(expected.requestedPrimitiveIds.length <= 512 && expected.requestedPrimitiveIds.every(id => UUID.test(id)), "invalid requested primitive IDs"); unique(expected.requestedPrimitiveIds, "requested primitive IDs");
  requireValue(expected.enabledCopperLayers.length > 0 && expected.enabledCopperLayers.length <= 32, "missing expected copper layers"); unique(expected.enabledCopperLayers, "expected copper layers");
  requireValue(expected.scopeIdentity.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(expected.scopeIdentity.digest) && expected.scopeIdentity.canonicalizationVersion === "evleda-c14n-json-v1" && expected.scopeIdentity.schemaVersion.length > 0, "invalid host scope identity");
  const physicalLibraryBindings = bindKicadPhysicalFootprintLibraries(parseFreshPcbSource(expected.pcbSource), expected);
  return canonicalIdentity({ pcbPath: expected.pcbPath, pcbSourceIdentity: contentIdentity(expected.pcbSource), requestedPrimitiveIds: expected.requestedPrimitiveIds, enabledCopperLayers: expected.enabledCopperLayers, scopeIdentity: expected.scopeIdentity, physicalLibraryBindings }, "evleda.kicad-native-pad-expected.v1");
}
function assertPadProjection(raw: Obj, saved: FreshPcbPad, enabled: readonly string[]): void {
  requireValue((raw.number ?? "") === saved.number && ((obj(raw.net, "pad net").name ?? "") || null) === saved.netName, "native pad number/net differs from saved source");
  const position = nativePoint(raw.position);
  requireValue(sameMm(position[0], saved.at.x) && sameMm(position[1], saved.at.y), "native pad position differs from saved source");
  const type = ({ smd: "PT_SMD", thru_hole: "PT_PTH", np_thru_hole: "PT_NPTH", connect: "PT_CONNECTOR" } as Record<string, string>)[saved.physical.padType ?? ""];
  requireValue(type !== undefined && raw.type === type, "native pad type differs from saved source or is unsupported");
  const stack = obj(raw.pad_stack, "pad stack");
  const actualLayers = strings(stack.layers, "pad stack layers", 64); unique(actualLayers, "native pad layers");
  const declared = expandedNativeLayers(saved.layers);
  requireValue(declared.every(layer => !layer.startsWith("UNSUPPORTED:")), "saved pad has uncharacterized layer selectors");
  requireValue(sameSet(actualLayers,declared), "complete native pad layer membership differs from saved source");
  const angle = obj(stack.angle, "pad angle").value_degrees ?? 0;
  requireValue(typeof angle === "number" && Number.isFinite(angle) && Math.abs((((angle - saved.physical.rotationDeg) % 360) + 540) % 360 - 180) <= 1e-8, "native pad angle differs from saved source");
  const templates = array(stack.copper_layers, "pad geometry templates", 64);
  requireValue(stack.type === "PST_NORMAL" && templates.length === 1 && saved.physical.sizeMm !== null, "pad-stack geometry is outside normal complete source coverage");
  const template = obj(templates[0], "pad shape");
  const shape = ({ circle: "PSS_CIRCLE", rect: "PSS_RECTANGLE", roundrect: "PSS_ROUNDRECT" } as Record<string, string>)[saved.physical.shape ?? ""];
  requireValue(shape !== undefined && template.shape === shape, "native pad shape differs or is uncharacterized");
  if(shape==="PSS_ROUNDRECT")requireValue(saved.physical.roundrectRatio!==null&&saved.physical.roundrectRatio>=0&&saved.physical.roundrectRatio<=0.5
    &&template.corner_rounding_ratio===saved.physical.roundrectRatio,"native roundrect corner ratio differs from saved source");
  const offset=nativePoint(template.offset??{});
  requireValue(sameMm(offset[0],saved.physical.drill?.offsetMm?.x??0)&&sameMm(offset[1],saved.physical.drill?.offsetMm?.y??0),"native copper offset differs from saved drill-offset encoding");
  requireValue((template.custom_shapes===undefined||array(template.custom_shapes,"custom shapes").length===0)
    &&(template.chamfered_corners===undefined||array(template.chamfered_corners,"chamfered corners").length===0)
    &&nativePoint(template.trapezoid_delta??{}).every(value=>value===0),"nondefault custom/chamfer/trapezoid geometry is outside supported source coverage");
  for(const key of ["secondary_drill","tertiary_drill","front_post_machining","back_post_machining","front_outer_layers","back_outer_layers"]){
    requireValue(stack[key]===undefined||equal(stack[key],{}),`uncharacterized pad-stack ${key} is not accepted as default geometry`);
  }
  const size = nativePoint(template.size);
  requireValue(sameMm(size[0], saved.physical.sizeMm.x) && sameMm(size[1], saved.physical.sizeMm.y), "native pad dimensions differ from saved source");
  const drill = obj(stack.drill, "native drill"), drillSize = nativePoint(drill.diameter);
  const savedDrill = saved.physical.drill;
  requireValue(sameMm(drillSize[0], savedDrill?.sizeMm.x ?? 0) && sameMm(drillSize[1], savedDrill?.sizeMm.y ?? 0), "native drill dimensions differ from saved source");
  if (savedDrill !== null) {
    requireValue(drill.shape === (savedDrill.shape === "oval" ? "DS_OBLONG" : "DS_CIRCLE"), "native drill shape differs from saved source");
    requireValue(drill.start_layer==="BL_F_Cu"&&drill.end_layer==="BL_B_Cu","non-through native pad drill span is outside source coverage");
  }
  requireValue(drill.capped===undefined&&drill.filled===undefined,"pad drill capping/filling is outside supported source coverage");
}

/** Pure raw protocol validation. This function deliberately does not mint host authority. */
export function decodeKicadNativePadObservation(envelopeInput: unknown, expected: KicadNativePadObservationExpected): KicadNativePadObservation {
  const expectedBinding = expectedIdentity(expected);
  const envelope = obj(hardenPortableValue(envelopeInput, LIMITS), "envelope");
  requireValue(Buffer.byteLength(canonicalJson(envelope), "utf8") <= MAX_BYTES, "envelope exceeds the private message bound");
  keys(envelope, ["content", "structuredContent", "isError"], "envelope"); requireValue(envelope.isError === false, "categorical native capture failure");
  const content = array(envelope.content, "text content", 1); requireValue(content.length === 1, "expected one text envelope");
  const text = obj(content[0], "text envelope"); keys(text, ["type", "text"], "text envelope"); requireValue(text.type === "text", "non-text native envelope");
  const textPayload = parsePortableJsonBytes(Buffer.from(string(text.text, "text JSON"), "utf8"), LIMITS);
  requireValue(equal(textPayload, envelope.structuredContent), "text and structured native envelopes disagree");
  const payload = obj(envelope.structuredContent, "snapshot");
  keys(payload, ["schemaVersion", "documentBefore", "documentAfter", "boardSourceBefore", "boardSourceAfter", "enabledCopperLayers", "enabledLayers", "padRecords", "boardPadRecordIndexes", "footprintInventory", "padstackPresence", "connectivity"], "snapshot");
  requireValue(payload.schemaVersion === KICAD_NATIVE_PAD_SNAPSHOT_SCHEMA_VERSION, "wrong native snapshot schema");
  const document = obj(payload.documentBefore, "native document"); keys(document, ["type", "board_filename", "project"], "native document");
  requireValue(document.type === "DOCTYPE_PCB" && equal(document, payload.documentAfter), "native document changed or is not PCB");
  const project = obj(document.project, "native project"); keys(project, ["name", "path"], "native project");
  const filename = string(document.board_filename, "native board filename"), projectPath = string(project.path, "native project path");
  requireValue(filename === path.win32.basename(filename) && path.win32.isAbsolute(projectPath)
    && path.win32.normalize(path.win32.join(projectPath, filename)).toLowerCase() === path.win32.normalize(expected.pcbPath).toLowerCase(), "native document is not the exact expected board");
  const nativeSource = string(payload.boardSourceBefore, "native PCB source");
  requireValue(Buffer.byteLength(nativeSource, "utf8") <= 1024 * 1024 && nativeSource === payload.boardSourceAfter, "native source changed or exceeds bound");
  requireValue(freshBoardSerializationsEqual(expected.pcbSource, nativeSource), "live native and exact saved PCB sources differ");
  const board = parseFreshPcbSource(expected.pcbSource);
  const enabled = strings(payload.enabledCopperLayers, "enabled copper layers", 32); unique(enabled, "enabled copper layers");
  requireValue(enabled.every(layer => CU.test(layer)) && sameSet(enabled, expected.enabledCopperLayers.map(canonicalNativeLayer)), "enabled copper layers differ from host contract");
  const call = (value: unknown, requestType: string, responseType: string, label: string, metadata = false): Obj => {
    const c = obj(value, label); requireValue(c.requestType === requestType && c.responseType === responseType, `${label} has wrong native message types`);
    if (metadata) { const m = obj(c.responseMetadata, label + " metadata"); keys(m, ["status"], label + " metadata"); requireValue(m.status === "IRS_OK", `${label} is not a complete native success`); }
    return c;
  };
  const layerCall = call(payload.enabledLayers, "kiapi.board.commands.GetBoardEnabledLayers", "kiapi.board.commands.BoardEnabledLayersResponse", "enabled layers");
  keys(layerCall, ["requestType", "request", "responseType", "response"], "enabled layers");
  requireValue(equal(obj(layerCall.request, "layer request"), {board:document}), "layer request bound to wrong document");
  const layerResponse = obj(layerCall.response, "enabled-layer response"), allLayers = strings(layerResponse.layers, "native enabled layers", 128);
  unique(allLayers, "native enabled layers"); requireValue(sameSet(enabled, allLayers.filter(layer => CU.test(layer))) && layerResponse.copper_layer_count === enabled.length, "enabled-layer projection differs from native response");
  const rawPads = array(payload.padRecords, "raw pad records").map(value => obj(value, "raw pad"));
  const padIds = rawPads.map(raw => identity(raw.id, "raw pad UUID")); unique(padIds, "raw pad UUID inventory");
  const indices = (value: unknown, label: string): readonly number[] => array(value, label).map(index => { requireValue(Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < rawPads.length, `${label} has invalid pad index`); return index as number; });
  const boardIndices = indices(payload.boardPadRecordIndexes, "board pad indexes"); unique(boardIndices, "board pad indexes");
  requireValue(boardIndices.length === rawPads.length, "unreferenced or missing raw board pad records");
  const footprintCall = call(payload.footprintInventory, "kiapi.common.commands.GetItems", "kiapi.common.commands.GetItemsResponse", "footprint inventory", true);
  keys(footprintCall, ["requestType", "request", "responseType", "responseMetadata", "footprints"], "footprint inventory");
  requireValue(equal(footprintCall.request, {header:{document},types:["KOT_PCB_FOOTPRINT"]}), "footprint request differs from exact native selection");
  const ownership = new Set<number>();
  const footprints = array(footprintCall.footprints, "native footprints", 1024).map(value => {
    const fp = obj(value, "native footprint"); keys(fp, ["footprintId", "reference", "padRecordIndexes"], "native footprint");
    const uuid = string(fp.footprintId, "footprint UUID"), reference = string(fp.reference, "footprint reference"); requireValue(UUID.test(uuid), "invalid footprint UUID");
    const saved = board.footprints.filter(p => p.id === uuid && p.reference === reference); requireValue(saved.length === 1, "footprint ownership differs from exact saved source");
    const members = indices(fp.padRecordIndexes, "footprint pad indexes"); unique(members, "footprint pad indexes");
    requireValue(members.length === saved[0]!.pads.length, "native footprint dropped/added physical pad records");
    for (const index of members) {
      requireValue(!ownership.has(index), "duplicate native physical-pad ownership"); ownership.add(index);
      const savedPad = saved[0]!.pads.filter(p => p.physical.id === padIds[index]); requireValue(savedPad.length === 1, "native pad UUID differs from saved physical inventory");
      assertPadProjection(rawPads[index]!, savedPad[0]!, enabled);
    }
    return {instanceUuid:uuid, reference, pads:members.map(index => rawPads[index]! as JsonObject)};
  });
  requireValue(footprints.length === board.footprints.length && new Set(footprints.map(fp => fp.instanceUuid)).size === footprints.length && new Set(footprints.map(fp => fp.reference)).size === footprints.length && ownership.size === rawPads.length, "incomplete/duplicate footprint or physical-pad inventory");
  const presenceCall = call(payload.padstackPresence, "kiapi.board.commands.CheckPadstackPresenceOnLayers", "kiapi.board.commands.PadstackPresenceResponse", "padstack presence");
  keys(presenceCall, ["requestType", "request", "responseType", "response"], "padstack presence");
  const presenceRequest = obj(presenceCall.request, "presence request"); keys(presenceRequest, ["board", "items", "layers"], "presence request");
  const presenceIds = array(presenceRequest.items, "presence requested items").map(id => identity(id, "presence UUID")); unique(presenceIds, "presence requested items");
  requireValue(equal(presenceRequest.board, document) && sameSet(presenceIds, padIds) && equal(presenceRequest.layers, enabled), "presence projection has wrong document/pad/layer coverage");
  const presenceResponse = obj(presenceCall.response, "presence response"); keys(presenceResponse, ["entries"], "presence response");
  const seenPresence = new Set<string>();
  const observations = array(presenceResponse.entries, "presence entries", 131_072).map(value => {
    const entry = obj(value, "presence entry"); keys(entry, ["item", "layer", "presence"], "presence entry");
    const padUuid = identity(entry.item, "presence item"), layer = string(entry.layer, "presence layer"), key = `${padUuid}:${layer}`;
    requireValue(padIds.includes(padUuid) && enabled.includes(layer) && !seenPresence.has(key), "duplicate/unbound presence entry"); seenPresence.add(key);
    const mapped = ({PSP_PRESENT:"present",PSP_NOT_PRESENT:"absent",PSP_UNKNOWN:"unknown"} as const)[entry.presence as "PSP_PRESENT"];
    requireValue(mapped !== undefined, "unknown native presence enum"); return {padUuid,layer,presence:mapped};
  });
  requireValue(seenPresence.size === padIds.length * enabled.length, "incomplete native per-pad/layer presence");
  const source = {documentKey:canonicalJson(document),nativeSourceSha256:contentIdentity(nativeSource).digest,savedSourceSha256:contentIdentity(expected.pcbSource).digest};
  const queries = array(payload.connectivity, "native connectivity", 512).map((value, ordinal) => {
    const c = call(value, "kiapi.board.commands.GetConnectedItems", "kiapi.common.commands.GetItemsResponse", "single-source cluster", true);
    keys(c, ["sourcePrimitiveId", "requestType", "request", "responseType", "responseMetadata", "padRecordIndexes"], "single-source cluster");
    const sourceId = string(c.sourcePrimitiveId, "cluster source"); requireValue(sourceId === expected.requestedPrimitiveIds[ordinal] && padIds.includes(sourceId), "cluster source is unrequested/reordered or not a physical pad");
    requireValue(equal(c.request, {header:{document},items:[{value:sourceId}],types:["KOT_PCB_PAD"]}), "cluster request is not exact native single-pad PAD-filtered request");
    const indexes = indices(c.padRecordIndexes, "cluster indexes"); unique(indexes, "cluster indexes");
    const selectedRaw=rawPads[padIds.indexOf(sourceId)]!,selectedStack=obj(selectedRaw.pad_stack,"cluster source stack");
    const sourceHasCopper=strings(selectedStack.layers,"cluster source layers",64).some(layer=>enabled.includes(layer));
    requireValue(!sourceHasCopper||indexes.some(index=>padIds[index]===sourceId),"complete copper-pad cluster omits its own physical source");
    return {id:`native-pad-cluster:${ordinal}`,sourceUuids:[sourceId],filterTypes:["KOT_PCB_PAD"],status:"complete" as const,returnedPadUuids:indexes.map(index => padIds[index]!),rawCapture:c as JsonObject};
  });
  requireValue(queries.length === expected.requestedPrimitiveIds.length, "missing requested per-primitive connectivity results");
  const inventory = rawPads.length === 0 && footprints.length === 0 ? null : buildPadTerminalInventory({source,enabledCopperLayers:enabled,footprints,layerPresence:{source,requestedPadUuids:presenceIds,requestedLayers:enabled,observations}});
  const result: KicadNativePadObservation = {schemaVersion:KICAD_NATIVE_PAD_OBSERVATION_SCHEMA_VERSION,expectedIdentity:expectedBinding,
    savedPcbIdentity:contentIdentity(expected.pcbSource),nativePcbIdentity:contentIdentity(nativeSource),rawEnvelopeIdentity:contentIdentity(canonicalJson(envelope)),inventory,
    physicalLibraryBindings:bindKicadPhysicalFootprintLibraries(board,expected),
    clusters:{source,queries},parsedBoard:board,rawSnapshot:payload as JsonObject};
  return hardenPortableValue(result, {...LIMITS,maxBytes:16*1024*1024,maxNodes:500_000,maxOwnKeys:256}) as unknown as KicadNativePadObservation;
}

/** Actual host caller: private session performs runtime/tool checks; decoder validates raw observations before minting provenance. */
export async function collectKicadNativePadObservation(port: KicadNativePadReadPort, expected: KicadNativePadObservationExpected): Promise<KicadNativePadObservation> {
  const before = expectedIdentity(expected);
  const result = await port.readLivePcbPadSnapshot(Object.freeze([...expected.requestedPrimitiveIds]));
  requireValue(equal(before, expectedIdentity(expected)), "host expected source changed during private call");
  const observation = decodeKicadNativePadObservation(result, expected); hostObservations.add(observation); return observation;
}

export function verifyHostKicadNativePadObservation(value: unknown, expected: KicadNativePadObservationExpected): KicadNativePadObservation {
  requireValue(value !== null && typeof value === "object" && hostObservations.has(value), "observation was not produced by the current private host collector");
  const observation = value as KicadNativePadObservation;
  requireValue(equal(observation.expectedIdentity, expectedIdentity(expected)) && equal(observation.savedPcbIdentity, contentIdentity(expected.pcbSource)), "observation does not bind current host source/scope/request");
  return observation;
}
