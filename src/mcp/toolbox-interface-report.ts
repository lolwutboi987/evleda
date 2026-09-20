import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { DifferentialPairExactLength, DifferentialPairGeometryAssessment, DifferentialPairGraphEdge,
  DifferentialPairMemberInterval, DifferentialPairPointNm, DifferentialPairPointTwiceNm, DifferentialPairRoute,
  DifferentialPairSquaredDistance } from "../harness/differential-pair-geometry.js";
import type { SavedInterfaceAssessment, SavedInterfaceReason } from "../harness/saved-interface-assessment.js";
import type { KicadTransmissionLineResult } from "../integrations/kicad-transmission-line.js";

// Reserve room for the MCP source guards and the containing result envelope.
const MAX_PUBLIC_BYTES = 1024 * 1024 - 4096;
const PRIVATE_DETAIL = "Private diagnostic detail retained in the complete assessment.";
const PRIVATE_PATH = /[\\/]|\b[A-Za-z]:/u;
// A generic bounded S-expression check covers new/unknown KiCad forms too.
// Only these exact scientific parentheticals from the analytical report are
// exempt; a named form with arguments never becomes safe through its token.
const SCIENTIFIC_PARENTHESES = /\((?:H-T|relative permittivity|Hz|kHz|MHz|GHz|m|mm|nm|ohm|ohms|rad)\)/gu;
const SAVED_FORM = /\(\s*[A-Za-z_][A-Za-z0-9_.-]*(?=[\s)'"(])/u;
function hasSavedSyntax(value: string): boolean {
  return SAVED_FORM.test(value.replace(SCIENTIFIC_PARENTHESES, ""));
}
const ERROR = "Interface evidence could not produce a complete source-bound public report; no findings were truncated.";

function text(value: string): string {
  if (typeof value !== "string") throw new Error(ERROR);
  return PRIVATE_PATH.test(value) || hasSavedSyntax(value) ? PRIVATE_DETAIL : value;
}
export const sanitizePcbDiagnosticText = text;
const reasons = (values: readonly string[]) => values.map(text);
const number = (value: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(ERROR);
  return value;
};
const nullableNumber = (value: number | null) => value === null ? null : number(value);
const flag = <T extends boolean>(value: T): T => {
  if (typeof value !== "boolean") throw new Error(ERROR);
  return value;
};
const tag = <T extends string>(value: T, ...allowed: readonly [T, ...T[]]): T => {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(ERROR);
  return value;
};
const integerText = (value: string): string => {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(ERROR);
  return value;
};
const digest = (value: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(ERROR);
  return value;
};
const content = (value: ContentIdentity) => {
  if (value.algorithm !== "sha256" || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error(ERROR);
  return { algorithm: value.algorithm, digest: digest(value.digest), size: value.size };
};
const canonical = (value: CanonicalIdentity) => {
  if (value.algorithm !== "sha256" || value.canonicalizationVersion !== "evleda-c14n-json-v1") throw new Error(ERROR);
  return { algorithm: value.algorithm, digest: digest(value.digest), schemaVersion: text(value.schemaVersion),
    canonicalizationVersion: value.canonicalizationVersion };
};
const point = (value: DifferentialPairPointNm) => ({ xNm: number(value.xNm), yNm: number(value.yNm) });
const pointTwice = (value: DifferentialPairPointTwiceNm) => ({ xTwiceNm: integerText(value.xTwiceNm), yTwiceNm: integerText(value.yTwiceNm) });
const length = (value: DifferentialPairExactLength) => ({ twiceAxisNm: integerText(value.twiceAxisNm), twiceDiagonalNm: integerText(value.twiceDiagonalNm) });
const squared = (value: DifferentialPairSquaredDistance) => ({ numerator: integerText(value.numerator), denominator: integerText(value.denominator) });
function pinText(value: string): string {
  // Contract pin identifiers explicitly admit slash; this is a semantic pin,
  // never a filesystem field. Drive and absolute-path spellings do not match.
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u.test(value)) throw new Error(ERROR);
  return value;
}
function materialText(value: string): string {
  // Material and finish labels are observed semantic values and may contain
  // slash separators. They still cannot expose absolute host paths or source.
  if (typeof value !== "string") throw new Error(ERROR);
  return /\\|\b[A-Za-z]:|(?:^|\s|:|=|\(|\[|"|')\/\S/u.test(value) || hasSavedSyntax(value) ? PRIVATE_DETAIL : value;
}
const terminal = (value: { readonly reference: string; readonly pad: string }) => ({ reference: text(value.reference), pad: pinText(value.pad) });
const check = (value: { readonly status: string; readonly reasons: readonly string[] }) => ({
  status: tag(value.status, "pass", "fail", "not_assessed"), reasons: reasons(value.reasons) });
const member = (value: DifferentialPairMemberInterval) => ({ uuid: text(value.uuid), start: point(value.start), end: point(value.end),
  widthNm: number(value.widthNm), ...(value.sourceIdentity === undefined ? {} : { sourceIdentity: content(value.sourceIdentity) }) });
function edgeId(value: string): string {
  // Source graph IDs are primitive UUID plus a decimal split index. A short
  // synthetic UUID such as p:0 is not a Windows drive-relative path.
  const split = /^([^:]+):(0|[1-9][0-9]*)$/u.exec(value);
  if (split === null) throw new Error(ERROR);
  return `${text(split[1]!)}:${split[2]!}`;
}
const edge = (value: DifferentialPairGraphEdge) => ({ ...member(value), id: edgeId(value.id), layer: text(value.layer),
  startNode: text(value.startNode), endNode: text(value.endNode), length: length(value.length) });

function route(value: DifferentialPairRoute) {
  return { net: text(value.net), status: tag(value.status, "complete_source_tree", "incomplete", "not_assessed"), reasons: reasons(value.reasons),
    contacts: value.contacts === null ? null : value.contacts.map(item => ({ kind: tag(item.kind, "proper_crossing", "positive_overlap", "endpoint_on_interior"),
      firstUuid: text(item.firstUuid), secondUuid: text(item.secondUuid) })),
    nodes: value.nodes === null ? null : value.nodes.map(item => ({ id: text(item.id), layer: text(item.layer), point: point(item.point),
      padUuids: item.padUuids.map(text), viaUuids: item.viaUuids.map(text) })),
    edges: value.edges === null ? null : value.edges.map(edge), mainChain: value.mainChain === null ? null : value.mainChain.map(edge),
    runs: value.runs === null ? null : value.runs.map(item => ({ index: number(item.index), layer: text(item.layer), widthNm: number(item.widthNm),
      start: point(item.start), end: point(item.end), direction: { x: number(item.direction.x), y: number(item.direction.y) },
      members: item.members.map(member), length: length(item.length) })),
    stubs: value.stubs === null ? null : value.stubs.map(item => ({ attachmentNode: text(item.attachmentNode), edges: item.edges.map(edge),
      length: length(item.length), leafNodes: item.leafNodes.map(text), maximumAttachmentToLeafLength: length(item.maximumAttachmentToLeafLength) })),
    mainLength: value.mainLength === null ? null : length(value.mainLength),
    totalEtchLength: value.totalEtchLength === null ? null : length(value.totalEtchLength) };
}

/** Every analyzed primitive, graph fact and exact metric is selected explicitly.
 * Calculator requests and original PCB syntax are never public geometry. */
function geometry(value: DifferentialPairGeometryAssessment) {
  const coverage = (items: NonNullable<DifferentialPairGeometryAssessment["coupling"]>["positiveCoverage"]) => items.map(item => ({
    runIndex: number(item.runIndex), start: pointTwice(item.start), end: pointTwice(item.end), memberUuids: item.memberUuids.map(text),
    length: length(item.length), status: tag(item.status, "paired", "unpaired", "ambiguous"), candidateMateRunIndices: item.candidateMateRunIndices.map(number), reasons: reasons(item.reasons) }));
  return { schemaVersion: tag(value.schemaVersion, "evleda.differential-pair-geometry.v1"), inventoryComplete: flag(value.inventoryComplete), diagnostics: reasons(value.diagnostics),
    selected: selected(value.selected),
    sourceRoles: value.sourceRoles.map(item => ({ role: text(item.role), selector: terminal(item.selector), expectedNet: text(item.expectedNet),
      matchingPadUuids: item.matchingPadUuids.map(text), status: tag(item.status, "pass", "fail", "not_assessed") })),
    terminationAnchors: value.terminationAnchors.map(item => ({ selector: terminal(item.selector), matchingPadUuids: item.matchingPadUuids.map(text),
      contactNodeIds: item.contactNodeIds.map(text), status: tag(item.status, "pass", "fail", "not_assessed") })),
    routes: { positive: route(value.routes.positive), negative: route(value.routes.negative) },
    allTrackPairGaps: value.allTrackPairGaps === null ? null : value.allTrackPairGaps.map(item => ({ positiveUuid: text(item.positiveUuid),
      negativeUuid: text(item.negativeUuid), layerRelationship: tag(item.layerRelationship, "same_layer", "different_layer_not_assessed"),
      centerlineSquaredNm2: item.centerlineSquaredNm2 === null ? null : squared(item.centerlineSquaredNm2),
      radiusSumTwiceNm: integerText(item.radiusSumTwiceNm), minimumGap: tag(item.minimumGap, "pass", "fail", "not_assessed") })),
    coupling: value.coupling === null ? null : { status: tag(value.coupling.status, "complete", "ambiguous"),
      paired: value.coupling.paired.map(item => ({ positiveRunIndex: number(item.positiveRunIndex), negativeRunIndex: number(item.negativeRunIndex),
        positiveStart: pointTwice(item.positiveStart), positiveEnd: pointTwice(item.positiveEnd),
        negativeStart: pointTwice(item.negativeStart), negativeEnd: pointTwice(item.negativeEnd),
        positiveMemberUuids: item.positiveMemberUuids.map(text), negativeMemberUuids: item.negativeMemberUuids.map(text),
        length: length(item.length), centerlineSquaredNm2: squared(item.centerlineSquaredNm2), radiusSumTwiceNm: integerText(item.radiusSumTwiceNm) })),
      positiveCoverage: coverage(value.coupling.positiveCoverage), negativeCoverage: coverage(value.coupling.negativeCoverage),
      positiveUncoupledLength: length(value.coupling.positiveUncoupledLength), negativeUncoupledLength: length(value.coupling.negativeUncoupledLength),
      reasons: reasons(value.coupling.reasons) },
    etchSkew: value.etchSkew === null ? null : length(value.etchSkew), viaObservations: value.viaObservations.map(item => ({
      uuid: text(item.uuid), layers: item.layers.map(text), transition: tag(item.transition, "forbidden_present"), unusedBarrel: tag(item.unusedBarrel, "not_assessed"), verticalLength: tag(item.verticalLength, "not_assessed") })),
    checks: { sourcePolarity: check(value.checks.sourcePolarity), topology: check(value.checks.topology), width: check(value.checks.width),
      minimumGap: check(value.checks.minimumGap), coupledGap: check(value.checks.coupledGap), length: check(value.checks.length),
      skew: check(value.checks.skew), stubs: check(value.checks.stubs), uncoupled: check(value.checks.uncoupled), transitions: check(value.checks.transitions) },
    authority: tag(value.authority, "caller_supplied_source_geometry_only"), notEvaluated: reasons(value.notEvaluated), accepted: flag(value.accepted) };
}

function selected(value: DifferentialPairGeometryAssessment["selected"]) {
  return { tracks: value.tracks.map(item => ({ uuid: text(item.uuid), net: text(item.net), layer: text(item.layer),
      widthNm: number(item.widthNm), start: point(item.start), end: point(item.end),
      ...(item.sourceIdentity === undefined ? {} : { sourceIdentity: content(item.sourceIdentity) }) })),
    pads: value.pads.map(item => ({ uuid: text(item.uuid), net: text(item.net), reference: text(item.reference), pad: pinText(item.pad),
      layers: item.layers.map(text), center: point(item.center), ...(item.sourceIdentity === undefined ? {} : { sourceIdentity: content(item.sourceIdentity) }) })),
    vias: value.vias.map(item => ({ uuid: text(item.uuid), net: text(item.net), center: point(item.center), layers: item.layers.map(text),
      diameterNm: number(item.diameterNm), drillNm: number(item.drillNm), ...(item.sourceIdentity === undefined ? {} : { sourceIdentity: content(item.sourceIdentity) }) })) };
}

// Result names and units belong to the pinned native protocol, not arbitrary
// object keys. Preserve all results while rejecting unrecognized metric keys.
const RESULT_NAMES = new Set(["EPSILONR", "TAND", "RHO", "H", "H_T", "T", "PHYS_WIDTH", "PHYS_DIAM_IN", "PHYS_S", "PHYS_DIAM_OUT",
  "PHYS_LEN", "ROUGH", "MUR", "MURC", "FREQUENCY", "STRIPLINE_A", "TWISTEDPAIR_TWIST", "TWISTEDPAIR_EPSILONR_ENV", "Z0", "Z0_E", "Z0_O",
  "ANG_L", "DUMMY_PRM", "SIGMA", "SKIN_DEPTH", "LOSS_DIELECTRIC", "LOSS_CONDUCTOR", "CUTOFF_FREQUENCY", "EPSILON_EFF", "EPSILON_EFF_EVEN",
  "EPSILON_EFF_ODD", "UNIT_PROP_DELAY", "UNIT_PROP_DELAY_ODD", "UNIT_PROP_DELAY_EVEN", "ATTEN_COND", "ATTEN_COND_EVEN", "ATTEN_COND_ODD",
  "ATTEN_DILECTRIC", "ATTEN_DILECTRIC_EVEN", "ATTEN_DILECTRIC_ODD", "Z_DIFF"]);
function resultUnit(name: string): string {
  if (name === "FREQUENCY" || name === "CUTOFF_FREQUENCY") return "Hz";
  if (name === "SIGMA") return "S/m";
  if (name === "ANG_L") return "rad";
  if (name.startsWith("Z0") || name === "Z_DIFF") return "ohm";
  if (name.startsWith("UNIT_PROP_DELAY")) return "ps/cm";
  if (name.startsWith("ATTEN_") || name.startsWith("LOSS_")) return "dB";
  if (["H", "H_T", "T", "PHYS_WIDTH", "PHYS_S", "PHYS_LEN", "ROUGH", "STRIPLINE_A", "SKIN_DEPTH"].includes(name)) return "m";
  return "1";
}
// Known scientific ratios, SI units and bounded source phrases are not paths.
// Any remaining slash, drive spelling or backslash makes the detail private.
function modelText(value: string): string {
  const withoutRatios = value.replace(/\b(?:m\/s|S\/m|ps\/cm|H_T\/H|W\/H|S\/H|S\/T|H\/2|1\/sqrt|fringe\/gap|spacing\/conductor|single\/coupled-microstrip|signal\/reference|core\/prepreg|material\/permittivity\/loss|net\/layer|Unsupported\/ambiguous|terminal\/library)\b/gu, "ratio")
    .replaceAll("(H-T)/2", "ratio");
  return PRIVATE_PATH.test(withoutRatios) || hasSavedSyntax(value) ? PRIVATE_DETAIL : value;
}
function calculation(value: KicadTransmissionLineResult) {
  if (![2, 3, 4].includes(value.native.schemaVersion)
      || value.native.sourceCommit !== "146a4f2a7585c65bc580427a19b6fe2ec4a3f622"
      || value.native.implementationRevision !== (value.native.schemaVersion === 4 ? "evleda-uncovered-coupled-microstrip-v1"
        : value.native.schemaVersion === 3 ? "evleda-uncovered-microstrip-v1" : "evleda-stripline-corrections-v1")) throw new Error(ERROR);
  return { status: tag(value.status, "calculated", "not_converged", "target_not_reached", "invalid_model_result"), native: { schemaVersion: number(value.native.schemaVersion), sourceCommit: text(value.native.sourceCommit),
    implementationRevision: text(value.native.implementationRevision), model: tag(value.native.model, "microstrip", "coupled_microstrip", "stripline", "coupled_stripline"),
    operation: tag(value.native.operation, "analyze", "synthesize"),
    converged: flag(value.native.converged), valid: flag(value.native.valid),
    results: Object.fromEntries(Object.entries(value.native.results).map(([name, result]) => {
      if (!RESULT_NAMES.has(name) || result.unit !== resultUnit(name)) throw new Error(ERROR);
      return [name, { value: nullableNumber(result.value), status: tag(result.status, "ok", "warning", "error"), unit: result.unit }];
    })) },
    impedance: { singleEndedOhm: nullableNumber(value.impedance.singleEndedOhm), oddModeOhm: nullableNumber(value.impedance.oddModeOhm),
      differentialAtFrequencyOhm: nullableNumber(value.impedance.differentialAtFrequencyOhm), nativeDifferentialOhm: nullableNumber(value.impedance.nativeDifferentialOhm),
      nativeDifferentialBasis: tag(value.impedance.nativeDifferentialBasis, "not-applicable", "quasistatic", "native-coupled-stripline") }, targetResidualOhm: nullableNumber(value.targetResidualOhm),
    executableIdentity: { sha256: digest(value.executableIdentity.sha256), sizeBytes: number(value.executableIdentity.sizeBytes) },
    modelWarnings: value.modelWarnings.map(item => ({ code: tag(item.code, "NATIVE_DELAY_APPROXIMATION", "FINITE_THICKNESS_MODEL_VARIANT",
      "COUPLED_MICROSTRIP_MODEL_RANGE", "MICROSTRIP_METALLIC_COVER", "MICROSTRIP_UNCOVERED_MODEL", "COUPLED_STRIPLINE_SOURCE_CORRECTIONS",
      "COUPLED_STRIPLINE_PIECEWISE_INVERSE", "COUPLED_MICROSTRIP_DIFFERENTIAL_BASIS", "COUPLED_MICROSTRIP_UNCOVERED_MODEL"),
      message: modelText(item.message), affectedResults: item.affectedResults.map(text) })),
    scope: modelText(value.scope) };
}

const savedReasons = (values: readonly SavedInterfaceReason[]) => values.map(item => ({ code: text(item.code), message: modelText(item.message) }));
function project(value: SavedInterfaceAssessment) {
  const observed = value.construction.observed, reference = value.referenceRequirements;
  if (observed.dielectricGaps !== undefined && observed.dielectricGaps.length !== 3) throw new Error(ERROR);
  return { schemaVersion: "evleda.toolbox-interface-assessment.v1" as const,
    assessmentSchemaVersion: tag(value.schemaVersion, "evleda.saved-interface-assessment.v1"), assessmentIdentity: canonical(value.identity),
    sourceIdentity: content(value.sourceIdentity), bundleIdentity: canonical(value.bundleIdentity), contractIdentity: canonical(value.contractIdentity),
    verificationPlanIdentity: canonical(value.verificationPlanIdentity), interfaceId: text(value.interfaceId), requirementIdentity: canonical(value.requirementIdentity),
    sourceInventory: { status: tag(value.sourceInventory.status, "complete", "unsupported"), reasons: savedReasons(value.sourceInventory.reasons),
      selected: selected(value.sourceInventory.selected), observations: value.sourceInventory.observations.map(item => ({
        kind: tag(item.kind, "track", "pad", "via", "unsupported_route"), uuid: item.uuid === null ? null : text(item.uuid), net: item.net === null ? null : text(item.net),
        sourceIdentity: content(item.sourceIdentity), status: tag(item.status, "supported", "unsupported"), reasons: savedReasons(item.reasons) })), projectionComplete: flag(value.sourceInventory.projectionComplete) },
    geometry: value.geometry === null ? null : geometry(value.geometry),
    ...(value.channel === undefined ? {} : { channel: {
      kind: tag(value.channel.kind, "source_series"), inventoryComplete: flag(value.channel.inventoryComplete), accepted: flag(value.channel.accepted),
      copperEtchLength: { positive: value.channel.copperEtchLength.positive === null ? null : length(value.channel.copperEtchLength.positive),
        negative: value.channel.copperEtchLength.negative === null ? null : length(value.channel.copperEtchLength.negative) },
      budgets: { pathLength: check(value.channel.budgets.pathLength), totalCopperLength: check(value.channel.budgets.totalCopperLength), pathSkew: check(value.channel.budgets.pathSkew) },
      launch: geometry(value.channel.launch), receiverPaths: value.channel.receiverPaths.map(item => ({
        receiver: { positive: { reference: text(item.receiver.positive.reference), pin: pinText(item.receiver.positive.pin) },
          negative: { reference: text(item.receiver.negative.reference), pin: pinText(item.receiver.negative.pin) } }, geometry: geometry(item.geometry),
        positiveEtchLength: item.positiveEtchLength === null ? null : length(item.positiveEtchLength), negativeEtchLength: item.negativeEtchLength === null ? null : length(item.negativeEtchLength),
        etchSkew: item.etchSkew === null ? null : length(item.etchSkew) })),
      ...(value.channel.feedThrough === undefined ? {} : { feedThrough: {
        inputSection: geometry(value.channel.feedThrough.inputSection),
        downstreamPaths: value.channel.feedThrough.downstreamPaths.map(item => ({
          receiver: { positive: { reference: text(item.receiver.positive.reference), pin: pinText(item.receiver.positive.pin) }, negative: { reference: text(item.receiver.negative.reference), pin: pinText(item.receiver.negative.pin) } },
          positiveEtchLength: item.positiveEtchLength === null ? null : length(item.positiveEtchLength), negativeEtchLength: item.negativeEtchLength === null ? null : length(item.negativeEtchLength),
          etchSkew: item.etchSkew === null ? null : length(item.etchSkew), positiveUncoupledLength: item.positiveUncoupledLength === null ? null : length(item.positiveUncoupledLength),
          negativeUncoupledLength: item.negativeUncoupledLength === null ? null : length(item.negativeUncoupledLength) })),
        downstreamBudgets: { length: check(value.channel.feedThrough.downstreamBudgets.length), skew: check(value.channel.feedThrough.downstreamBudgets.skew), uncoupled: check(value.channel.feedThrough.downstreamBudgets.uncoupled) },
        componentTransfers: value.channel.feedThrough.componentTransfers.map(item => ({ componentReference: text(item.componentReference), polarity: tag(item.polarity, "positive", "negative"),
          input: { selector: terminal(item.input.selector), net: text(item.input.net) }, output: { selector: terminal(item.output.selector), net: text(item.output.net) },
          source: { kind: tag(item.source.kind, "caller_assertion"), reference: text(item.source.reference), description: text(item.source.description) }, pinMapping: check(item.pinMapping),
          authority: tag(item.authority, "caller_asserted_component_transfer"), pcbEtchContribution: tag(item.pcbEtchContribution, "excluded_component_path"),
          electricalDelay: tag(item.electricalDelay, "not_assessed"), electricalSkew: tag(item.electricalSkew, "not_assessed"), physicalInternalPath: tag(item.physicalInternalPath, "not_verified") })) } }),
      allTrackPairGaps: value.channel.allTrackPairGaps === null ? null : value.channel.allTrackPairGaps.map(item => ({ positiveUuid: text(item.positiveUuid), negativeUuid: text(item.negativeUuid),
        layerRelationship: tag(item.layerRelationship, "same_layer", "different_layer_not_assessed"), centerlineSquaredNm2: item.centerlineSquaredNm2 === null ? null : squared(item.centerlineSquaredNm2),
        radiusSumTwiceNm: integerText(item.radiusSumTwiceNm), minimumGap: tag(item.minimumGap, "pass", "fail", "not_assessed") })),
      checks: { sourcePolarity: check(value.channel.checks.sourcePolarity), topology: check(value.channel.checks.topology), width: check(value.channel.checks.width),
        minimumGap: check(value.channel.checks.minimumGap), coupledGap: check(value.channel.checks.coupledGap), length: check(value.channel.checks.length),
        skew: check(value.channel.checks.skew), stubs: check(value.channel.checks.stubs), uncoupled: check(value.channel.checks.uncoupled), transitions: check(value.channel.checks.transitions) },
      anchors: value.channel.anchors.map(item => ({ selector: terminal(item.selector), net: text(item.net), matchingPadUuids: item.matchingPadUuids.map(text),
        contactNodeIds: item.contactNodeIds.map(text), status: tag(item.status, "pass", "fail", "not_assessed") })),
      escapes: value.channel.escapes.map(item => ({ net: text(item.net), edgeId: edgeId(item.edgeId), widthNm: number(item.widthNm), qualifyingTerminals: item.qualifyingTerminals.map(terminal), status: tag(item.status, "pass", "fail", "not_assessed") })),
      protectionReturns: value.channel.protectionReturns.map(item => ({ reference: text(item.reference), pin: pinText(item.pin), expectedNet: text(item.expectedNet),
        matchingPadUuids: item.matchingPadUuids.map(text), status: tag(item.status, "pass", "fail", "not_assessed") })) } }),
    construction: { status: tag(value.construction.status, "matched_saved_declaration", "failed_saved_declaration", "unassessed"), reasons: savedReasons(value.construction.reasons),
      observed: { boardThicknessNm: nullableNumber(observed.boardThicknessNm), frontCopperThicknessNm: nullableNumber(observed.frontCopperThicknessNm),
        backCopperThicknessNm: nullableNumber(observed.backCopperThicknessNm), dielectricThicknessNm: nullableNumber(observed.dielectricThicknessNm),
        frontMaskThicknessNm: nullableNumber(observed.frontMaskThicknessNm), backMaskThicknessNm: nullableNumber(observed.backMaskThicknessNm),
        copperLayerOrder: observed.copperLayerOrder.map(text), dielectricMaterial: observed.dielectricMaterial === null ? null : materialText(observed.dielectricMaterial),
        relativePermittivity: nullableNumber(observed.relativePermittivity), lossTangent: nullableNumber(observed.lossTangent),
        surfaceFinish: observed.surfaceFinish === null ? null : materialText(observed.surfaceFinish),
        stackupSourceIdentity: observed.stackupSourceIdentity === null ? null : content(observed.stackupSourceIdentity),
        ...(observed.innerCopperThicknessNm === undefined ? {} : { innerCopperThicknessNm: {
          "In1.Cu":nullableNumber(observed.innerCopperThicknessNm["In1.Cu"]), "In2.Cu":nullableNumber(observed.innerCopperThicknessNm["In2.Cu"]) } }),
        ...(observed.dielectricGaps === undefined ? {} : { dielectricGaps: observed.dielectricGaps.map(gap => ({
          fromCopper:text(gap.fromCopper), toCopper:text(gap.toCopper), thicknessNm:nullableNumber(gap.thicknessNm),
          material:gap.material === null ? null : materialText(gap.material), relativePermittivity:nullableNumber(gap.relativePermittivity), lossTangent:nullableNumber(gap.lossTangent) })) }) },
      physicalConstruction: tag(value.construction.physicalConstruction, "not_verified"), assertionAuthority: tag(value.construction.assertionAuthority, "bound_caller_assertions"),
      sourceUnverifiedAssertionFields: value.construction.sourceUnverifiedAssertionFields.map(text) },
    terminations: { status: tag(value.terminations.status, "matched_source_facts", "failed_source_facts", "unassessed"), reasons: savedReasons(value.terminations.reasons),
      pins: value.terminations.pins.map(item => ({ side: tag(item.side, "source", "receiver"), polarity: tag(item.polarity, "positive", "negative"),
        kind: tag(item.kind, "integrated", "parallel", "source_series"), reference: text(item.reference),
        pin: pinText(item.pin), expectedNet: text(item.expectedNet), matchingPadUuids: item.matchingPadUuids.map(text),
        endpointPadUuid: item.endpointPadUuid === null ? null : text(item.endpointPadUuid),
        distanceSquaredNm2: item.distanceSquaredNm2 === null ? null : integerText(item.distanceSquaredNm2), maximumDistanceNm: nullableNumber(item.maximumDistanceNm),
        status: tag(item.status, "matched_source_facts", "failed_source_facts", "unassessed"), reasons: savedReasons(item.reasons) })),
      assertedResistanceOhms: value.terminations.assertedResistanceOhms.map(item => ({ side: tag(item.side, "source", "receiver"), value: number(item.value) })),
      resistanceVerification: tag(value.terminations.resistanceVerification, "caller_assertion_only"), deviceInternalTermination: tag(value.terminations.deviceInternalTermination, "not_verified") },
    referenceRequirements: { declarationStatus: tag(reference.declarationStatus, "matched_saved_zone", "unassessed"), reasons: savedReasons(reference.reasons), planeId: text(reference.planeId),
      net: reference.net === null ? null : text(reference.net), layer: reference.layer === null ? null : text(reference.layer), memberNets: reference.memberNets.map(text),
      matchingZoneUuids: reference.matchingZoneUuids.map(text), zoneSourceIdentity: reference.zoneSourceIdentity === null ? null : content(reference.zoneSourceIdentity),
      savedFillCachePresent: reference.savedFillCachePresent === null ? null : flag(reference.savedFillCachePresent), fillFreshness: tag(reference.fillFreshness, "not_verified"),
      wholeRouteCoverage: tag(reference.wholeRouteCoverage, "not_evaluated"), referenceElectricalEligibility: tag(reference.referenceElectricalEligibility, "not_evaluated") },
    impedance: { status: tag(value.impedance.status, "not_requested", "within_tolerance", "outside_tolerance", "unassessed"), reasons: savedReasons(value.impedance.reasons), targetOhm: nullableNumber(value.impedance.targetOhm),
      absoluteToleranceOhm: nullableNumber(value.impedance.absoluteToleranceOhm), frequencyHz: nullableNumber(value.impedance.frequencyHz),
      intervals: value.impedance.intervals.map(item => ({ index: number(item.index), positiveRunIndex: number(item.positiveRunIndex), negativeRunIndex: number(item.negativeRunIndex),
        positiveMemberUuids: item.positiveMemberUuids.map(text), negativeMemberUuids: item.negativeMemberUuids.map(text),
        positiveWidthNm: number(item.positiveWidthNm), negativeWidthNm: number(item.negativeWidthNm), centerlineSquaredNm2: squared(item.centerlineSquaredNm2),
        radiusSumTwiceNm: integerText(item.radiusSumTwiceNm), length: length(item.length), numericalGapNm: nullableNumber(item.numericalGapNm),
        numericalLengthNm: nullableNumber(item.numericalLengthNm), status: tag(item.status, "within_tolerance", "outside_tolerance", "unassessed"), reasons: savedReasons(item.reasons),
        applicability: { status: tag(item.applicability.status, "conditional_model_only", "unassessed"), widthToHeightRatio: nullableNumber(item.applicability.widthToHeightRatio),
          gapToHeightRatio: nullableNumber(item.applicability.gapToHeightRatio), frequencyGHzTimesHeightMm: nullableNumber(item.applicability.frequencyGHzTimesHeightMm),
          finiteThicknessCaveat: modelText(item.applicability.finiteThicknessCaveat) },
        calculatedDifferentialOhm: nullableNumber(item.calculatedDifferentialOhm), residualOhm: nullableNumber(item.residualOhm),
        calculation: item.calculation === null ? null : calculation(item.calculation) })),
      completeRouteModelCoverage: flag(value.impedance.completeRouteModelCoverage), differentialBasis: tag(value.impedance.differentialBasis, "twice_frequency_dependent_odd_mode_Z0_O"),
      unmodeledEffects: value.impedance.unmodeledEffects.map(text) },
    unevaluatedRows: value.unevaluatedRows.map(item => ({ id: text(item.id), kind: text(item.kind), reasons: savedReasons(item.reasons) })),
    limits: { maximumInputBytes: number(value.limits.maximumInputBytes), maximumAssessedSourceBytes: number(value.limits.maximumAssessedSourceBytes),
      maximumModelIntervals: number(value.limits.maximumModelIntervals), maximumSourcePhysicalPads: number(value.limits.maximumSourcePhysicalPads) },
    sourceAuthority: tag(value.sourceAuthority, "saved_byte_numerical_facts_and_bound_caller_assertions"),
    nativeReachability: tag(value.nativeReachability, "not_evaluated"), libraryMembership: tag(value.libraryMembership, "not_verified"),
    boardAccepted: flag(value.boardAccepted), interfaceAccepted: flag(value.interfaceAccepted), fabricationAuthorized: flag(value.fabricationAuthorized) };
}

function snapshot(assessment: SavedInterfaceAssessment) {
  const captured = hardenPortableValue(assessment, { maxBytes: 16 * 1024 * 1024, maxStringBytes: 1024 * 1024,
    maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 4096, maxKeyBytes: 512 }) as SavedInterfaceAssessment;
  const { identity, ...payload } = captured;
  if (captured.schemaVersion !== "evleda.saved-interface-assessment.v1"
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, captured.schemaVersion))
      || captured.boardAccepted !== false || captured.interfaceAccepted !== false || captured.fabricationAuthorized !== false
      || (captured.geometry !== null && captured.geometry.accepted !== false)
      || captured.channel !== undefined && (captured.channel.accepted !== false || captured.channel.launch.accepted !== false || captured.channel.receiverPaths.some(p => p.geometry.accepted !== false)
        || captured.channel.feedThrough !== undefined && captured.channel.feedThrough.inputSection.accepted !== false)) throw new Error(ERROR);
  return captured;
}
function completeReport(captured: SavedInterfaceAssessment) {
  const report = project(captured);
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_PUBLIC_BYTES) throw new Error(ERROR);
  return report;
}

/** A closed, detached public view of complete saved-interface evidence. Identity
 * reproduction is integrity checking; the owning evaluator supplies authority. */
export function summarizeSavedInterface(assessment: SavedInterfaceAssessment) {
  try {
    return completeReport(snapshot(assessment));
  } catch {
    // Never return foreign parser, helper, accessor or filesystem text to MCP.
    throw new Error(ERROR);
  }
}

export type ToolboxInterfaceReport = ReturnType<typeof summarizeSavedInterface>;

/** Preserve full immutable evidence in the exact host-owned output directory. */
export async function captureToolboxInterface(outputRoot: string, assessment: SavedInterfaceAssessment) {
  let captured: SavedInterfaceAssessment, report: ToolboxInterfaceReport, bytes: Buffer;
  try {
    captured = snapshot(assessment); report = completeReport(captured);
    bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
    if (bytes.length > 16 * 1024 * 1024) throw new Error(ERROR);
  } catch { throw new Error(ERROR); }
  try {
    const root = path.resolve(outputRoot);
    if (!path.isAbsolute(outputRoot)) throw new Error("Interface evidence output requires the exact host-owned directory.");
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("Interface evidence output requires an ordinary unaliased directory.");
    }
    const assertRoot = async () => {
      const current = await lstat(root, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
          || await realpath(root) !== root) throw new Error("Interface evidence directory changed during publication.");
    };
    const filename = `interface-assessment-${randomUUID()}.json`, target = path.join(root, filename);
    const handle = await open(target, "wx+", 0o600);
    let publicationFailure: { readonly cause: unknown } | undefined;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Interface evidence reservation is not exclusive.");
      await assertRoot(); await handle.writeFile(bytes); await handle.sync();
      const written = await handle.stat({ bigint: true }), physical = await lstat(target, { bigint: true });
      if (!written.isFile() || written.dev !== opened.dev || written.ino !== opened.ino || written.nlink !== 1n
          || written.size !== BigInt(bytes.length) || !physical.isFile() || physical.isSymbolicLink()
          || physical.dev !== written.dev || physical.ino !== written.ino || physical.nlink !== 1n
          || physical.size !== written.size || await realpath(target) !== target) throw new Error("Interface evidence artifact identity changed.");
      const readback = Buffer.alloc(bytes.length + 1); let count = 0;
      while (count < readback.length) {
        const part = await handle.read(readback, count, readback.length - count, count);
        if (part.bytesRead === 0) break;
        count += part.bytesRead;
      }
      const settled = await lstat(target, { bigint: true });
      if (!readback.subarray(0, count).equals(bytes) || !settled.isFile() || settled.isSymbolicLink()
          || settled.dev !== written.dev || settled.ino !== written.ino || settled.nlink !== 1n || settled.size !== written.size
          || settled.mtimeNs !== physical.mtimeNs || settled.ctimeNs !== physical.ctimeNs || await realpath(target) !== target) {
        throw new Error("Interface evidence readback differs from the complete assessment.");
      }
      await assertRoot();
      return { report, diagnostic: { filename, identity: contentIdentity(bytes) } };
    } catch (cause) {
      publicationFailure = { cause }; throw cause;
    } finally {
      try { await handle.close(); }
      catch (closeCause) {
        if (publicationFailure !== undefined) {
          throw new AggregateError([publicationFailure.cause, closeCause], "Interface evidence publication and close both failed.",
            { cause: publicationFailure.cause });
        }
        throw closeCause;
      }
    }
  } catch (cause) {
    // The MCP caller returns a fixed public message. Retain the first private
    // filesystem fault and failed reservation for the owning host's diagnosis.
    throw new Error("Interface private evidence publication failed; the host must inspect retained state.", { cause });
  }
}

export type ToolboxInterfaceResult = Awaited<ReturnType<typeof captureToolboxInterface>>;
