import { z } from "zod";

import {
  PCB_PLANE_DRAFT_SCHEMA_VERSION,
  freezePcbPlaneArtifact,
  pcbPlaneDesignIntentDraftSchema,
  type PcbPlaneDesignIntentDraft,
} from "./pcb-design-plane-contract.js";

export const PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_VERSION =
  "evleda.pcb-plane-design-intent-model-guide.v3" as const;
export const PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES = 12 * 1024;

/** Exact detached schema; provider adapters do not own or mutate its definition. */
export const PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA = freezePcbPlaneArtifact(structuredClone(
  z.toJSONSchema(pcbPlaneDesignIntentDraftSchema, { target: "draft-2020-12" }),
));

/** Provider-neutral data only: no provider, filesystem, or native mutation seam. */
export const PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE = [
  `PCB PLANE DESIGN INTENT MODEL GUIDE ${PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_VERSION}`,
  `Emit one complete ${PCB_PLANE_DRAFT_SCHEMA_VERSION} object as the draft argument. The draft itself has no wrapper, prose, Markdown, identity, or extra keys. Follow the canonical JSON Schema and host parser; JSON Schema alone does not express every cross-field relationship.`,
  "Every property required by the selected object or union branch must be present; keys belonging only to an unselected branch must be absent. Nullable means use an explicit null for an unknown decision, never omit its key. Arrays are present; [] is permitted only where the draft schema permits an empty array. Do not invent values to make the compiler return ready.",
  "Required root keys: schemaVersion, kind, scope, components, nets, netClasses, placementConstraints, routingConstraints, planes, unresolved. Fixed V2 literals: schemaVersion=evleda.pcb-design-intent-draft.v2; kind=pcb_design_intent_draft; scope.sheetCount=1; scope.componentUnitPolicy=single_unit; scope.board.shape=rectangle; scope.board.layerCount=2 or 4; every component unit=1.",
  "scope.board requires shape, widthMm, heightMm, layerCount, copperLayers. Unknown dimensions are null. Two-layer copperLayers contains F.Cu and B.Cu exactly once; four-layer copperLayers contains F.Cu, In1.Cu, In2.Cu and B.Cu exactly once. Four-layer boards require explicit four_layer construction. The rectangle runs from (0,0) to (widthMm,heightMm); all placement and plane coordinates share that frame. Native editing requires a runtime advertising the selected copper layers; older outer-layer-only stages reject inner-layer requests before dispatch. Compilation alone does not establish native or electrical acceptance.",
  "Each component requires reference, symbolLibId, value, footprintLibId, unit, pins. Each pin requires pin and assignment. Assignment is exactly {kind:\"net\",net}, {kind:\"no_connect\"}, or {kind:\"unresolved\",question}. Unknown symbolLibId, value, or footprintLibId is null. Never invent library IDs, package choices, pin numbers or pin mappings. The illustrative example's components and pins are fictional shape examples, not a pinout to reuse.",
  "Each net requires name, role, endpoints, electrical, netClassId. Each endpoint requires reference and pin. Connectivity is bidirectionally exact even in a draft: every net-assigned pin appears exactly once in its declared net's endpoints, and every endpoint names a declared pin assigned to that same net. No-connect or unresolved pins appear on no net. References, pin numbers within each component, net names and net-class IDs are unique; every non-null netClassId names a declared class.",
  "A non-null electrical object requires voltage={minimumV,nominalV,maximumV}, current={nominalA,maximumContinuousA,peakA,peakDurationMs}, and speed. Require minimumV <= nominalV <= maximumV and nominalA <= maximumContinuousA <= peakA; ground nominalV is 0. Speed is exactly {kind:\"dc\",maximumFrequencyMHz:0,minimumEdgeTimeNs:null} or {kind:\"signal\",maximumFrequencyMHz,minimumEdgeTimeNs}. Use electrical:null rather than fabricate any voltage, current, duration, frequency, or edge time.",
  "Each net class requires id, traceWidthMm, clearanceMm, copperToEdgeMm, allowedLayers; the four rule fields may be null. Non-null allowedLayers contains no duplicates. A plane layer and its access-routing preferred layer must both be allowed by that net's class. A single-layer class requires maxVias=0. Numerical trace, clearance and via rules require supplied engineering decisions; neither the example nor passing the schema establishes electrical sizing.",
  "Each placement requires reference, side, regionMm, allowedRotationsDeg, minimumEdgeClearanceMm, minimumCourtyardClearanceMm, edgePreference. The reference is unique and names a component; other fields may be null. An exact footprint-reference anchor (x,y) is regionMm={minXmm:x,maxXmm:x,minYmm:y,maxYmm:y}. Regions are ordered, inside known board dimensions and consistent with edge clearance. Rotations are unique members of 0,90,180,270. Closed V2 placements are front-only; do not silently flip a requested back-side component.",
  "Preserve supplied anchors, rotations, footprint choices, clearances and edge preferences. Do not move a connector, translate the outline, rotate a part, clear an edge preference or relax a tolerance to force readiness. Flag contradictory requirements at an existing unresolved field, and let the host validate exact bound library geometry. The shared placement evaluator measures the nearest transformed courtyard edge, not merely the footprint anchor; this does not establish connector mating access. Library resolution also requires connectors to specify an edge and one rotation.",
  "routingConstraints requires cornerStyle, maximumTurnAngleDeg, minimumStraightBeforeTurnMm, allowRightAngleCorners, allowAcuteInteriorCorners, allowBacktracking, allowSelfIntersections, viaPolicy, nets. For the required 45-degree PCB trace-turn policy use cornerStyle=\"miter_45\", maximumTurnAngleDeg=45 and false for all four allow* fields; straight continuation is allowed. Preserve a supplied stricter maximum instead of relaxing it to 45; an unresolved maximum may be null. Keep an unknown minimumStraightBeforeTurnMm null. The trace-turn rule applies to plane access tracks too; it does not prohibit rectangular outlines, plane boundaries or orthogonal schematic wires.",
  "This bounded V2 family supports one rectangular ground plane on two-layer boards, and one or two on four-layer boards. planes may be [] while unresolved. Two planes must occupy distinct enabled copper layers. Each requires id, net, layer, boundary, clearanceMm, minimumCopperWidthMm, copperFill, padConnection, islandPolicy; all except id may be null in a draft. The resolved net has role=ground, the layer is enabled and permitted by its net class, and copperFill is solid. Do not substitute a trace tree for a plane.",
  "A non-null boundary is exactly {kind:\"rectangle\",minXmm,maxXmm,minYmm,maxYmm}, with positive area inside the board and its net-class copperToEdgeMm inset. Plane clearanceMm cannot weaken net-class clearanceMm. padConnection is null, {mode:\"solid\"}, or {mode:\"thermal\",gapMm,spokeWidthMm,minimumConnectedSpokes}; the three thermal values may be null while unresolved. Resolved minimumConnectedSpokes is 1..4 and spokeWidthMm must meet minimumCopperWidthMm. islandPolicy is null or {removeUnconnected:true,minimumAreaMm2,requireSingleConnectedComponent:true}; minimumAreaMm2 may be null, and when known cannot exceed the plane boundary area. Every setting is explicit; no guessed dimensions or thermal defaults.",
  "A supplemental plane on a four-layer board may instead declare islandPolicy={removeUnconnected:true,minimumAreaMm2,requireSingleConnectedComponent:false,referencePlaneId,engineeringBasis}. It must be an additionalPlaneIds member, reference its own routing owner's primary plane on the same ground net, and never serve as a required continuous-plane or interface signal reference. The primary retains requireSingleConnectedComponent:true. referencePlaneId and engineeringBasis may be null while unresolved; engineeringBasis is explicit caller rationale, not approval. Each stored region then requires complete source/native via-contact and retained-area evidence, with independent full drill-clipped continuity still unproven until assessed. This is separate intent, not a waiver or an edit to an existing bound contract.",
  "Each plane-topology route requires net, topology:plane, planeId, accessRouting; additionalPlaneIds may optionally name one further plane on the same net. No top-level preferredLayer, maxVias, routeLength or referencePath. planeId/accessRouting may be null; additionalPlaneIds may be null while unresolved. Access preferredLayer is an exact enabled class layer, either for exactly F.Cu/B.Cu, or any on four-layer boards for all declared class layers. Each plane has exactly one routing owner through planeId or additionalPlaneIds. Access limits cover the combined net tracks/vias, not plane interiors.",
  "Each trace route has exactly net, topology, preferredLayer, maxVias, routeLength, referencePath. topology is null, point_to_point or tree. At closure point_to_point requires two endpoints; tree connects at least two. A plane net must use plane topology. preferredLayer is null, an exact enabled class layer, either for F.Cu/B.Cu, or any for four-layer boards. In either route branch, routeLength is null, {mode:unbounded}, or {mode:bounded,maximumMm}.",
  "A trace referencePath is null, {mode:\"none\"}, or {mode:\"continuous_plane\",planeId,signalLayer,coverageMarginMm,layerTransitions:\"forbidden\",terminalReferences}. The continuous-plane fields planeId, signalLayer, coverageMarginMm and terminalReferences may be null while unresolved. When resolved, the referenced plane exists on an adjacent enabled copper layer; signalLayer equals the route's one exact preferredLayer, never \"either\" or \"any\"; route maxVias=0 and layer transitions are forbidden. Each terminal reference has exactly signalEndpoint and referenceEndpoint, both {reference,pin}. Every signal endpoint requires exactly one explicit mapping to a terminal on the referenced ground net. Do not invent internal component ties or infer a return terminal from proximity.",
  "viaPolicy is null, {mode:\"forbidden\",maxTotal:0}, or {mode:\"bounded\",maxTotal,diameterMm,drillMm,minimumAnnularRingMm}. A forbidden policy requires zero vias for every trace and plane-access route. The sum of all trace and plane-access maxVias values stays within bounded maxTotal. Require drillMm + 2*minimumAnnularRingMm <= diameterMm. Leave the policy null when its necessary decisions are unknown.",
  "Ready closure requires all mandatory choices resolved, one plane on two-layer boards or one/two on four-layer boards, one placement per component, one route per net, no unused net classes, at least two unique endpoints per net, and no unresolved pin assignments. Empty unresolved alone does not establish readiness. Compilation binds exact supported stock symbol and footprint pin/pad inventories, and deterministic design-rule guidance must resolve. This inventory binding does not verify physical geometry; source-bound geometry checks remain required before relevant native authoring and acceptance.",
  "unresolved is required and may be []. Keep nullable unknowns as null; the compiler asks for them. Use unresolved for additional named ambiguities, with exactly path and question. Prefer stable keyed RFC6901 pointers to existing fields, such as /planes/GND_PLANE/clearanceMm or /routingConstraints/nets/N1/referencePath. Escape ~ as ~0 and / as ~1 in keys. Do not use compiler dot paths, root /, or duplicate equivalent paths. If padConnection is null, target /planes/GND_PLANE/padConnection, not a nonexistent child gapMm; for an empty collection target that collection.",
  "The example is incomplete structural guidance, not supplied design facts or an approved design. Read evleda_design_context for native capabilities. Ready compilation neither authors CAD, evaluates acceptance, authorizes manufacturing nor permits changing user constraints. Fresh plane contact/fill/clearance/thermal/island/reference, ERC/DRC and visual evidence remain required; continuous-plane intent is not impedance or EMC qualification.",
  "Optional terminalLaunches: 1-2 {signalEndpoint,referenceEndpoint,maximumLengthMm,maximumReturnSpacingMm,engineeringBasis}. Only point_to_point reference paths outside interfaces; match terminalReferences on one footprint. Positive exact-nm bounds: length<=3 mm, spacing<=5 mm; bounds/basis nullable in drafts. Capability bounds are not defaults. Require matched native/source PTH geometry, direct return contact, foreign-bore separation and native DRC; keep body margins. Existing boards use evleda_revise_terminal_launches after normal close. Studies grant no exception.",
].join("\n");

const validExample = {
  schemaVersion: PCB_PLANE_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: null, heightMm: null, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: null, value: null, footprintLibId: null, unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "N1" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
    {
      reference: "J2", symbolLibId: null, value: null, footprintLibId: null, unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "N1" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
  ],
  nets: [
    {
      name: "GND", role: "ground", electrical: null, netClassId: "GROUND",
      endpoints: [{ reference: "J1", pin: "2" }, { reference: "J2", pin: "2" }],
    },
    {
      name: "N1", role: null, electrical: null, netClassId: "SIGNAL",
      endpoints: [{ reference: "J1", pin: "1" }, { reference: "J2", pin: "1" }],
    },
  ],
  netClasses: [
    { id: "GROUND", traceWidthMm: null, clearanceMm: null, copperToEdgeMm: null, allowedLayers: ["F.Cu", "B.Cu"] },
    { id: "SIGNAL", traceWidthMm: null, clearanceMm: null, copperToEdgeMm: null, allowedLayers: ["F.Cu"] },
  ],
  placementConstraints: [
    {
      reference: "J1", side: null, regionMm: null, allowedRotationsDeg: null,
      minimumEdgeClearanceMm: null, minimumCourtyardClearanceMm: null, edgePreference: null,
    },
    {
      reference: "J2", side: null, regionMm: null, allowedRotationsDeg: null,
      minimumEdgeClearanceMm: null, minimumCourtyardClearanceMm: null, edgePreference: null,
    },
  ],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: null,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: null,
    nets: [
      {
        net: "GND", topology: "plane", planeId: "GND_PLANE",
        accessRouting: { preferredLayer: "B.Cu", maxVias: null, routeLength: null },
      },
      {
        net: "N1", topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 0, routeLength: null,
        referencePath: {
          mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu",
          coverageMarginMm: null, layerTransitions: "forbidden",
          terminalReferences: [
            { signalEndpoint: { reference: "J1", pin: "1" }, referenceEndpoint: { reference: "J1", pin: "2" } },
            { signalEndpoint: { reference: "J2", pin: "1" }, referenceEndpoint: { reference: "J2", pin: "2" } },
          ],
        },
      },
    ],
  },
  planes: [{
    id: "GND_PLANE", net: "GND", layer: "B.Cu", boundary: null,
    clearanceMm: null, minimumCopperWidthMm: null, copperFill: "solid",
    padConnection: { mode: "thermal", gapMm: null, spokeWidthMm: null, minimumConnectedSpokes: null },
    islandPolicy: { removeUnconnected: true, minimumAreaMm2: null, requireSingleConnectedComponent: true },
  }],
  unresolved: [],
} as const satisfies PcbPlaneDesignIntentDraft;

/** Parser-valid shape fixture with deliberately unresolved engineering decisions. */
export const PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE: PcbPlaneDesignIntentDraft =
  freezePcbPlaneArtifact(structuredClone(validExample));

/** Opt-in extension; the existing omitted-interface guide remains byte-identical. */
// Guide v2 adds three-gap construction, multi-plane ownership and native capability limits.
export const PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES = 22 * 1024;
export const PCB_PLANE_INTERFACE_REQUIREMENTS_MODEL_GUIDE = [
  "Optional interfaceRequirements is internally versioned as evleda.pcb-interface-requirements.v1. Omit it when no interface intent was requested; never add a default null, empty object or empty array to an existing omitted-field draft. Once requested, unknown choices are explicit null and must be resolved before closure. It contains construction and interfaces; interfaces contain explicit kind=differential_pair and unique id. No protocol name supplies numeric geometry, material, termination or impedance defaults.",
  "Each pair declares exactly nets={positive,negative} and endpoints={source:{positive,negative},receiver:{positive,negative}}. Each role endpoint is {reference,pin}; all four physical pins are distinct. routing declares allowedLayers, layerTransitions=forbidden, stubs=forbidden, referencePlaneId and polarityInversion={policy:forbidden|allowed_at_receiver,receiverMapping:normal|inverted}. A permitted inversion still requires an explicit receiverMapping. Both member routes use one identical signal layer, zero vias and continuous_plane referencePath to the declared adjacent-layer plane. A net belongs to only one pair.",
  "geometry requires traceWidthMm and edgeGapMm, each {minimumMm,maximumMm}, plus maxEtchLengthMm, maxEtchSkewMm and maxUncoupledLengthMm. Preserve all supplied bounds; each member's net-class width lies in the width interval and the minimum gap meets both member clearances. These are complete-route budgets including bends, launches and termination access, not an isolated straight-section allowance.",
  "terminations requires source and receiver declarations. Each declaration is {kind:none,source}, {kind:integrated,componentReference,positivePin,negativePin,source}, or {kind:parallel,componentReference,positivePin,negativePin,resistanceOhms,maximumDistanceToEndpointMm,source}. Integrated pins are the exact endpoint role pins. External parallel termination pins are additional explicitly declared member-net endpoints; use tree routing where they make more than two physical endpoints, preserve all termination anchors, and still require a unique source-to-receiver route with no undeclared branch. Source-series intent may be retained as {kind:source_series,positive:{componentReference,sourcePin,linePin,resistanceOhms},negative:{componentReference,sourcePin,linePin,resistanceOhms},maximumDistanceToEndpointMm,source}; its split-net topology returns explicit unsupported rather than being dropped or made ready.",
  "impedance is {mode:none} or {mode:differential,targetOhms,toleranceOhms,frequencyHz,constructionId,source}. For two-layer boards, a differential request requires an explicit construction={mode:two_layer,id,boardThicknessMm,frontCopperThicknessMm,backCopperThicknessMm,dielectric,conductor,solderMask,exterior,surfaceFinish,source}; otherwise a two-layer board may use construction={mode:none}. Four-layer construction uses mode:four_layer, keeps the shared fields, replaces dielectric with frontDielectric/coreDielectric/backDielectric, and adds inner1CopperThicknessMm, inner2CopperThicknessMm and nominalFinishedBoardThicknessMm. The nominal finished thickness is separate from the exact native copper/dielectric/mask sum; no missing material data is inferred. dielectric requires thicknessMm, material, relativePermittivity, lossTangent, frequencyHz, substrateRelativePermeability and source; conductor requires conductivitySiemensPerMetre, relativePermeability, roughnessNm and source. Board thickness is an explicit total, never an inferred mask sum. Each solderMask side front/back is {kind:absent} or {kind:present,thicknessMm,material,relativePermittivity,lossTangent,frequencyHz,source}; exterior is explicitly {front:air,back:air}. Material frequencies equal the requested calculation frequency; do not interpolate or fabricate properties.",
  "Every source is {kind:caller_assertion,reference,description}. Preserve supplied citations as caller-asserted intent; citations and all construction/material declarations are never verified physical authority. Unknown source objects or fields stay null. Use stable unresolved paths such as /interfaceRequirements/interfaces/LINK/geometry/maxEtchSkewMm. Complete unknown nested objects can be null; do not target nonexistent children. Construction describes native new-board creation, not a live IPC stackup setter. Saved-file readback and independent complete-route assessment remain required; model-supported analytical impedance is not measured impedance, EMC qualification, or device qualification. All mandatory interface rows remain unknown until the independent supported assessor supplies current-source evidence.",
  "Known construction thicknesses must be exact integer nanometres within the native serializer domain. The explicitly supplied board total must equal the declared copper, homogeneous dielectric and present-mask thicknesses; do not infer or replace that total. Material Er/Df and names must survive the pinned native serializer exactly; unsupported precision or its unspecified-material sentinel produces clarification, never silent rounding or a guessed replacement.",
].join("\n");

export const PCB_PLANE_EXTERNAL_POWER_MODEL_GUIDE = [
  "Optional externalPowerInputs declares caller-asserted off-board power. Omit it when external power was not requested; never add default null or an empty array to an existing omitted-field draft. A requested but unknown declaration may be null; otherwise supply 1..8 closed entries {id,supplyEndpoint,returnEndpoint}. IDs are unique; each endpoint is null while unknown, or exactly {reference,pin} naming an existing physical connector pin. Resolve all unknowns before closure.",
  "Supply and return endpoints and their assigned nets are distinct. Every endpoint has an exact existing net assignment; no-connect pins are forbidden. The supply net role is power_input and return net role is ground. Each supply net has one declaration; multiple supplies may share a return net. Sort declarations by id. Use stable unresolved paths such as /externalPowerInputs/INPUT/supplyEndpoint; target the whole field when externalPowerInputs is null.",
  "External declarations assert the caller intends an off-board source at those connector pins; they do not establish actual connection, voltage or physical qualification. The host separately binds and authors canonical stock power:PWR_FLAG annotations, one per unique supply or return net, from approved current stock source. Do not invent flag components, footprints, pads, net endpoints, or numeric electrical values in the draft. Preserve physical components and connectivity; native ERC and exact annotation source/connectivity checks remain required.",
].join("\n");

export const PCB_PLANE_DERIVED_POWER_MODEL_GUIDE = [
  "Optional derivedPowerSources records internal rails; omit unless requested. Declare 1..8 entries {id,drivingEndpoint,path,supplyEndpoint,returnEndpoint,source,operatingAssumptions}, sorted by id. Endpoints are {reference,pin}; path is 1..8 ordered {reference,entryPin,exitPin} steps; source is {kind:caller_assertion,reference,description}; operatingAssumptions is nonempty text. Unknown endpoints/path/source/operatingAssumptions or source text may be null; resolve before closure. Stable path: /derivedPowerSources/CORE/path.",
  "Without externalPowerInput, the inspected driver is power_out, each path part is two-pin stock Device:L or Device:R, and returnEndpoint is that driver's inspected power_in GND/PGND. All source power_in pins remain connected; post-inductor DVDD self-supply is allowed.",
  "For one external-fed diode, add optional externalPowerInput={id,diodeForwardDropAssumption,operatingModes}; unknown fields may be null; resolve before closure. id names an exact externalPowerInputs binding; drivingEndpoint equals its connector supply endpoint. Use exactly one stock Device:D_Schottky, entryPin=2 (A), exitPin=1 (K). supplyEndpoint is the consumer's inspected power_in; returnEndpoint is its inspected power_in GND/PGND on the same external return net. Declare diode-drop and energized/absent/reverse/disabled/alternate/simultaneous-source assumptions; infer no voltage or power availability.",
  "Both paths need continuous distinct nets, a final power-role supply anchor, no repeated components/nets, ground traversal or NC. Assertions are not electrical/current/thermal/feedback qualification. Do not relabel internal rails as external, retype passives or suppress ERC. Preserve physical components and nets. The host binds complete source pins and merges schematic-only stock PWR_FLAG annotations, one per net, at most 16. Saved pin facts and every upstream/path/return native group must verify before flag exclusion; native ERC remains independent. Capacitive and other diode paths are unsupported.",
].join("\n");

export const PCB_PLANE_CHANNEL_MODEL_GUIDE = [
  "Only when source-series channel intent is requested, add optional channel to its differential_pair; otherwise omit it entirely. It is {kind:source_series,launchNets:{positive,negative},additionalReceivers:[{positive:{reference,pin},negative:{reference,pin}}],protection:[{componentReference,positivePins,negativePins,ground:{pin,net},supply:{pin,net},source}],escapes:[{terminal:{reference,pin},traceWidthMm:{minimumMm,maximumMm},maximumRoutedLengthMm}],maximumLaunchEtchLengthMm,maximumBranchEtchLengthMm,maxEtchLengthMm,maxTotalCopperLengthMm,maxEtchSkewMm,source}. No dimensions, contact mappings or source assertions are inferred.",
  "For this bounded channel, pair.nets are the two line nets. Add two distinct launch nets and keep source-series resistor mappings in terminations.source; terminations.receiver is explicit none and receiver polarity is preserved. Include every source, resistor, connector contact and protection signal pin on exactly its declared net. Protection ground matches the reference ground net, supply matches its declared power net. All four signal nets share an allowed layer and continuous reference plane; no vias, cycles, disconnected copper, undeclared taps or fabricated chip-internal connections are admitted.",
  "The body class width remains in geometry.traceWidthMm. Channel per-track widths require its declared body or terminal escape intervals, all at least 0.2 mm; ordinary nets may explicitly widen above their existing class floor. Final source graphs prove narrow edges lie within maximumRoutedLengthMm of their declared terminal; planar proximity does not authorize escapes. Branch attachments and leaves require declared pad centers. maxEtchLengthMm bounds each complete MCU-to-contact copper path; maxTotalCopperLengthMm separately bounds unique physical copper per polarity including branches, counted once. Measure complete launch plus every receiver path and all opposing copper gaps across four nets. Neckdowns, taps, resistors and protection remain outside whole-channel electromagnetic qualification.",
].join("\n");

export const PCB_PLANE_FEED_THROUGH_MODEL_GUIDE = [
  "Optional source_series channel requires launchNets, additionalReceivers, protection, escapes, maximumLaunchEtchLengthMm, maximumBranchEtchLengthMm, maxEtchLengthMm, maxTotalCopperLengthMm, maxEtchSkewMm and source. Keep source-series resistor pin mappings in terminations.source, receiver termination none and preserved polarity. Without feedThrough the existing four-net topology remains unchanged.",
  "For one manufacturer-cited six-pin protection stage, add channel.feedThrough={kind:two_line_protection,componentReference,inputNets:{positive,negative},positive:{inputPin,outputPin},negative:{inputPin,outputPin},source:{kind:caller_assertion,reference,description}}. Unknown draft fields may be null; all must resolve before closure. This exact component must be the sole protection entry, whose positivePins/negativePins each contain its two transfer pins, plus distinct ground/supply pins.",
  "Declare six distinct native copper nets. launchNets join MCU pins to resistor sourcePins; inputNets join resistor linePins to transfer inputPins; pair.nets join transfer outputPins to every receiver contact. Example middle names USB_DP_ESD/USB_DM_ESD. The host requires complete pinned symbol inspection: each explicit pair has matching passive IO names, the two channel names differ, and ground/supply are inspected power_in pins. Manufacturer citations assert internal transfers; names alone never prove conduction.",
  "Preserve every physical pin and independently verify all six copper graphs, polarity, pad-center branches, reference coverage and zero-via routing. Body/escape widths retain the 0.2 mm floor and exact routed escape distances. Pair geometry length/skew/uncoupled limits cover input plus port copper together; channel path limits add launch copper, and total copper counts branches once. Package paths are excluded from PCB etch, never imaginary tracks or zero delay. Package delay/skew and whole-channel electrical behavior remain not assessed.",
].join("\n");

export function getPcbPlaneDesignIntentModelGuide(includeInterfaceRequirements = false, includeExternalPowerInputs = false, includeChannel = false, includeDerivedPowerSources = false, includeFeedThrough = false): string {
  return PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE + (includeInterfaceRequirements ? `\n${PCB_PLANE_INTERFACE_REQUIREMENTS_MODEL_GUIDE}` : "")
    + (includeExternalPowerInputs ? `\n${PCB_PLANE_EXTERNAL_POWER_MODEL_GUIDE}` : "") + (includeChannel ? `\n${includeFeedThrough ? PCB_PLANE_FEED_THROUGH_MODEL_GUIDE : PCB_PLANE_CHANNEL_MODEL_GUIDE}` : "")
    + (includeDerivedPowerSources ? `\n${PCB_PLANE_DERIVED_POWER_MODEL_GUIDE}` : "");
}
