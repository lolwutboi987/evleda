import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { isKicadTransmissionLineCalculator, type KicadTransmissionLineCalculator, type KicadTransmissionLineResult } from "../integrations/kicad-transmission-line.js";
import { assessDifferentialPairGeometry, type DifferentialPairGeometryAssessment, type DifferentialPairTrack, type DifferentialPairPad,
  type DifferentialPairVia, type DifferentialPairExactLength, type DifferentialPairSquaredDistance } from "./differential-pair-geometry.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbRouteSourceSpans, parseFreshPcbSource, parseFreshPcbStackup, type FreshPcbReferenceGeometry,
  type FreshPcbStackup, type FreshStackupField } from "./fresh-kicad-parser.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import type { PcbInterfaceConstruction } from "./pcb-interface-requirements.js";
import { assessDifferentialChannelGeometry, type DifferentialChannelGeometryAssessment } from "./differential-channel-geometry.js";
import { channelMemberNets } from "./pcb-channel-width.js";
import { readSavedPcbSourceForm as readForm, savedPcbSourceField as field, savedPcbSourceScalar as scalar,
  exactSavedPcbSourceDecimal as exactDecimal, savedPcbSourcePoint as sourcePoint, savedPcbSourceRotation as rotation,
  savedPcbSourceUuid as sourceId, boundedSavedPcbNm as boundedNm, assertSavedPcbPhysicalFormParents as assertParents,
  deriveSavedBareMicrostripConstruction as deriveBareConstruction, savedPcbStackupThickness as thickness,
  explicitSavedPcbStackupField as explicit, savedPcbSourceFailure as sourceFailure, isSupportedSavedPcbSmdPadField,
  type SavedMicrostripRequest } from "./saved-microstrip-assessment.js";

export const SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION = "evleda.saved-interface-assessment.v1" as const;
type PcbDifferentialPairRequirement = NonNullable<PcbPlaneCompilationBundle["contract"]["interfaceRequirements"]>["interfaces"][number];
export const SAVED_INTERFACE_ASSESSMENT_BOUNDS = Object.freeze({ maximumInputBytes: 8 * 1024 * 1024,
  maximumAssessedSourceBytes: 1024 * 1024, maximumModelIntervals: 128, maximumSourcePhysicalPads: 2048 });
export interface SavedInterfaceReason { readonly code: string; readonly message: string }
export interface SavedInterfaceAssessmentInput {
  readonly savedPcbBytes: Uint8Array; readonly compilationBundle: PcbPlaneCompilationBundle; readonly interfaceId: string;
  readonly calculator?: KicadTransmissionLineCalculator;
}
export interface SavedInterfaceSourceInventory {
  readonly status: "complete" | "unsupported"; readonly reasons: readonly SavedInterfaceReason[];
  readonly selected: Readonly<{ tracks: readonly DifferentialPairTrack[]; pads: readonly DifferentialPairPad[]; vias: readonly DifferentialPairVia[] }>;
  readonly observations: readonly Readonly<{ kind: "track" | "pad" | "via" | "unsupported_route"; uuid: string | null; net: string | null;
    sourceIdentity: ContentIdentity; status: "supported" | "unsupported"; reasons: readonly SavedInterfaceReason[] }>[];
  readonly projectionComplete: boolean;
}
export interface SavedInterfaceConstructionAssessment {
  readonly status: "matched_saved_declaration" | "failed_saved_declaration" | "unassessed";
  readonly reasons: readonly SavedInterfaceReason[];
  readonly observed: Readonly<{ boardThicknessNm: number | null; frontCopperThicknessNm: number | null; backCopperThicknessNm: number | null;
    dielectricThicknessNm: number | null; frontMaskThicknessNm: number | null; backMaskThicknessNm: number | null;
    copperLayerOrder: readonly string[]; dielectricMaterial: string | null; relativePermittivity: number | null; lossTangent: number | null;
    surfaceFinish: string | null; stackupSourceIdentity: ContentIdentity | null }>;
  readonly physicalConstruction: "not_verified"; readonly assertionAuthority: "bound_caller_assertions";
  readonly sourceUnverifiedAssertionFields: readonly string[];
}
export interface SavedInterfaceTerminationPin {
  readonly side: "source" | "receiver"; readonly polarity: "positive" | "negative";
  readonly kind: "integrated" | "parallel" | "source_series";
  readonly reference: string; readonly pin: string; readonly expectedNet: string;
  readonly matchingPadUuids: readonly string[]; readonly endpointPadUuid: string | null;
  readonly distanceSquaredNm2: string | null; readonly maximumDistanceNm: number | null;
  readonly status: "matched_source_facts" | "failed_source_facts" | "unassessed"; readonly reasons: readonly SavedInterfaceReason[];
}
export interface SavedInterfaceTerminationAssessment {
  readonly status: "matched_source_facts" | "failed_source_facts" | "unassessed"; readonly reasons: readonly SavedInterfaceReason[];
  readonly pins: readonly SavedInterfaceTerminationPin[]; readonly assertedResistanceOhms: readonly Readonly<{ side: "source" | "receiver"; value: number }>[];
  readonly resistanceVerification: "caller_assertion_only"; readonly deviceInternalTermination: "not_verified";
}
export interface SavedInterfaceReferenceRequirements {
  readonly declarationStatus: "matched_saved_zone" | "unassessed"; readonly reasons: readonly SavedInterfaceReason[];
  readonly planeId: string; readonly net: string | null; readonly layer: string | null; readonly memberNets: readonly string[];
  readonly matchingZoneUuids: readonly string[]; readonly zoneSourceIdentity: ContentIdentity | null; readonly savedFillCachePresent: boolean | null;
  readonly fillFreshness: "not_verified"; readonly wholeRouteCoverage: "not_evaluated"; readonly referenceElectricalEligibility: "not_evaluated";
}
export interface SavedInterfaceImpedanceInterval {
  readonly index: number; readonly positiveRunIndex: number; readonly negativeRunIndex: number;
  readonly positiveMemberUuids: readonly string[]; readonly negativeMemberUuids: readonly string[];
  readonly positiveWidthNm: number; readonly negativeWidthNm: number; readonly centerlineSquaredNm2: DifferentialPairSquaredDistance;
  readonly radiusSumTwiceNm: string; readonly length: DifferentialPairExactLength;
  readonly numericalGapNm: number | null; readonly numericalLengthNm: number | null;
  readonly status: "within_tolerance" | "outside_tolerance" | "unassessed"; readonly reasons: readonly SavedInterfaceReason[];
  readonly applicability: Readonly<{ status: "conditional_model_only" | "unassessed"; widthToHeightRatio: number | null;
    gapToHeightRatio: number | null; frequencyGHzTimesHeightMm: number | null; finiteThicknessCaveat: string }>;
  readonly calculatedDifferentialOhm: number | null; readonly residualOhm: number | null; readonly calculation: KicadTransmissionLineResult | null;
}
export interface SavedInterfaceImpedanceAssessment {
  readonly status: "not_requested" | "within_tolerance" | "outside_tolerance" | "unassessed"; readonly reasons: readonly SavedInterfaceReason[];
  readonly targetOhm: number | null; readonly absoluteToleranceOhm: number | null; readonly frequencyHz: number | null;
  readonly intervals: readonly SavedInterfaceImpedanceInterval[]; readonly completeRouteModelCoverage: boolean;
  readonly differentialBasis: "twice_frequency_dependent_odd_mode_Z0_O";
  readonly unmodeledEffects: readonly string[];
}
export interface SavedInterfaceAssessment {
  readonly schemaVersion: typeof SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION;
  readonly sourceIdentity: ContentIdentity; readonly bundleIdentity: CanonicalIdentity; readonly contractIdentity: CanonicalIdentity;
  readonly verificationPlanIdentity: CanonicalIdentity; readonly interfaceId: string; readonly requirementIdentity: CanonicalIdentity;
  readonly sourceInventory: SavedInterfaceSourceInventory; readonly geometry: DifferentialPairGeometryAssessment | null;
  readonly channel?: DifferentialChannelGeometryAssessment & { readonly protectionReturns: readonly Readonly<{ reference: string; pin: string; expectedNet: string;
    matchingPadUuids: readonly string[]; status: "pass" | "fail" | "not_assessed" }>[] };
  readonly construction: SavedInterfaceConstructionAssessment; readonly terminations: SavedInterfaceTerminationAssessment;
  readonly referenceRequirements: SavedInterfaceReferenceRequirements; readonly impedance: SavedInterfaceImpedanceAssessment;
  readonly unevaluatedRows: readonly Readonly<{ id: string; kind: string; reasons: readonly SavedInterfaceReason[] }>[];
  readonly limits: typeof SAVED_INTERFACE_ASSESSMENT_BOUNDS;
  readonly sourceAuthority: "saved_byte_numerical_facts_and_bound_caller_assertions";
  readonly nativeReachability: "not_evaluated"; readonly libraryMembership: "not_verified";
  readonly boardAccepted: false; readonly interfaceAccepted: false; readonly fabricationAuthorized: false;
  readonly identity: CanonicalIdentity;
}

const reason = (code: string, message: string): SavedInterfaceReason => ({ code, message });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
class Unsupported extends Error { constructor(readonly code: string, message: string) { super(message); } }
function need(value: unknown, code: string, message: string): asserts value { if (!value) throw new Unsupported(code, message); }
const failure = (error: unknown, fallback: string): SavedInterfaceReason => error instanceof Unsupported ? reason(error.code, error.message) : sourceFailure(error, fallback);
function freeze<T>(value: T): T { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function mmNm(value: number): number {
  const amount = decimal(String(value)), scaled = amount.n * 1_000_000n;
  need(scaled >= 0n && scaled % amount.d === 0n && scaled / amount.d <= 1_000_000_000_000_000n,
    "EXACT_LIMIT_NM_REQUIRED", "Declared dimensions and limits must be exact nonnegative nanometres within their independent quantity bound.");
  return Number(scaled / amount.d);
}
const pairNets = channelMemberNets;
const selector = (endpoint: { readonly reference: string; readonly pin: string }) => ({ reference: endpoint.reference, pad: endpoint.pin });
const expectedNet = (pair: PcbDifferentialPairRequirement, side: "source" | "receiver", polarity: "positive" | "negative") => pair.nets[side === "receiver" && pair.routing.polarityInversion.receiverMapping === "inverted" ? polarity === "positive" ? "negative" : "positive" : polarity];
function terminationSelectors(pair: PcbDifferentialPairRequirement) {
  return (["source", "receiver"] as const).flatMap(side => {
    const value = pair.terminations[side];
    return value.kind === "parallel" ? [{ reference: value.componentReference, pad: value.positivePin }, { reference: value.componentReference, pad: value.negativePin }] : [];
  }).concat(pair.channel && pair.terminations.source.kind === "source_series" ? [
    ...(["positive", "negative"] as const).flatMap(p => {
      const leg = pair.terminations.source.kind === "source_series" ? pair.terminations.source[p] : null;
      return leg ? [leg.sourcePin, leg.linePin].map(pad => ({ reference: leg.componentReference, pad })) : [];
    }), ...pair.channel.additionalReceivers.flatMap(r => [selector(r.positive), selector(r.negative)]),
    ...pair.channel.protection.flatMap(p => [...p.positivePins, ...p.negativePins, p.ground.pin, p.supply.pin].map(pad => ({ reference: p.componentReference, pad })))
  ] : []);
}

function extractSource(source: string, geometry: FreshPcbReferenceGeometry, pair: PcbDifferentialPairRequirement): SavedInterfaceSourceInventory {
  const nets = new Set(pairNets(pair)), reasons: SavedInterfaceReason[] = [];
  const returnSelector = (reference: string, pin: string) => pair.channel?.protection.some(p => p.componentReference === reference && [p.ground.pin, p.supply.pin].includes(pin)) === true;
  const tracks: DifferentialPairTrack[] = geometry.segments.filter(item => item.netName !== null && nets.has(item.netName)).map(item => ({ uuid: item.uuid, net: item.netName!, layer: item.layer,
    start: { xNm: item.startNm.x, yNm: item.startNm.y }, end: { xNm: item.endNm.x, yNm: item.endNm.y }, widthNm: item.widthNm, sourceIdentity: item.sourceIdentity }));
  const pads: DifferentialPairPad[] = [], vias: DifferentialPairVia[] = [];
  let physicalBoard: ReturnType<typeof parseFreshPcbSource> | null = null;
  const observations: SavedInterfaceSourceInventory["observations"][number][] = tracks.map(item => ({ kind: "track", uuid: item.uuid, net: item.net, sourceIdentity: item.sourceIdentity!, status: "supported", reasons: [] }));
  const attempt = (operation: () => void, code: string) => { try { operation(); } catch (error) { reasons.push(failure(error, code)); } };
  // This caller separately validates every saved zone and its filled-contour
  // grammar. The legacy single-route caller retains its original stricter mode.
  attempt(() => assertParents(source, true), "SOURCE_PARENT_SCOPE_UNSUPPORTED");
  attempt(() => {
    need(geometry.issues.length === 0 && geometry.zones.every(zone => zone.status === "supported") && geometry.otherObservations.every(item => item.kind === "footprint"),
      "SOURCE_INVENTORY_UNSUPPORTED", "Unknown, nested or unmodeled copper cannot be omitted from source inventory.");
    need(!geometry.zones.some(zone => zone.netName !== null && nets.has(zone.netName) && zone.kind !== "rule_area"), "SELECTED_ZONE_COPPER_UNSUPPORTED", "Selected member zone copper is outside the complete track-centerline model.");
    const spans = parseFreshPcbRouteSourceSpans(source), trackSpans = spans.filter(span => span.kind === "track"), viaSpans = spans.filter(span => span.kind === "via");
    need(trackSpans.length === geometry.segments.length && trackSpans.every(span => geometry.segments.filter(segment => segment.uuid === span.id).length === 1), "TRACK_INVENTORY_MISMATCH", "Strict source spans and exact segment inventory must be bijective.");
    need(geometry.unsupportedRouteItems.length === viaSpans.length && geometry.unsupportedRouteItems.every(item => item.kind === "via"), "UNSUPPORTED_ROUTE_PRIMITIVE", "Arcs and unattributed unsupported route items cannot disappear from assessment.");
  }, "ROUTE_SPAN_UNSUPPORTED");
  try {
    const board = physicalBoard = parseFreshPcbSource(source), footprintSources = geometry.otherObservations.filter(item => item.kind === "footprint");
    const forms = footprintSources.map(item => ({ form: readForm(item.source), sourceIdentity: item.sourceIdentity }));
    const byId = new Map(forms.map(item => [sourceId(item.form), item]));
    need(forms.length === board.footprints.length && byId.size === forms.length && new Set(board.footprints.map(fp => fp.reference)).size === board.footprints.length,
      "FOOTPRINT_INVENTORY_AMBIGUOUS", "Every footprint source and reference must have one unambiguous physical identity.");
    need(board.footprints.reduce((sum, fp) => sum + fp.pads.length, 0) <= SAVED_INTERFACE_ASSESSMENT_BOUNDS.maximumSourcePhysicalPads, "PAD_INVENTORY_WORK_BOUND", "The complete physical pad inventory exceeds the assessment work bound.");
    for (const fp of board.footprints) {
      need(fp.id !== null && byId.has(fp.id), "FOOTPRINT_SOURCE_MISSING", "Every physical footprint requires a retained source identity.");
      const footprint = byId.get(fp.id)!.form, rawPads = footprint.children.filter(item => item.name === "pad");
      need(rawPads.length === fp.pads.length, "PAD_INVENTORY_MISMATCH", "Raw and projected physical pad inventories differ.");
      for (const form of rawPads) {
        const uuid = sourceId(form), projected = fp.pads.filter(pad => pad.physical.id === uuid);
        need(projected.length === 1 && form.atoms.length === 3 && form.atoms[0]!.value === projected[0]!.number, "PAD_IDENTITY_AMBIGUOUS", "Each raw pad must match exactly one projected physical pad and number.");
        const pad = projected[0]!, netForms = form.children.filter(item => item.name === "net");
        need(netForms.length <= 1 && netForms.every(net => net.children.length === 0 && [1, 2].includes(net.atoms.length)), "PAD_NET_AMBIGUOUS", "Every pad net must resolve before net selection.");
        if (netForms.length) {
          const net = netForms[0]!, nullNet = net.atoms.length === 1 ? ["", "0"].includes(net.atoms[0]!.value) : net.atoms[0]!.value === "0" && net.atoms[1]!.value === "";
          need(pad.netName !== null || nullNet, "PAD_NET_UNRESOLVED", "A declared pad net cannot become an unassigned projection.");
          if (net.atoms.length === 2) need(pad.netName === (net.atoms[1]!.value || null), "PAD_NET_MISMATCH", "Legacy numeric and named pad nets disagree.");
        }
        if (pad.netName === null || !nets.has(pad.netName) && !returnSelector(fp.reference, pad.number)) continue;
        const sourceIdentity = contentIdentity(pad.physical.source);
        try {
          const placement = field(footprint, "at")!, origin = sourcePoint(placement, true), angle = rotation(placement);
          const localAt = field(form, "at")!, local = sourcePoint(localAt, true); rotation(localAt);
          need(form.atoms[1]!.value === "smd" && ["rect", "roundrect", "circle", "oval"].includes(form.atoms[2]!.value)
            && form.children.every(child => isSupportedSavedPcbSmdPadField(child.name) && child.children.length === 0)
            && new Set(form.children.map(child => child.name)).size === form.children.length, "PAD_SHAPE_UNSUPPORTED", "Only exact ordinary cardinal SMD anchors without drills, offsets or custom pad stacks are supported.");
          const size = sourcePoint(field(form, "size")!); need(size.x > 0 && size.y > 0, "PAD_SIZE_UNSUPPORTED", "Pad dimensions must be positive exact nanometres.");
          const copper = pad.layers.filter(layer => layer.endsWith(".Cu"));
          need(copper.length === 1 && copper[0] === fp.layer && ["F.Cu", "B.Cu"].includes(fp.layer) && !pad.layers.some(layer => layer.includes("*")), "PAD_LAYER_UNSUPPORTED", "An ordinary SMD pad must have exactly its footprint's outer copper layer.");
          const rotated = angle === 0 ? local : angle === 90 ? { x: local.y, y: -local.x } : angle === 180 ? { x: -local.x, y: -local.y } : { x: -local.y, y: local.x };
          pads.push({ uuid, net: pad.netName, reference: fp.reference, pad: pad.number, layers: copper,
            center: { xNm: boundedNm(origin.x + rotated.x), yNm: boundedNm(origin.y + rotated.y) }, sourceIdentity });
          observations.push({ kind: "pad", uuid, net: pad.netName, sourceIdentity, status: "supported", reasons: [] });
        } catch (error) {
          const problem = failure(error, "PAD_PROJECTION_UNSUPPORTED"); reasons.push(problem);
          observations.push({ kind: "pad", uuid, net: pad.netName, sourceIdentity, status: "unsupported", reasons: [problem] });
        }
      }
    }
    const declared = [pair.endpoints.source.positive, pair.endpoints.source.negative, pair.endpoints.receiver.positive, pair.endpoints.receiver.negative].map(selector).concat(terminationSelectors(pair));
    for (const terminal of declared) {
      const matches = board.footprints.filter(fp => fp.reference === terminal.reference).flatMap(fp => fp.pads.filter(pad => pad.number === terminal.pad));
      need(matches.length <= 1, "SPLIT_PHYSICAL_TERMINAL_UNSUPPORTED", "A logical terminal selector names multiple physical pads; internal ties cannot be assumed.");
    }
    for (const via of board.vias) {
      const raw = geometry.unsupportedRouteItems.filter(item => item.kind === "via" && (() => { try { return sourceId(readForm(item.source)) === via.id; } catch { return false; } })());
      need(via.id !== null && via.netName !== null && raw.length === 1, "VIA_SOURCE_UNATTRIBUTED", "Every via requires exactly one net-resolved source record.");
      if (!nets.has(via.netName)) continue;
      const retained = raw[0]!, sourceIdentity = retained.sourceIdentity;
      try {
        const form = readForm(retained.source), center = sourcePoint(field(form, "at")!), diameterNm = exactDecimal(scalar(field(form, "size")!)), drillNm = exactDecimal(scalar(field(form, "drill")!));
        need(same(via.layers, ["F.Cu", "B.Cu"]) && via.at.x === center.x / 1e6 && via.at.y === center.y / 1e6 && via.diameterMm === diameterNm / 1e6 && via.drillMm === drillNm / 1e6,
          "VIA_PROJECTION_MISMATCH", "The selected via's complete exact geometry and layer span must agree with its source projection.");
        vias.push({ uuid: via.id, net: via.netName, layers: via.layers, center: { xNm: center.x, yNm: center.y }, diameterNm, drillNm, sourceIdentity });
        observations.push({ kind: "via", uuid: via.id, net: via.netName, sourceIdentity, status: "supported", reasons: [] });
      } catch (error) { const problem = failure(error, "VIA_PROJECTION_UNSUPPORTED"); reasons.push(problem); observations.push({ kind: "via", uuid: via.id, net: via.netName, sourceIdentity, status: "unsupported", reasons: [problem] }); }
    }
  } catch (error) { reasons.push(failure(error, "PHYSICAL_INVENTORY_UNSUPPORTED")); }
  // An earlier physical-identity error must not erase later selected-pad
  // identities. Numeric projection remains explicitly incomplete.
  for (const fp of physicalBoard?.footprints ?? []) for (const pad of fp.pads) {
    if (pad.netName === null || !nets.has(pad.netName) && !returnSelector(fp.reference, pad.number)) continue;
    const sourceIdentity = contentIdentity(pad.physical.source);
    if (observations.some(item => same(item.sourceIdentity, sourceIdentity))) continue;
    const problem = reason("PAD_PROJECTION_UNASSESSED", "This selected physical pad is retained by source identity; an earlier source error prevented a complete supported numerical projection.");
    observations.push({ kind: "pad", uuid: pad.physical.id, net: pad.netName, sourceIdentity, status: "unsupported", reasons: [problem] });
    reasons.push(problem);
  }
  for (const retained of geometry.unsupportedRouteItems) {
    if (observations.some(item => same(item.sourceIdentity, retained.sourceIdentity))) continue;
    let uuid: string | null = null, net: string | null = null, resolvedNet = false;
    try {
      const form = readForm(retained.source); uuid = sourceId(form);
      net = physicalBoard?.vias.find(via => via.id === uuid)?.netName ?? physicalBoard?.segments.find(track => track.id === uuid)?.netName ?? null;
      resolvedNet = net !== null;
      const rawNet = field(form, "net", true);
      if (net === null && rawNet?.atoms.length === 1 && rawNet.atoms[0]!.quoted) net = rawNet.atoms[0]!.value;
    } catch { /* Its complete source identity remains, without a guessed UUID/net. */ }
    if (retained.kind === "via" && resolvedNet && net !== null && !nets.has(net)) continue;
    const problem = reason("UNSUPPORTED_RETAINED_ROUTE_FORM", "A complete retained route form has no supported selected-primitive projection; its source identity cannot be omitted.");
    observations.push({ kind: "unsupported_route", uuid, net, sourceIdentity: retained.sourceIdentity, status: "unsupported", reasons: [problem] }); reasons.push(problem);
  }
  return { status: reasons.length ? "unsupported" : "complete", reasons, selected: { tracks, pads, vias }, observations, projectionComplete: reasons.length === 0 };
}

/** Exact decimal rational for declaration equality and frequency domain guards.
 * Source values that binary64 would round to the declaration still differ. */
function decimal(value: string): { n: bigint; d: bigint } {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  need(value.length <= 128 && match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "DECIMAL_UNSUPPORTED", "A bounded exact decimal scalar is required.");
  const power = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  need(Number.isSafeInteger(power) && Math.abs(power) <= 1000, "DECIMAL_UNSUPPORTED", "Decimal exponent exceeds exact assessment bounds.");
  const n = BigInt((match[2]! + (match[3] ?? "")) || "0") * (match[1] === "-" ? -1n : 1n);
  return power >= 0 ? { n: n * 10n ** BigInt(power), d: 1n } : { n, d: 10n ** BigInt(-power) };
}
function exactSourceNumberMatches(value: FreshStackupField<number>, expected: number): boolean {
  explicit(value, "numerical material declaration"); const atom = scalar(readForm(value.sources[0]!));
  need(!atom.quoted, "DECIMAL_UNSUPPORTED", "Numerical material declarations must be unquoted scalars.");
  const a = decimal(atom.value), b = decimal(String(expected)); return a.n * b.d === b.n * a.d;
}
function emptyConstruction(): SavedInterfaceConstructionAssessment {
  return { status: "unassessed", reasons: [], observed: { boardThicknessNm: null, frontCopperThicknessNm: null, backCopperThicknessNm: null,
    dielectricThicknessNm: null, frontMaskThicknessNm: null, backMaskThicknessNm: null, copperLayerOrder: [], dielectricMaterial: null,
    relativePermittivity: null, lossTangent: null, surfaceFinish: null, stackupSourceIdentity: null }, physicalConstruction: "not_verified",
    assertionAuthority: "bound_caller_assertions", sourceUnverifiedAssertionFields: ["material_frequency_basis", "conductivity", "conductor_permeability", "substrate_permeability", "roughness", "exterior_air", "source_citations"] };
}
function compareConstruction(stackup: FreshPcbStackup, declared: PcbInterfaceConstruction | null): SavedInterfaceConstructionAssessment {
  const result = emptyConstruction(), observed = { ...result.observed, copperLayerOrder: stackup.boardCopperLayerOrder,
    stackupSourceIdentity: stackup.stackupSource === null ? null : contentIdentity(stackup.stackupSource) };
  const problems: SavedInterfaceReason[] = [], mismatches: SavedInterfaceReason[] = [];
  const attempt = (operation: () => void) => { try { operation(); } catch (error) { problems.push(failure(error, "CONSTRUCTION_UNSUPPORTED")); } };
  const match = (condition: boolean, label: string) => { if (!condition) mismatches.push(reason("SAVED_CONSTRUCTION_MISMATCH", `Saved ${label} differs from the authenticated bundle declaration.`)); };
  if (declared === null) return { ...result, observed, reasons: [reason("CONSTRUCTION_NOT_DECLARED", "This authenticated bundle contains no two-layer construction declaration.")] };
  if (stackup.status !== "explicit" || !stackup.observationsComplete || stackup.issues.length) problems.push(reason("STACKUP_UNSUPPORTED", "Saved stackup observation is missing, ambiguous or outside the supported source grammar."));
  const copper = stackup.layers.filter(layer => layer.kind === "copper");
  if (stackup.boardCopperLayerOrder.length) match(same(stackup.boardCopperLayerOrder, ["F.Cu", "B.Cu"]), "copper layer inventory");
  if (copper.length) match(same(copper.map(layer => layer.name), ["F.Cu", "B.Cu"]), "physical copper order");
  for (const side of ["front", "back"] as const) attempt(() => {
    const signal = copper.find(layer => layer.name === (side === "front" ? "F.Cu" : "B.Cu"));
    need(signal !== undefined, "EXTERIOR_UNASSESSED", "The exterior requires its explicit copper boundary.");
    const outside = side === "front" ? stackup.layers.slice(0, signal.index) : stackup.layers.slice(signal.index + 1);
    const names = side === "front" ? ["F.SilkS", "F.Paste", "F.Mask"] : ["B.Mask", "B.Paste", "B.SilkS"];
    match(outside.every(layer => names.includes(layer.name ?? "") && ["mask", "paste", "silkscreen"].includes(layer.kind)), `${side} exterior air/layer inventory`);
    match(outside.every((layer, index) => index === 0 || names.indexOf(outside[index - 1]!.name!) < names.indexOf(layer.name!)), `${side} exterior layer order`);
    for (const layer of outside.filter(layer => layer.kind === "paste" || layer.kind === "silkscreen")) for (const sub of layer.sublayers) {
      match(explicit(layer.type, "exterior type").toLowerCase() === `${side === "front" ? "top" : "bottom"} ${layer.kind === "paste" ? "solder paste" : "silk screen"}`, `${side} exterior type`);
      if (sub.thicknessMm.status !== "missing") match(thickness(sub.thicknessMm, "exterior coating", true) === 0, `${side} exterior coating thickness`);
    }
  });
  attempt(() => { observed.boardThicknessNm = thickness(stackup.generalBoardThicknessMm, "board thickness"); match(observed.boardThicknessNm === mmNm(declared.boardThicknessMm), "board thickness"); });
  for (const [layerName, output, expected] of [["F.Cu", "frontCopperThicknessNm", declared.frontCopperThicknessMm], ["B.Cu", "backCopperThicknessNm", declared.backCopperThicknessMm]] as const) attempt(() => {
    const layers = copper.filter(layer => layer.name === layerName);
    need(layers.length === 1 && layers[0]!.sublayers.length === 1, "COPPER_THICKNESS_UNSUPPORTED", "Each copper layer requires one explicit thickness record.");
    observed[output] = thickness(layers[0]!.sublayers[0]!.thicknessMm, `${layerName} thickness`);
    match(observed[output] === mmNm(expected), `${layerName} thickness`);
    match(explicit(layers[0]!.type, "copper type").toLowerCase() === "copper", `${layerName} type`);
  });
  attempt(() => {
    const front = copper.find(layer => layer.name === "F.Cu"), back = copper.find(layer => layer.name === "B.Cu");
    need(front !== undefined && back !== undefined, "DIELECTRIC_SPACING_UNSUPPORTED", "Both copper layers are required to locate the substrate.");
    const between = stackup.layers.slice(front.index + 1, back.index);
    need(between.length > 0 && between.every(layer => layer.kind === "dielectric"), "DIELECTRIC_SPACING_UNSUPPORTED", "Adjacent signal/reference copper requires explicit homogeneous dielectric records.");
    let sum = 0;
    for (const layer of between) {
      need(["core", "prepreg"].includes(explicit(layer.type, "dielectric type").toLowerCase()), "DIELECTRIC_TYPE_UNSUPPORTED", "Only explicit core/prepreg substrate records are supported.");
      for (const sub of layer.sublayers) {
        sum += thickness(sub.thicknessMm, "dielectric thickness");
        const material = explicit(sub.material, "dielectric material"), er = explicit(sub.epsilonR, "dielectric permittivity"), loss = explicit(sub.lossTangent, "dielectric loss tangent");
        observed.dielectricMaterial ??= material; observed.relativePermittivity ??= er; observed.lossTangent ??= loss;
        match(material === declared.dielectric.material && exactSourceNumberMatches(sub.epsilonR, declared.dielectric.relativePermittivity) && exactSourceNumberMatches(sub.lossTangent, declared.dielectric.lossTangent), "dielectric material/permittivity/loss declaration");
      }
    }
    observed.dielectricThicknessNm = boundedNm(sum); match(sum === mmNm(declared.dielectric.thicknessMm), "dielectric thickness");
  });
  for (const [side, name, output, expectedType] of [["front", "F.Mask", "frontMaskThicknessNm", "top solder mask"], ["back", "B.Mask", "backMaskThicknessNm", "bottom solder mask"]] as const) attempt(() => {
    const layers = stackup.layers.filter(layer => layer.name === name);
    need(layers.length === 1 && layers[0]!.sublayers.length === 1, "MASK_DECLARATION_MISSING", "Both masks require one explicit source thickness; omission does not mean zero.");
    const mask = layers[0]!, sub = mask.sublayers[0]!;
    observed[output] = thickness(sub.thicknessMm, `${name} thickness`, true);
    const wanted = declared.solderMask[side]; match(observed[output] === (wanted.kind === "absent" ? 0 : mmNm(wanted.thicknessMm)), `${name} thickness`);
    match(explicit(mask.type, "mask type").toLowerCase() === expectedType, `${name} type`);
    const adjacent = copper.find(layer => layer.name === (side === "front" ? "F.Cu" : "B.Cu"));
    if (adjacent) match(side === "front" ? mask.index < adjacent.index : mask.index > adjacent.index, `${name} position`);
    if (wanted.kind === "present") match(explicit(sub.material, "mask material") === wanted.material && exactSourceNumberMatches(sub.epsilonR, wanted.relativePermittivity)
      && exactSourceNumberMatches(sub.lossTangent, wanted.lossTangent), `${name} material`);
  });
  attempt(() => {
    const finishes = stackup.settings.filter(item => item.name === "copper_finish");
    need(finishes.length === 1, "FINISH_DECLARATION_MISSING", "Exactly one explicit saved copper finish is required.");
    observed.surfaceFinish = scalar(readForm(finishes[0]!.source)).value; match(observed.surfaceFinish === declared.surfaceFinish, "surface finish");
  });
  return { ...result, status: mismatches.length ? "failed_saved_declaration" : problems.length ? "unassessed" : "matched_saved_declaration", reasons: [...mismatches, ...problems], observed };
}

function referenceRequirements(bundle: PcbPlaneCompilationBundle, pair: PcbDifferentialPairRequirement, geometry: FreshPcbReferenceGeometry | null): SavedInterfaceReferenceRequirements {
  const plane = bundle.contract.planes.find(plane => plane.id === pair.routing.referencePlaneId);
  const zones = geometry?.zones.filter(zone => zone.kind === "copper" && zone.netName === plane?.net && zone.layers.length === 1 && zone.layers[0] === plane?.layer) ?? [];
  const matched = zones.length === 1 && zones[0]!.status === "supported";
  return { declarationStatus: matched ? "matched_saved_zone" : "unassessed", planeId: pair.routing.referencePlaneId, net: plane?.net ?? null, layer: plane?.layer ?? null,
    memberNets: pairNets(pair), matchingZoneUuids: zones.flatMap(zone => zone.uuid === null ? [] : [zone.uuid]), zoneSourceIdentity: matched ? zones[0]!.sourceIdentity : null,
    savedFillCachePresent: matched ? zones[0]!.filledCachePresent : null, reasons: [reason("REFERENCE_DECLARATION_ONLY", matched
      ? "One supported saved zone names the bound reference net/layer; its declaration does not establish fresh filled coverage, return terminals or electrical eligibility."
      : "A unique supported saved zone naming the bound reference net/layer has not been established.")],
    fillFreshness: "not_verified", wholeRouteCoverage: "not_evaluated", referenceElectricalEligibility: "not_evaluated" };
}
function assessTerminations(pair: PcbDifferentialPairRequirement, inventory: SavedInterfaceSourceInventory, geometry: DifferentialPairGeometryAssessment | null): SavedInterfaceTerminationAssessment {
  const pins: SavedInterfaceTerminationPin[] = [], reasons: SavedInterfaceReason[] = [], assertedResistanceOhms: { side: "source" | "receiver"; value: number }[] = [];
  for (const side of ["source", "receiver"] as const) {
    const declared = pair.terminations[side];
    if (declared.kind === "none") continue;
    if (declared.kind === "source_series") {
      if (!pair.channel || side !== "source") { reasons.push(reason("SOURCE_SERIES_UNSUPPORTED", "Series termination requires the bounded four-net channel declaration.")); continue; }
      for (const polarity of ["positive", "negative"] as const) {
        const leg = declared[polarity], endpoint = pair.endpoints.source[polarity];
        assertedResistanceOhms.push({ side, value: leg.resistanceOhms });
        for (const field of ["sourcePin", "linePin"] as const) {
          const net = field === "sourcePin" ? pair.channel.launchNets[polarity] : (pair.channel.feedThrough?.inputNets ?? pair.nets)[polarity];
          const matches = inventory.selected.pads.filter(p => p.reference === leg.componentReference && p.pad === leg[field]);
          const endpoints = inventory.selected.pads.filter(p => p.reference === endpoint.reference && p.pad === endpoint.pin);
          let distanceSquaredNm2: string | null = null, status: SavedInterfaceTerminationPin["status"] = "unassessed";
          const observations: SavedInterfaceReason[] = [];
          if (inventory.status === "complete") {
            const mapped = matches.length === 1 && matches[0]!.net === net && endpoints.length === 1 && endpoints[0]!.net === pair.channel.launchNets[polarity];
            status = mapped ? "matched_source_facts" : "failed_source_facts";
            if (!mapped) observations.push(reason("TERMINATION_PIN_MAPPING_MISMATCH", "Both series pins must match their distinct source and line nets exactly."));
            else {
              const dx = BigInt(matches[0]!.center.xNm - endpoints[0]!.center.xNm), dy = BigInt(matches[0]!.center.yNm - endpoints[0]!.center.yNm);
              const distance = dx * dx + dy * dy; distanceSquaredNm2 = String(distance);
              const maximum = decimal(String(declared.maximumDistanceToEndpointMm));
              if (distance * maximum.d ** 2n > (maximum.n * 1_000_000n) ** 2n) {
                status = "failed_source_facts"; observations.push(reason("TERMINATION_ENDPOINT_DISTANCE_EXCEEDED", "Series pin planar distance exceeds the explicit source placement bound."));
              }
            }
          }
          pins.push({ side, polarity, kind: "source_series", reference: leg.componentReference, pin: leg[field], expectedNet: net, matchingPadUuids: matches.map(p => p.uuid),
            endpointPadUuid: endpoints.length === 1 ? endpoints[0]!.uuid : null, distanceSquaredNm2, maximumDistanceNm: declared.maximumDistanceToEndpointMm * 1e6, status, reasons: observations });
        }
      }
      continue;
    }
    if (declared.kind === "parallel") assertedResistanceOhms.push({ side, value: declared.resistanceOhms });
    for (const polarity of ["positive", "negative"] as const) {
      const terminal = declared[polarity === "positive" ? "positivePin" : "negativePin"], endpoint = pair.endpoints[side][polarity], net = expectedNet(pair, side, polarity);
      const matches = inventory.selected.pads.filter(pad => pad.reference === declared.componentReference && pad.pad === terminal), endpoints = inventory.selected.pads.filter(pad => pad.reference === endpoint.reference && pad.pad === endpoint.pin);
      const observations: SavedInterfaceReason[] = []; let status: SavedInterfaceTerminationPin["status"] = "unassessed", distanceSquaredNm2: string | null = null;
      const distanceLimitMm = declared.kind === "parallel" ? decimal(String(declared.maximumDistanceToEndpointMm)) : null;
      const distanceLimit = distanceLimitMm === null ? null : { n: distanceLimitMm.n * 1_000_000n, d: distanceLimitMm.d };
      // A limit may be fractional nm even though source coordinates are integer
      // nm. Keep its rational value for every decision; this numeric field is a
      // display projection only. Dividing before scaling avoids Infinity/Infinity
      // for valid subnormal caller quantities.
      const maximumDistanceNm = declared.kind === "parallel" ? declared.maximumDistanceToEndpointMm * 1e6 : null;
      if (inventory.status === "complete" && geometry) {
        const matched = matches.length === 1 && matches[0]!.net === net && endpoints.length === 1 && endpoints[0]!.net === net;
        if (!matched) { status = "failed_source_facts"; observations.push(reason("TERMINATION_PIN_MAPPING_MISMATCH", "The declared termination and endpoint pins do not uniquely match their mapped source member net.")); }
        else {
          const pad = matches[0]!, endpointPad = endpoints[0]!, dx = BigInt(pad.center.xNm - endpointPad.center.xNm), dy = BigInt(pad.center.yNm - endpointPad.center.yNm);
          const distance = dx * dx + dy * dy; distanceSquaredNm2 = String(distance);
          const anchors = declared.kind === "parallel" ? geometry.terminationAnchors.filter(anchor => anchor.selector.reference === declared.componentReference && anchor.selector.pad === terminal) : [];
          const route = net === pair.nets.positive ? geometry.routes.positive : geometry.routes.negative;
          let attached: boolean | null = declared.kind === "integrated" ? pad.uuid === endpointPad.uuid : null;
          if (declared.kind === "parallel" && route.nodes !== null && route.edges !== null) {
            const sourceRole = geometry.sourceRoles.find(role => role.role === `source.${net === pair.nets.positive ? "positive" : "negative"}`)!;
            const sourceNodes = route.nodes.filter(node => node.padUuids.some(uuid => sourceRole.matchingPadUuids.includes(uuid)));
            if (sourceRole.status === "pass" && sourceNodes.length === 1) {
              const reached = new Set([sourceNodes[0]!.id]), pending = [sourceNodes[0]!.id];
              while (pending.length) { const node = pending.pop()!; for (const edge of route.edges) {
                const next = edge.startNode === node ? edge.endNode : edge.endNode === node ? edge.startNode : null;
                if (next !== null && !reached.has(next)) { reached.add(next); pending.push(next); }
              } }
              attached = anchors.length === 1 && anchors[0]!.status === "pass" && anchors[0]!.contactNodeIds.length === 1 && reached.has(anchors[0]!.contactNodeIds[0]!);
            }
          }
          const distanceExceeded = distanceLimit !== null && distance * distanceLimit.d ** 2n > distanceLimit.n ** 2n;
          status = distanceExceeded || attached === false ? "failed_source_facts" : attached === null ? "unassessed" : "matched_source_facts";
          if (attached === false) observations.push(reason("TERMINATION_NOT_ON_SOURCE_ROUTE", "The termination pin is not an exact declared source anchor connected to the source member in the retained graph."));
          if (attached === null) observations.push(reason("TERMINATION_ATTACHMENT_UNASSESSED", "Complete source anchor and graph evidence is required to decide attachment."));
          if (distanceExceeded) observations.push(reason("TERMINATION_ENDPOINT_DISTANCE_EXCEEDED", "Exact planar pad-centre distance exceeds the bound declaration; this is not an electrical-delay measurement."));
        }
      } else observations.push(reason("TERMINATION_SOURCE_UNASSESSED", "A complete supported physical source projection is required before termination mapping or distance can be decided."));
      pins.push({ side, polarity, kind: declared.kind, reference: declared.componentReference, pin: terminal, expectedNet: net, matchingPadUuids: matches.map(pad => pad.uuid),
        endpointPadUuid: endpoints.length === 1 ? endpoints[0]!.uuid : null, distanceSquaredNm2, maximumDistanceNm, status, reasons: observations });
    }
  }
  const failed = pins.some(pin => pin.status === "failed_source_facts"), unavailable = inventory.status !== "complete" || reasons.length > 0 || pins.some(pin => pin.status === "unassessed");
  return { status: failed ? "failed_source_facts" : unavailable ? "unassessed" : "matched_source_facts", reasons: [...reasons, ...pins.flatMap(pin => pin.reasons)], pins,
    assertedResistanceOhms, resistanceVerification: "caller_assertion_only", deviceInternalTermination: "not_verified" };
}

const FINITE_THICKNESS_CAVEAT = "The empirical finite-thickness correction assumes S is much greater than 2*T. No numeric sufficiency threshold is published here; this assessment does not establish that applicability or physical accuracy.";
const unmodeledEffects = ["finite_thickness_applicability", "bends_and_launch_discontinuities", "uncoupled_sections", "pad_shapes", "nearby_lateral_copper", "fresh_reference_coverage", "reference_return_terminals", "physical_material_properties", "manufacturing"] as const;
function bareRequest(pair: PcbDifferentialPairRequirement, construction: PcbInterfaceConstruction, sourceIdentity: ContentIdentity, layer: "F.Cu" | "B.Cu", reference: SavedInterfaceReferenceRequirements): SavedMicrostripRequest {
  return { expectedSourceIdentity: sourceIdentity, net: pair.nets.positive, signalLayer: layer, reference: { net: reference.net!, layer: reference.layer!, zoneUuid: reference.matchingZoneUuids[0]! },
    terminals: [selector(pair.endpoints.source.positive), selector(pair.endpoints.receiver.positive)], targetOhm: pair.impedance.mode === "differential" ? pair.impedance.targetOhms : 1,
    absoluteToleranceOhm: pair.impedance.mode === "differential" ? pair.impedance.toleranceOhms : 0, frequencyHz: pair.impedance.mode === "differential" ? pair.impedance.frequencyHz : construction.dielectric.frequencyHz,
    construction: { topCover: "absent", surface: "bare", dielectric: { material: construction.dielectric.material, epsilonR: construction.dielectric.relativePermittivity,
      lossTangent: construction.dielectric.lossTangent, frequencyHz: construction.dielectric.frequencyHz, evidence: construction.dielectric.source.description },
    conductor: { conductivitySiemensPerMetre: construction.conductor.conductivitySiemensPerMetre, relativePermeability: construction.conductor.relativePermeability,
      roughnessNm: construction.conductor.roughnessNm, evidence: construction.conductor.source.description }, substrateRelativePermeability: construction.dielectric.substrateRelativePermeability,
    evidence: construction.source.description } };
}
async function assessImpedance(pair: PcbDifferentialPairRequirement, declared: PcbInterfaceConstruction | null, construction: SavedInterfaceConstructionAssessment,
  geometry: DifferentialPairGeometryAssessment | null, stackup: FreshPcbStackup | null, reference: SavedInterfaceReferenceRequirements, sourceIdentity: ContentIdentity,
  calculator: KicadTransmissionLineCalculator | undefined): Promise<SavedInterfaceImpedanceAssessment> {
  const intervals: SavedInterfaceImpedanceInterval[] = [], reasons: SavedInterfaceReason[] = [];
  const base = { targetOhm: pair.impedance.mode === "differential" ? pair.impedance.targetOhms : null, absoluteToleranceOhm: pair.impedance.mode === "differential" ? pair.impedance.toleranceOhms : null,
    frequencyHz: pair.impedance.mode === "differential" ? pair.impedance.frequencyHz : null, intervals, completeRouteModelCoverage: false,
    differentialBasis: "twice_frequency_dependent_odd_mode_Z0_O" as const,
    unmodeledEffects: pair.channel ? [...unmodeledEffects, "neckdowns", "branch_taps", "series_resistors", "protection_devices", "complete_channel"] : unmodeledEffects };
  if (pair.impedance.mode === "none") return { ...base, status: "not_requested", reasons: [] };
  const target = pair.impedance, spans = geometry?.coupling?.paired ?? [];
  const overBound = spans.length > SAVED_INTERFACE_ASSESSMENT_BOUNDS.maximumModelIntervals;
  if (overBound) reasons.push(reason("MODEL_INTERVAL_WORK_BOUND", "The complete paired-interval inventory exceeds the model work bound; no truncated subset is calculated."));
  for (const [index, span] of spans.entries()) {
    const p = geometry!.routes.positive.runs![span.positiveRunIndex]!, n = geometry!.routes.negative.runs![span.negativeRunIndex]!;
    let interval: SavedInterfaceImpedanceInterval = { index, positiveRunIndex: p.index, negativeRunIndex: n.index, positiveMemberUuids: span.positiveMemberUuids, negativeMemberUuids: span.negativeMemberUuids,
      positiveWidthNm: p.widthNm, negativeWidthNm: n.widthNm, centerlineSquaredNm2: span.centerlineSquaredNm2, radiusSumTwiceNm: span.radiusSumTwiceNm, length: span.length,
      numericalGapNm: null, numericalLengthNm: null, status: "unassessed", reasons: [], applicability: { status: "unassessed", widthToHeightRatio: null, gapToHeightRatio: null,
        frequencyGHzTimesHeightMm: null, finiteThicknessCaveat: FINITE_THICKNESS_CAVEAT }, calculatedDifferentialOhm: null, residualOhm: null, calculation: null };
    try {
      need(!overBound, "MODEL_INTERVAL_WORK_BOUND", "All intervals remain unassessed because their complete inventory exceeds the model work bound.");
      need(declared !== null && construction.status === "matched_saved_declaration" && stackup !== null, "CONSTRUCTION_UNASSESSED", "Exact saved construction must match the authenticated bundle before model preparation.");
      need(reference.declarationStatus === "matched_saved_zone", "REFERENCE_DECLARATION_UNASSESSED", "The bound reference-zone declaration is required; coverage remains an independent unknown.");
      need(p.widthNm === n.widthNm && p.layer === n.layer && ["F.Cu", "B.Cu"].includes(p.layer), "CROSS_SECTION_UNSUPPORTED", "The coupled model requires actual equal widths on one outer signal layer; widths are never averaged.");
      const prepared = deriveBareConstruction(stackup, bareRequest(pair, declared, sourceIdentity, p.layer as "F.Cu" | "B.Cu", reference));
      const h = prepared.dielectricThicknessNm!, t = prepared.signalCopperThicknessNm!, width = p.widthNm;
      const distanceN = BigInt(span.centerlineSquaredNm2.numerator), distanceD = BigInt(span.centerlineSquaredNm2.denominator), hInt = BigInt(h), wInt = BigInt(width);
      const gapNm = Math.sqrt(Number(distanceN) / Number(distanceD)) - Number(BigInt(span.radiusSumTwiceNm)) / 2;
      const lengthNm = (Number(BigInt(span.length.twiceAxisNm)) + Number(BigInt(span.length.twiceDiagonalNm)) * Math.SQRT2) / 2;
      const f = decimal(String(target.frequencyHz));
      interval = { ...interval, numericalGapNm: gapNm, numericalLengthNm: lengthNm,
        applicability: { ...interval.applicability, widthToHeightRatio: width / h, gapToHeightRatio: gapNm / h, frequencyGHzTimesHeightMm: target.frequencyHz * h / 1e15 } };
      need(10n * wInt >= hInt && wInt <= 10n * hInt && 100n * distanceN >= (10n * wInt + hInt) ** 2n * distanceD
        && distanceN <= (wInt + 10n * hInt) ** 2n * distanceD && declared.dielectric.relativePermittivity >= 1 && declared.dielectric.relativePermittivity <= 18
        && f.n * hInt <= 20_000_000_000_000_000n * f.d, "PUBLISHED_MODEL_ENVELOPE_EXCEEDED", "Exact source W/H or S/H is outside 0.1..10, relative permittivity outside 1..18, or frequency(GHz)*H(mm) exceeds 20.");
      need(declared.dielectric.substrateRelativePermeability === 1 && declared.conductor.relativePermeability === 1, "MAGNETIC_MODEL_UNSUPPORTED", "This coupled approximation has no qualified nonunit-permeability construction model.");
      need(distanceN > (wInt + 2n * BigInt(t)) ** 2n * distanceD, "FINITE_THICKNESS_NECESSARY_CONDITION_FAILED", "S is not greater than 2*T, so the model's S much greater than 2*T assumption cannot hold.");
      need(Number.isFinite(gapNm) && gapNm > 0 && Number.isFinite(lengthNm) && lengthNm > 0, "NUMERICAL_CONVERSION_UNAVAILABLE", "Actual exact interval geometry cannot be represented as finite positive calculator inputs.");
      interval = { ...interval, applicability: { ...interval.applicability, status: "conditional_model_only" } };
      need(calculator !== undefined, "CALCULATOR_UNAVAILABLE", "No factory-bound protocol-4 calculator was supplied by the host.");
      const calculation = await calculator.calculate({ model: "coupled_microstrip", operation: "analyze", parameters: {
        H: h / 1e9, T: t / 1e9, H_T: "absent", PHYS_WIDTH: width / 1e9, PHYS_S: gapNm / 1e9, PHYS_LEN: lengthNm / 1e9,
        EPSILONR: declared.dielectric.relativePermittivity, TAND: declared.dielectric.lossTangent, FREQUENCY: target.frequencyHz,
        SIGMA: declared.conductor.conductivitySiemensPerMetre, MURC: declared.conductor.relativePermeability, ROUGH: declared.conductor.roughnessNm / 1e9 } });
      interval = { ...interval, calculation: structuredClone(calculation) };
      need(calculation.native.schemaVersion === 4 && calculation.request.model === "coupled_microstrip" && calculation.request.operation === "analyze"
        && calculation.request.parameters.FREQUENCY === target.frequencyHz && calculation.status === "calculated", "CALCULATION_UNAVAILABLE", "The pinned uncovered coupled model did not return a usable protocol-4 result.");
      const odd = calculation.native.results.Z0_O?.value, differential = typeof odd === "number" ? 2 * odd : null;
      need(differential !== null && Number.isFinite(differential) && differential > 0 && calculation.impedance.differentialAtFrequencyOhm === differential,
        "ODD_MODE_RESULT_UNAVAILABLE", "A positive frequency-dependent Z0_O is required; native quasistatic Z_DIFF is not a fallback.");
      const residual = differential - target.targetOhms;
      interval = { ...interval, calculatedDifferentialOhm: differential, residualOhm: residual,
        status: Math.abs(residual) <= target.toleranceOhms ? "within_tolerance" : "outside_tolerance",
        reasons: [reason("CONDITIONAL_INTERVAL_MODEL_ONLY", "Numerical tolerance describes this actual uniform interval under the continuous-reference and finite-thickness model assumptions.")] };
    } catch (error) { interval = { ...interval, reasons: [failure(error, "CALCULATION_UNAVAILABLE")] }; }
    intervals.push(interval);
  }
  const allModelled = intervals.length > 0 && intervals.every(interval => interval.status !== "unassessed");
  const noUncoupled = geometry?.coupling !== null && geometry?.coupling !== undefined && [geometry.coupling.positiveUncoupledLength, geometry.coupling.negativeUncoupledLength]
    .every(length => length.twiceAxisNm === "0" && length.twiceDiagonalNm === "0");
  const completeRouteModelCoverage = pair.channel === undefined && allModelled && noUncoupled && geometry?.coupling?.status === "complete" && geometry.routes.positive.runs?.length === 1 && geometry.routes.negative.runs?.length === 1
    && ["topology", "sourcePolarity", "stubs", "transitions", "width", "minimumGap", "length", "skew", "uncoupled"].every(key => geometry.checks[key as keyof typeof geometry.checks].status === "pass");
  if (!intervals.length) reasons.push(reason("NO_SUPPORTED_PAIRED_INTERVALS", "There are no complete source-derived paired intervals to evaluate."));
  if (!completeRouteModelCoverage) reasons.push(reason("WHOLE_INTERFACE_MODEL_COVERAGE_UNASSESSED", "Unsupported/ambiguous intervals, unequal widths, uncoupled lengths, bends or source-contract failures prevent a whole-route uniform-model conclusion."));
  reasons.push(reason("FINITE_THICKNESS_APPLICABILITY_UNASSESSED", FINITE_THICKNESS_CAVEAT));
  return { ...base, completeRouteModelCoverage, status: intervals.some(interval => interval.status === "outside_tolerance") ? "outside_tolerance" : "unassessed", reasons };
}

/** Source snapshot precedes every await. Authenticated bundle requirements are
 * immutable; this API has no caller target, construction or endpoint overrides. */
export async function assessSavedInterface(input: SavedInterfaceAssessmentInput): Promise<SavedInterfaceAssessment> {
  const supplied = input.savedPcbBytes;
  if (!(supplied instanceof Uint8Array) || supplied.byteLength > SAVED_INTERFACE_ASSESSMENT_BOUNDS.maximumInputBytes) throw new Error("Saved-interface assessment requires bounded host-supplied PCB bytes.");
  const bytes = Buffer.from(supplied), sourceIdentity = contentIdentity(bytes), bundle = input.compilationBundle;
  if (!isAuthenticatedPcbPlaneCompilationBundle(bundle)) throw new Error("Saved-interface assessment requires an authenticated plane compilation bundle.");
  const interfaceId = input.interfaceId, pair = bundle.contract.interfaceRequirements?.interfaces.find(pair => pair.id === interfaceId);
  if (!pair) throw new Error("The interface ID does not name a requirement in the authenticated bundle.");
  const calculator = input.calculator;
  if (calculator !== undefined && !isKicadTransmissionLineCalculator(calculator)) throw new Error("Saved-interface assessment requires a genuine factory-bound transmission-line calculator.");
  const declared = bundle.contract.interfaceRequirements!.construction.mode === "two_layer" ? bundle.contract.interfaceRequirements!.construction : null;
  let sourceInventory: SavedInterfaceSourceInventory = { status: "unsupported", reasons: [], selected: { tracks: [], pads: [], vias: [] }, observations: [], projectionComplete: false };
  let geometry: DifferentialPairGeometryAssessment | null = null, sourceGeometry: FreshPcbReferenceGeometry | null = null, stackup: FreshPcbStackup | null = null, construction = emptyConstruction();
  let channel: SavedInterfaceAssessment["channel"];
  try {
    need(bytes.length <= SAVED_INTERFACE_ASSESSMENT_BOUNDS.maximumAssessedSourceBytes, "SOURCE_WORK_BOUND", "The complete saved PCB exceeds the strict source-assessment work bound; no subset is parsed.");
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    sourceGeometry = parseFreshPcbReferenceGeometry(source);
    need(same(sourceGeometry.sourceIdentity, sourceIdentity), "SOURCE_IDENTITY_MISMATCH", "The parser source identity differs from the captured saved bytes.");
    sourceInventory = extractSource(source, sourceGeometry, pair);
    try { stackup = parseFreshPcbStackup(source); construction = compareConstruction(stackup, declared); }
    catch (error) { construction = { ...construction, reasons: [failure(error, "CONSTRUCTION_UNSUPPORTED")] }; }
    {
      if (pair.channel) {
        const assessed = assessDifferentialChannelGeometry(pair, sourceInventory.selected, sourceInventory.status === "complete");
        const protectionReturns = pair.channel.protection.flatMap(protection => [protection.ground, protection.supply].map(anchor => {
          const pads = sourceInventory.selected.pads.filter(p => p.reference === protection.componentReference && p.pad === anchor.pin);
          return { reference: protection.componentReference, pin: anchor.pin, expectedNet: anchor.net, matchingPadUuids: pads.map(p => p.uuid),
            status: sourceInventory.status !== "complete" ? "not_assessed" as const : pads.length === 1 && pads[0]!.net === anchor.net ? "pass" as const : "fail" as const };
        }));
        channel = { ...assessed, protectionReturns };
        if (protectionReturns.some(p => p.status === "fail")) channel = { ...channel, checks: { ...channel.checks, topology: { status: "fail", reasons: ["PROTECTION_RETURN_MAPPING_MISMATCH"] } } };
        geometry = { ...assessed.receiverPaths[0]!.geometry, inventoryComplete: assessed.inventoryComplete, checks: channel.checks };
      } else geometry = assessDifferentialPairGeometry({ ...sourceInventory.selected, positiveNet: pair.nets.positive, negativeNet: pair.nets.negative,
        source: { positive: selector(pair.endpoints.source.positive), negative: selector(pair.endpoints.source.negative) },
        receiver: { positive: selector(pair.endpoints.receiver.positive), negative: selector(pair.endpoints.receiver.negative) },
        receiverMapping: pair.routing.polarityInversion.receiverMapping === "normal" ? "preserved" : "swapped", terminationAnchors: terminationSelectors(pair),
        limits: { minimumWidthNm: mmNm(pair.geometry.traceWidthMm.minimumMm), maximumWidthNm: mmNm(pair.geometry.traceWidthMm.maximumMm), minimumGapNm: mmNm(pair.geometry.edgeGapMm.minimumMm),
          maximumCoupledGapNm: mmNm(pair.geometry.edgeGapMm.maximumMm), maximumMainLengthNm: mmNm(pair.geometry.maxEtchLengthMm), maximumSkewNm: mmNm(pair.geometry.maxEtchSkewMm),
          maximumStubLengthNm: 0, maximumUncoupledLengthNm: mmNm(pair.geometry.maxUncoupledLengthMm), transitions: "forbidden", allowedLayers: pair.routing.allowedLayers } });
      if (sourceInventory.status !== "complete") {
        const unknown = { status: "not_assessed" as const, reasons: ["SOURCE_PROJECTION_INCOMPLETE"] };
        const unknownRoute = (route: DifferentialPairGeometryAssessment["routes"]["positive"]) => ({ ...route, status: "not_assessed" as const, reasons: ["SOURCE_PROJECTION_INCOMPLETE"],
          contacts: null, nodes: null, edges: null, mainChain: null, runs: null, stubs: null, mainLength: null, totalEtchLength: null });
        // Existing copper can prove a local violation even if an unsupported pad
        // prevents complete route assessment. Absence from this projection can
        // never prove a missing terminal, disconnected route, clearance pass or
        // length pass. Only these independent, already observed failures remain.
        const checks = Object.fromEntries(Object.entries(geometry.checks).map(([key, value]) => [key,
          ["width", "minimumGap", "transitions"].includes(key) && value.status === "fail" ? value : unknown])) as unknown as typeof geometry.checks;
        geometry = { ...geometry, inventoryComplete: false, diagnostics: [...geometry.diagnostics, "SOURCE_PROJECTION_INCOMPLETE"], checks,
          routes: { positive: unknownRoute(geometry.routes.positive), negative: unknownRoute(geometry.routes.negative) }, coupling: null, etchSkew: null,
          sourceRoles: geometry.sourceRoles.map(role => ({ ...role, status: "not_assessed" as const })),
          terminationAnchors: geometry.terminationAnchors.map(anchor => ({ ...anchor, status: "not_assessed" as const })) };
      }
    }
  } catch (error) { sourceInventory = { ...sourceInventory, status: "unsupported", projectionComplete: false, reasons: [...sourceInventory.reasons, failure(error, "SOURCE_UNSUPPORTED")] }; }
  const reference = referenceRequirements(bundle, pair, sourceGeometry), terminations = assessTerminations(pair, sourceInventory, geometry);
  const impedance = await assessImpedance(pair, declared, construction, geometry, stackup, reference, sourceIdentity, calculator);
  const relevantIds = new Set(["interface-construction", `interface-topology:${interfaceId}`, `interface-geometry:${interfaceId}`, `interface-termination:${interfaceId}`, `interface-impedance:${interfaceId}`]);
  const payload = { schemaVersion: SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION, sourceIdentity, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
    verificationPlanIdentity: bundle.verificationPlan.identity, interfaceId, requirementIdentity: canonicalIdentity(pair, "evleda.saved-interface-requirement.v1"),
    sourceInventory, geometry, ...(channel ? { channel } : {}), construction, terminations, referenceRequirements: reference, impedance,
    unevaluatedRows: bundle.verificationPlan.requirements.filter(row => relevantIds.has(row.id) || row.kind === "trace_geometry").map(row => ({ id: row.id, kind: row.kind,
      reasons: [reason("FULL_REQUIREMENT_AUTHORITY_NOT_ESTABLISHED", "These numerical source observations do not alone supply native terminal/library authority, fresh reference eligibility, physical termination verification, global trace-turn policy or complete model applicability.")] })),
    limits: SAVED_INTERFACE_ASSESSMENT_BOUNDS, sourceAuthority: "saved_byte_numerical_facts_and_bound_caller_assertions" as const, nativeReachability: "not_evaluated" as const,
    libraryMembership: "not_verified" as const, boardAccepted: false as const, interfaceAccepted: false as const, fabricationAuthorized: false as const };
  return freeze({ ...payload, identity: canonicalIdentity(payload, SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION) });
}
