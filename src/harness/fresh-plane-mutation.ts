import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { planeRectangleMutationSchema, type PlaneRectangleMutation } from "../integrations/kicad-plane-stage.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { compareFreshPlaneMutationRemainder, parseFreshPcbDirectZoneSourceSpans, parseFreshPcbReferenceGeometry,
  parseFreshPcbSource, type FreshReferenceZone, type FreshReferenceSetting } from "./fresh-kicad-parser.js";

type RecordValue = Record<string, unknown>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(`Plane mutation: ${message}`); };
const record = (value: unknown, label: string): RecordValue => { requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); return value as RecordValue; };
const keys = (value: RecordValue, allowed: readonly string[], label: string) => requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported fields`);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const snapshot = (value: unknown): unknown => hardenPortableValue(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 64, maxNodes: 500_000,
  maxArrayLength: 100_000, maxOwnKeys: 256, maxKeyBytes: 1024, maxStringBytes: 1024 * 1024 });

/** Decimal scalar conversion, after structural S-expression parsing. No floating-point area multiplication. */
function scaledInteger(value: string, decimals: number, maximum: bigint): bigint {
  requireValue(value.length <= 128, "numeric source token exceeds bound");
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  requireValue(match !== null, "invalid decimal scalar");
  const exponent = Number(match[4] ?? 0); requireValue(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, "unsupported scalar exponent");
  let result = BigInt(match[2]! + (match[3] ?? ""));
  const power = decimals + exponent - (match[3]?.length ?? 0);
  if (power >= 0) result *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); requireValue(result % divisor === 0n, "quantity is not exactly representable"); result /= divisor; }
  if (match[1] === "-") result = -result;
  requireValue(result >= 0n && result <= maximum, "quantity is outside the supported nonnegative range");
  return result;
}
const nm = (value: number) => Number(scaledInteger(String(value), 6, 2_000_000_000n));
const setting = (settings: readonly FreshReferenceSetting[], name: string, optional = false): FreshReferenceSetting | null => {
  const matches = settings.filter(entry => entry.name === name);
  requireValue(matches.length === 1 || optional && matches.length === 0, `expected one ${name} source setting`);
  return matches[0] ?? null;
};
const scalar = (field: FreshReferenceSetting): string => {
  requireValue(field.children.length === 0 && field.values.length === 1, `invalid ${field.name} scalar`); return field.values[0]!.value;
};
const literalSetting = (field: FreshReferenceSetting): unknown => ({ name: field.name, values: field.values, children: field.children.map(literalSetting) });
const integerString = (value: unknown, label: string, maximum = 9223372036854775807n): string => {
  requireValue(typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value) && value.length <= 19 && BigInt(value) <= maximum, `${label} must be an exact nonnegative integer string`);
  return value;
};
const coordinateString = (value: unknown): number => {
  requireValue(typeof value === "string" && /^(?:0|-?[1-9]\d*)$/u.test(value) && value.length <= 12
    && BigInt(value) >= -2_000_000_000n && BigInt(value) <= 2_000_000_000n, "native coordinate is not an exact bounded integer string");
  return Number(value);
};
const distance = (value: unknown, label: string): number => {
  const field = record(value, label); keys(field, ["value_nm"], label);
  // Distance is a pinned proto3 scalar: absent value_nm means native zero. This
  // is not used for omitted inactive island area, which remains unobserved.
  return field.value_nm === undefined ? 0 : Number(integerString(field.value_nm, label, 2_000_000_000n));
};
const protoSnapshot = (value: unknown): RecordValue => {
  const proto = record(snapshot(value), "native zone proto");
  keys(proto, ["@type", "id", "type", "layers", "outline", "name", "copper_settings", "priority", "filled", "filled_polygons", "border", "locked", "layer_properties"], "native zone proto");
  requireValue(proto["@type"] === undefined || proto["@type"] === "type.googleapis.com/kiapi.board.types.Zone", "native result type URL differs");
  const id = record(proto.id, "native zone ID"); keys(id, ["value"], "native zone ID");
  requireValue(typeof id.value === "string" && uuidPattern.test(id.value) && proto.type === "ZT_COPPER", "native zone UUID/type differs");
  requireValue(proto.layer_properties === undefined || Array.isArray(proto.layer_properties) && proto.layer_properties.length === 0,
    "native per-layer overrides are outside the characterized ordinary-zone mutation");
  return proto;
};
const protoId = (proto: RecordValue) => record(proto.id, "native ID").value as string;
const copper = (proto: RecordValue): RecordValue => {
  const result = record(proto.copper_settings, "copper settings");
  keys(result, ["connection", "clearance", "min_thickness", "island_mode", "min_island_area", "fill_mode", "hatch_settings", "net", "teardrop"], "copper settings");
  return result;
};

function zoneCapture(source: string) {
  const spans = parseFreshPcbDirectZoneSourceSpans(source);
  const geometry = parseFreshPcbReferenceGeometry(source);
  requireValue(geometry.boardVersion === 20260206, "mutation source must use the pinned KiCad 10 board format");
  for (const zone of geometry.zones) {
    requireValue(zone.status === "supported" && zone.kind === "copper" && zone.layers.length === 1
      && ["F.Cu", "B.Cu"].includes(zone.layers[0]!), "mutation inventory contains unsupported zone source");
    const fill = setting(zone.settings, "fill")!, mode = setting(fill.children, "mode", true);
    requireValue(mode === null || scalar(mode) === "0", "current mutation/refill preservation supports solid zones only");
  }
  requireValue(spans.length === geometry.zones.length, "incomplete direct zone inventory");
  return geometry;
}
function targetSource(zone: FreshReferenceZone, mutation: PlaneRectangleMutation, phase: "mutation" | "refilled") {
  requireValue(zone.uuid !== null && zone.netName === mutation.netName && same(zone.layers, [mutation.layer]), "saved target net/layer differs from request");
  const allowed = ["name", "hatch", "priority", "connect_pads", "min_thickness", "fill", "locked"];
  requireValue(zone.settings.every(entry => allowed.includes(entry.name)), "target has unsupported auxiliary settings");
  requireValue(new Set(zone.settings.map(entry => entry.name)).size === zone.settings.length, "target has duplicate auxiliary settings");
  requireValue(scalar(setting(zone.settings, "name")!) === mutation.name, "saved target name differs");
  const priorityField = setting(zone.settings, "priority", true);
  requireValue((priorityField === null ? 0 : Number(scalar(priorityField))) === mutation.priority, "saved target priority differs");
  const connection = setting(zone.settings, "connect_pads")!;
  requireValue(same(connection.values, mutation.connection === "full" ? [{ value: "yes", quoted: false }] : []), "saved connection mode differs");
  requireValue(connection.children.length === 1 && connection.children[0]!.name === "clearance" && connection.children[0]!.quantityNm === mutation.clearanceNm, "saved clearance differs");
  requireValue(setting(zone.settings, "min_thickness")!.quantityNm === mutation.minWidthNm, "saved minimum width differs");
  const fill = setting(zone.settings, "fill")!;
  requireValue(fill.values.length <= 1 && fill.values.every(value => !value.quoted && ["yes", "no"].includes(value.value)), "ambiguous filled state");
  const state = fill.values[0]?.value ?? "omitted";
  requireValue(phase === "refilled" ? state === "yes" : state !== "yes" && !zone.filledCachePresent, "target filled state/cache is inconsistent with comparison phase");
  const allowedFill = ["mode", "thermal_gap", "thermal_bridge_width", "island_removal_mode", "island_area_min"];
  requireValue(fill.children.every(child => allowedFill.includes(child.name)), "target fill has unsupported smoothing/hatch/other settings");
  const mode = setting(fill.children, "mode", true); requireValue(mode === null || scalar(mode) === "0", "target fill is not solid");
  const gap = setting(fill.children, "thermal_gap")!, spoke = setting(fill.children, "thermal_bridge_width")!;
  requireValue(gap.quantityNm !== null && spoke.quantityNm !== null, "missing saved thermal observations");
  if (mutation.connection === "thermal") requireValue(gap.quantityNm === mutation.thermalGapNm && spoke.quantityNm === mutation.thermalSpokeWidthNm, "saved thermal gap/spoke width differs");
  // Native ZONE_SETTINGS enum is ALWAYS=0, NEVER=1, AREA=2, independent of IPC enum numbers.
  const islandMode = { always: "0", never: "1", area: "2" }[mutation.islandPolicy];
  requireValue(scalar(setting(fill.children, "island_removal_mode")!) === islandMode, "saved island-removal policy differs");
  const area = setting(fill.children, "island_area_min", true);
  if (mutation.islandPolicy === "area") requireValue(area !== null && scaledInteger(scalar(area), 12, 9223372036854775807n).toString() === mutation.minIslandAreaNm2, "saved active island area differs or is not exact");
  else requireValue(area === null, "inactive island area must not be represented as enforced source data");
  requireValue(zone.outlinePolygons.length === 1 && zone.outlinePolygons[0]!.contourGroup.length === 1, "target rectangle contains extra polygons or holes");
  const points = zone.outlinePolygons[0]!.contourGroup[0]!.pointsNm;
  const r = mutation.rectangleNm;
  requireValue(same(points, [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }]), "saved rectangle differs from exact ordered requested corners");
  return { filledState: state, filledPolygonCount: zone.filledPolygons.length, savedThermalGapNm: gap.quantityNm,
    savedThermalSpokeWidthNm: spoke.quantityNm, islandMinimumArea: mutation.islandPolicy === "area"
      ? { status: "explicit-active" as const, sourceMm2: scalar(area!), requiredNm2: mutation.minIslandAreaNm2 }
      : { status: "not-serialized-not-enforced" as const } };
}

function protoControls(proto: RecordValue, mutation: PlaneRectangleMutation) {
  requireValue(proto.name === mutation.name && same(proto.layers, [mutation.layer === "F.Cu" ? "BL_F_Cu" : "BL_B_Cu"]), "native target name/layer differs");
  requireValue((proto.priority ?? 0) === mutation.priority, "native target priority differs");
  const settings = copper(proto), connection = record(settings.connection, "native connection");
  const teardrop = record(settings.teardrop, "native teardrop discriminator"); keys(teardrop, ["type"], "native teardrop discriminator");
  requireValue(teardrop.type === "TDT_NONE", "native ordinary zone cannot carry active teardrop settings");
  keys(connection, ["zone_connection", "thermal_spokes"], "native connection");
  requireValue(connection.zone_connection === (mutation.connection === "full" ? "ZCS_FULL" : "ZCS_THERMAL"), "native connection mode differs");
  // KiCad 10.0.3 ZONE::Serialize does not serialize a zone-wide thermal angle.
  const spokes = record(connection.thermal_spokes, "native thermal spokes"); keys(spokes, ["gap", "width"], "native thermal spokes");
  if (mutation.connection === "thermal") requireValue(distance(spokes.gap, "thermal gap") === mutation.thermalGapNm && distance(spokes.width, "thermal width") === mutation.thermalSpokeWidthNm, "native thermal dimensions differ");
  requireValue(distance(settings.clearance, "native clearance") === mutation.clearanceNm && distance(settings.min_thickness, "native minimum width") === mutation.minWidthNm, "native zone dimensions differ");
  const net = record(settings.net, "native net"); keys(net, ["name", "code"], "native net"); requireValue(net.name === mutation.netName, "native net differs");
  requireValue(settings.fill_mode === "ZFM_SOLID" && settings.island_mode === ({ always: "IRM_ALWAYS", never: "IRM_NEVER", area: "IRM_AREA" }[mutation.islandPolicy]), "native fill/island mode differs");
  if (settings.min_island_area !== undefined) integerString(settings.min_island_area, "native island area");
  if (mutation.islandPolicy === "area") requireValue(settings.min_island_area === mutation.minIslandAreaNm2, "active native area must be an explicit exact string");
  const outline = record(proto.outline, "native outline"); keys(outline, ["polygons"], "native outline");
  requireValue(Array.isArray(outline.polygons) && outline.polygons.length === 1, "native rectangle has extra polygons");
  const polygon = record(outline.polygons[0], "native polygon"); keys(polygon, ["outline", "holes"], "native polygon");
  requireValue(polygon.holes === undefined || Array.isArray(polygon.holes) && polygon.holes.length === 0, "native rectangle has explicit holes");
  const chain = record(polygon.outline, "native outline chain"); keys(chain, ["nodes", "closed"], "native outline chain");
  requireValue(chain.closed === true && Array.isArray(chain.nodes) && chain.nodes.length === 4, "native rectangle is not a closed four-node chain");
  const points = chain.nodes.map(value => {
    const node = record(value, "native point node"); keys(node, ["point"], "native point node");
    const point = record(node.point, "native point"); keys(point, ["x_nm", "y_nm"], "native point");
    return { x: point.x_nm === undefined ? 0 : coordinateString(point.x_nm), y: point.y_nm === undefined ? 0 : coordinateString(point.y_nm) };
  });
  const r = mutation.rectangleNm;
  requireValue(same(points, [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }]), "native rectangle corners differ");
  return { thermalSpokes: spokes, thermalGapNm: distance(spokes.gap, "observed native thermal gap"),
    thermalSpokeWidthNm: distance(spokes.width, "observed native thermal width"),
    inactiveNativeAreaNm2: mutation.islandPolicy === "area" ? null : settings.min_island_area ?? null };
}
function sourceProtoAuxiliary(zone: FreshReferenceZone, proto: RecordValue) {
  const hatch = setting(zone.settings, "hatch")!;
  requireValue(hatch.children.length === 0 && hatch.values.length === 2 && hatch.values.every(value => !value.quoted), "saved hatch border is not characterized");
  const style = hatch.values[0]!.value;
  // api_pcb_enums.cpp maps NO_HATCH to ZBS_SOLID; the S-expression emitter uses
  // none/edge/full. Invisible borders are deliberately unsupported here.
  const styles: Readonly<Record<string, string>> = { none: "ZBS_SOLID", edge: "ZBS_DIAGONAL_EDGE", full: "ZBS_DIAGONAL_FULL" };
  requireValue(Object.hasOwn(styles, style), "saved hatch border style is unsupported");
  const pitchNm = Number(scaledInteger(hatch.values[1]!.value, 6, 2_000_000_000n));
  const border = record(proto.border, "native border"); keys(border, ["style", "pitch"], "native border");
  requireValue(border.style === styles[style] && distance(border.pitch, "native border pitch") === pitchNm, "saved/native hatch border observations differ");
  return { borderStyle: style, borderPitchNm: pitchNm,
    sourceAuxiliarySettings: zone.settings.filter(field => ["hatch", "locked"].includes(field.name)).map(literalSetting),
    // ZONE::Serialize does not publish locked state. Its complete source setting
    // is retained above and compared unchanged on update, not invented from IPC.
    lockedStateNativeObservation: "not-serialized-by-pinned-zone-api" as const };
}
function auxiliarySource(zone: FreshReferenceZone, mutation: PlaneRectangleMutation) {
  return zone.settings.filter(field => ["hatch", "locked", "fill"].includes(field.name)).map(field => field.name !== "fill" ? literalSetting(field) : {
    name: "fill", children: field.children.filter(child => !["mode", "island_removal_mode", "island_area_min",
      ...(mutation.connection === "thermal" ? ["thermal_gap", "thermal_bridge_width"] : [])].includes(child.name)).map(literalSetting),
  });
}
function auxiliaryProto(proto: RecordValue, mutation: PlaneRectangleMutation) {
  const copy = structuredClone(proto); for (const key of ["@type", "outline", "name", "layers", "priority", "filled", "filled_polygons"]) delete copy[key];
  const settings = copper(copy); for (const key of ["clearance", "min_thickness", "island_mode", "net", "fill_mode"]) delete settings[key];
  if (mutation.islandPolicy === "area") delete settings.min_island_area;
  const connection = record(settings.connection, "native connection"); delete connection.zone_connection;
  if (mutation.connection === "thermal") {
    const spokes = record(connection.thermal_spokes, "native spokes"); delete spokes.gap; delete spokes.width;
  }
  return copy;
}

export interface FreshPlaneLiteralMutationComparisonInput {
  readonly mutation: PlaneRectangleMutation;
  readonly beforePcbSource: string; readonly afterPcbSource: string;
  readonly returnedZoneProto: unknown; readonly beforeZoneProto?: unknown;
  readonly phase: "mutation" | "refilled";
}
/** Low-level host literal proof. This does not bind or accept any V2 design contract. */
export function compareFreshPlaneLiteralMutation(input: FreshPlaneLiteralMutationComparisonInput) {
  const mutation = planeRectangleMutationSchema.parse(snapshot(input.mutation));
  requireValue(input.phase === "mutation" || input.phase === "refilled", "invalid comparison phase");
  const before = zoneCapture(input.beforePcbSource), after = zoneCapture(input.afterPcbSource);
  const native = protoSnapshot(input.returnedZoneProto), targetZoneUuid = protoId(native);
  if (mutation.operation === "update") requireValue(targetZoneUuid === mutation.zoneId, "update returned a different UUID");
  const target = after.zones.find(zone => zone.uuid === targetZoneUuid);
  requireValue(target !== undefined && after.zones.filter(zone => setting(zone.settings, "name", true)?.values[0]?.value === mutation.name).length === 1, "target zone is absent or its name is ambiguous");
  const observed = targetSource(target, mutation, input.phase);
  const nativeObserved = protoControls(native, mutation);
  const auxiliaryObserved = sourceProtoAuxiliary(target, native);
  requireValue(observed.savedThermalGapNm === nativeObserved.thermalGapNm && observed.savedThermalSpokeWidthNm === nativeObserved.thermalSpokeWidthNm,
    "saved and returned native thermal observations differ, including inactive fields");
  let targetAuxiliaryPreserved = true;
  if (mutation.operation === "update") {
    const old = before.zones.find(zone => zone.uuid === mutation.zoneId); requireValue(old !== undefined, "update target is absent before mutation");
    requireValue(old.settings.every(field => ["name", "hatch", "priority", "connect_pads", "min_thickness", "fill", "locked"].includes(field.name)), "before target contains unsupported auxiliary settings");
    const oldNative = protoSnapshot(input.beforeZoneProto); requireValue(protoId(oldNative) === mutation.zoneId, "before native UUID differs from update target");
    sourceProtoAuxiliary(old, oldNative);
    const oldName = setting(old.settings, "name", true);
    requireValue((oldNative.name ?? "") === (oldName === null ? "" : scalar(oldName)) && record(copper(oldNative).net, "before native net").name === old.netName,
      "before native target identity differs from saved source");
    targetAuxiliaryPreserved = same(auxiliarySource(old, mutation), auxiliarySource(target, mutation)) && same(auxiliaryProto(oldNative, mutation), auxiliaryProto(native, mutation));
  } else requireValue(input.beforeZoneProto === undefined, "create cannot claim a before target proto");
  const sourceComparison = compareFreshPlaneMutationRemainder({ beforePcbSource: input.beforePcbSource, afterPcbSource: input.afterPcbSource,
    beforeTargetUuid: mutation.operation === "update" ? mutation.zoneId : null, afterTargetUuid: targetZoneUuid, phase: input.phase });
  const valid = sourceComparison.equal && targetAuxiliaryPreserved;
  return freezePcbPlaneArtifact({ schemaVersion: "evleda.fresh-plane-mutation-comparison.v1", binding: "host-literal-only",
    valid, status: valid ? "conformant" as const : "mismatch" as const, mutation, targetZoneUuid, targetAuxiliaryPreserved, sourceComparison,
    beforeIdentity: contentIdentity(input.beforePcbSource), afterIdentity: contentIdentity(input.afterPcbSource),
    nativeProtoIdentity: canonicalIdentity(native, "evleda.native-zone-proto-observation.v1"), nativeProtoSnapshot: native,
    observed: { ...observed, auxiliary: auxiliaryObserved, native: nativeObserved, minimumSpokes: { required: mutation.connection === "thermal" ? mutation.minimumSpokes : null,
      zoneApiConfigured: false, enforcement: mutation.connection === "thermal" ? "external-owned-rule-and-native-evidence" : "not-applicable" } },
    fillCacheFreshness: "unverified", nativeEpochValidated: false, dcConnectivity: "not_evaluated", highFrequencyValidity: "not_established",
    impedance: "not_evaluated", thermalAcceptance: "not_evaluated", acceptanceEvaluated: false });
}

export interface PreparedFreshPlaneMutation {
  readonly schemaVersion: "evleda.fresh-plane-mutation-spec.v1";
  readonly identity: CanonicalIdentity;
  readonly bundleIdentity: CanonicalIdentity; readonly contractIdentity: CanonicalIdentity; readonly rulesIdentity: ContentIdentity;
  readonly planeId: string; readonly mutation: PlaneRectangleMutation; readonly beforeSourceIdentity: ContentIdentity;
  readonly beforeZoneUuids: readonly string[]; readonly targetZoneUuid: string | null;
  readonly requirements: Readonly<{ minimumIslandAreaMm2: number; minimumAreaEnforcement: "not-enforced-by-always-mode";
    minimumSpokes: number | null; spokeEnforcement: "external-owned-rule-and-native-evidence" | "not-applicable" }>;
}
const preparedSources = new WeakMap<object, string>();
export function prepareFreshPlaneMutation(input: { readonly compilationBundle: PcbPlaneCompilationBundle; readonly beforePcbSource: string;
  readonly planeId?: string; readonly operation: "create" | "update"; readonly zoneId?: string }): PreparedFreshPlaneMutation {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(input.compilationBundle), "prepare requires an authenticated actual V2 bundle");
  const bundle = input.compilationBundle, plane = input.planeId === undefined ? bundle.contract.planes[0] : bundle.contract.planes.find(plane => plane.id === input.planeId);
  requireValue(plane !== undefined, "unknown plane ID");
  const before = zoneCapture(input.beforePcbSource), rules = createFreshPlaneRules(bundle), rule = rules.zones.find(zone => zone.planeId === plane.id)!;
  const pcb = parseFreshPcbSource(input.beforePcbSource);
  requireValue(pcb.footprints.some(footprint => footprint.pads.some(pad => pad.netName === plane.net))
    || pcb.segments.some(segment => segment.netName === plane.net) || before.zones.some(zone => zone.netName === plane.net), "plane net does not exist in saved source");
  const named = before.zones.filter(zone => setting(zone.settings, "name", true)?.values[0]?.value === rule.zoneName);
  if (input.operation === "create") requireValue(input.zoneId === undefined && named.length === 0, "create would duplicate the declared plane or accepts an unexpected zoneId");
  else requireValue(typeof input.zoneId === "string" && named.length === 1 && named[0]!.uuid === input.zoneId, "update must select the exact existing bundle-named plane");
  const mutation = planeRectangleMutationSchema.parse({ operation: input.operation, ...(input.operation === "update" ? { zoneId: input.zoneId } : {}),
    netName: plane.net, layer: plane.layer, name: rule.zoneName, priority: 0,
    rectangleNm: { x1: nm(plane.boundary.minXmm), y1: nm(plane.boundary.minYmm), x2: nm(plane.boundary.maxXmm), y2: nm(plane.boundary.maxYmm) },
    clearanceNm: nm(plane.clearanceMm), minWidthNm: nm(plane.minimumCopperWidthMm), islandPolicy: "always",
    ...(plane.padConnection.mode === "thermal" ? { connection: "thermal", thermalGapNm: nm(plane.padConnection.gapMm), thermalSpokeWidthNm: nm(plane.padConnection.spokeWidthMm), minimumSpokes: plane.padConnection.minimumConnectedSpokes } : { connection: "full" }) });
  const payload = { schemaVersion: "evleda.fresh-plane-mutation-spec.v1" as const, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
    rulesIdentity: rules.identity, planeId: plane.id, mutation, beforeSourceIdentity: contentIdentity(input.beforePcbSource),
    beforeZoneUuids: before.zones.map(zone => zone.uuid!), targetZoneUuid: input.operation === "update" ? input.zoneId! : null,
    requirements: { minimumIslandAreaMm2: plane.islandPolicy.minimumAreaMm2, minimumAreaEnforcement: "not-enforced-by-always-mode" as const,
      minimumSpokes: plane.padConnection.mode === "thermal" ? plane.padConnection.minimumConnectedSpokes : null,
      spokeEnforcement: plane.padConnection.mode === "thermal" ? "external-owned-rule-and-native-evidence" as const : "not-applicable" as const } };
  const prepared = freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  preparedSources.set(prepared, input.beforePcbSource);
  return prepared;
}
export function compareFreshPlaneMutation(input: Omit<FreshPlaneLiteralMutationComparisonInput, "mutation" | "beforePcbSource"> & { readonly prepared: PreparedFreshPlaneMutation }) {
  const beforePcbSource = preparedSources.get(input.prepared);
  requireValue(beforePcbSource !== undefined, "comparison requires the original in-process prepared V2 spec");
  const result = compareFreshPlaneLiteralMutation({ ...input, beforePcbSource, mutation: input.prepared.mutation });
  return freezePcbPlaneArtifact({ ...result, binding: "authenticated-v2-mutation-spec", preparedSpecIdentity: input.prepared.identity,
    bundleIdentity: input.prepared.bundleIdentity, contractIdentity: input.prepared.contractIdentity, rulesIdentity: input.prepared.rulesIdentity,
    requirements: input.prepared.requirements, acceptanceEvaluated: false });
}
