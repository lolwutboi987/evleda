import {
  PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  type PcbDesignIntentDraft,
} from "./pcb-design-contract.js";

export const PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION =
  "evleda.pcb-design-intent-model-guide.v2" as const;

export const PCB_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES = 8 * 1024;

/**
 * Provider-neutral semantic guidance for producing a strict PCB intent draft.
 * It is data only: provider adapters may include it in their own bounded prompt
 * construction, but this module has no provider, filesystem, or mutation seam.
 */
export const PCB_DESIGN_INTENT_MODEL_GUIDE = [
  `PCB DESIGN INTENT MODEL GUIDE ${PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION}`,
  `Emit one complete ${PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION} object as the tool arguments. The arguments are the draft itself, with no wrapper, prose, Markdown, or extra keys.`,
  "Every property required by the selected object or union branch must be present, and keys that belong only to an unselected branch must be absent. For each ordinary object described below, every listed key is required. Nullable means the key must be present with null when the user has not supplied that decision; it never means the key may be omitted. Arrays must also be present, using [] only where the schema permits an empty array.",
  "Required root keys: schemaVersion, kind, scope, components, nets, netClasses, placementConstraints, routingConstraints, unresolved.",
  "Use the fixed V1 literals exactly: schemaVersion=evleda.pcb-design-intent-draft.v1; kind=pcb_design_intent_draft; scope.sheetCount=1; scope.componentUnitPolicy=single_unit; scope.board.shape=rectangle; scope.board.layerCount=2; every component unit=1.",
  "Required scope.board keys: shape, widthMm, heightMm, layerCount, copperLayers. widthMm and heightMm may be null. copperLayers is always exactly [\"F.Cu\",\"B.Cu\"] once each, even when every route is restricted to F.Cu.",
  "V1 uses one shared board coordinate frame: the rectangle runs from (0,0) to (widthMm,heightMm), and every placement anchor and region uses those same coordinates. V1 has no outline-origin field. Do not translate the outline to make an otherwise contradictory placement fit.",
  "Each component requires reference, symbolLibId, value, footprintLibId, unit, pins. Each pin requires pin and assignment. An assignment is exactly one of {kind:\"net\",net}, {kind:\"no_connect\"}, or {kind:\"unresolved\",question}. Use null for unknown symbolLibId, value, or footprintLibId; never invent a library ID, footprint, package, value, or pin mapping.",
  "Each net requires name, role, endpoints, electrical, netClassId. Each endpoint requires reference and pin. A non-null electrical object requires voltage={minimumV,nominalV,maximumV}, current={nominalA,maximumContinuousA,peakA,peakDurationMs}, and speed. Require minimumV <= nominalV <= maximumV and nominalA <= maximumContinuousA <= peakA; ground nominalV is 0. Speed is exactly {kind:\"dc\",maximumFrequencyMHz:0,minimumEdgeTimeNs:null} or {kind:\"signal\",maximumFrequencyMHz,minimumEdgeTimeNs}. Use electrical:null rather than inventing any voltage, current, peak duration, frequency, or edge time.",
  "Connectivity is bidirectionally exact. Every {reference,pin} in a net endpoint list must name one declared component pin assigned to that same net; every net-assigned pin must occur exactly once in that net's endpoints; a no_connect or unresolved pin occurs on no net. Component references, pins within a component, net names, and net-class IDs are unique. Every non-null netClassId names one declared class.",
  "Each net class requires id, traceWidthMm, clearanceMm, copperToEdgeMm, allowedLayers. The four rule fields may be null. allowedLayers has no duplicates. Express F.Cu-only routing with netClasses[].allowedLayers=[\"F.Cu\"] and routingConstraints.nets[].preferredLayer=\"F.Cu\"; do not remove B.Cu from scope.board.copperLayers.",
  "Each placement constraint requires reference, side, regionMm, allowedRotationsDeg, minimumEdgeClearanceMm, minimumCourtyardClearanceMm, edgePreference. The reference is unique and names a component; every other placement field may be null. Encode an exact footprint-reference anchor (x,y) as regionMm={minXmm:x,maxXmm:x,minYmm:y,maxYmm:y}. A non-null region is ordered, lies inside the known board dimensions, and respects its non-null minimumEdgeClearanceMm. Rotations are unique members of 0, 90, 180, 270.",
  "Under the supported V1 placement evaluator, edgePreference selects the nearest courtyard edge, not the nearest footprint-reference anchor. Compute each board-edge clearance from the transformed footprint courtyard bounds; the selected edge must have the minimum clearance, allowing only the existing 0.0001 mm coordinate comparison tolerance. This geometric condition alone does not prove connector mating access.",
  "When supplied fixed anchors, rotations, exact footprint geometry, clearances, or edge preferences contradict each other, preserve the supplied values and flag the conflict in unresolved on the affected existing field. Do not move the connector, shift the outline origin, rotate the footprint, clear the edge preference, or increase tolerance to force readiness. If exact footprint geometry is unavailable, do not invent it or claim placement feasibility; the host must check the bound library geometry before execution.",
  "routingConstraints always requires cornerStyle, maximumTurnAngleDeg, minimumStraightBeforeTurnMm, allowRightAngleCorners, allowAcuteInteriorCorners, allowBacktracking, allowSelfIntersections, viaPolicy, nets. Nullable routing fields must still be present. For clean 45-degree routing use cornerStyle=\"miter_45\", maximumTurnAngleDeg=45, and false for the four allow* fields.",
  "Each routingConstraints.nets entry requires net, topology, preferredLayer, maxVias, routeLength; nullable route fields must still be present. routeLength is null, {mode:\"unbounded\"}, or {mode:\"bounded\",maximumMm}. The net is unique and declared. Use topology=\"point_to_point\" only for exactly two endpoints. topology=\"tree\" requires at least two endpoints and is required when a connected net has more than two endpoints. preferredLayer must be allowed by the selected net class; a single-layer class requires maxVias=0.",
  "Ready-only closure invariants: every component has exactly one placement constraint; every net has exactly one routing constraint; every declared net class is used by at least one net; every net has at least two unique endpoints; point_to_point has exactly two endpoints and tree has at least two. A still-unresolved draft may leave the corresponding nullable values null or permitted draft arrays incomplete so the host compiler can ask questions.",
  "Exactly zero vias means routingConstraints.viaPolicy={mode:\"forbidden\",maxTotal:0} and maxVias=0 on every route. A bounded via policy instead requires maxTotal, diameterMm, drillMm, minimumAnnularRingMm; each route maximum and their sum stay within maxTotal, and drillMm + 2*minimumAnnularRingMm <= diameterMm.",
  "unresolved is required and may be []. Keep nullable unknowns as null and unresolved pin mappings in their assignment objects; the host compiler asks for those values. Use unresolved only for an additional named ambiguity not already represented by a nullable field or unresolved pin assignment. An unresolved entry requires exactly path and question. Its path is a keyed semantic pointer to an existing field: /components/R1/footprintLibId, /nets/VOUT/electrical, /netClasses/POWER/clearanceMm, /placementConstraints/J1/allowedRotationsDeg, or /routingConstraints/nets/VOUT/routeLength. Select collections by reference, net name, or class ID; never use a numeric array index or a compiler dot path.",
  "Do not add fields for hairpins, cycles, disconnected islands, free-space tees, saving, validation, fabrication, export, or ordering. Those are downstream execution or acceptance concerns and strict draft objects reject extra keys. Preserve such user requirements only through the schema fields that exist; do not invent a substitute field.",
].join("\n");

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const validExample = {
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: {
      shape: "rectangle",
      widthMm: null,
      heightMm: null,
      layerCount: 2,
      copperLayers: ["F.Cu", "B.Cu"],
    },
  },
  components: [
    {
      reference: "J1",
      symbolLibId: null,
      value: null,
      footprintLibId: null,
      unit: 1,
      pins: [{ pin: "1", assignment: { kind: "net", net: "N1" } }],
    },
    {
      reference: "R1",
      symbolLibId: null,
      value: null,
      footprintLibId: null,
      unit: 1,
      pins: [{ pin: "1", assignment: { kind: "net", net: "N1" } }],
    },
  ],
  nets: [{
    name: "N1",
    role: null,
    endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }],
    electrical: null,
    netClassId: "DEFAULT",
  }],
  netClasses: [{
    id: "DEFAULT",
    traceWidthMm: null,
    clearanceMm: null,
    copperToEdgeMm: null,
    allowedLayers: ["F.Cu"],
  }],
  placementConstraints: [
    {
      reference: "J1",
      side: "front",
      regionMm: { minXmm: 2, maxXmm: 2, minYmm: 5, maxYmm: 5 },
      allowedRotationsDeg: null,
      minimumEdgeClearanceMm: null,
      minimumCourtyardClearanceMm: null,
      edgePreference: null,
    },
    {
      reference: "R1",
      side: "front",
      regionMm: { minXmm: 8, maxXmm: 8, minYmm: 5, maxYmm: 5 },
      allowedRotationsDeg: null,
      minimumEdgeClearanceMm: null,
      minimumCourtyardClearanceMm: null,
      edgePreference: null,
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
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [{
      net: "N1",
      topology: "point_to_point",
      preferredLayer: "F.Cu",
      maxVias: 0,
      routeLength: null,
    }],
  },
  unresolved: [],
} as const satisfies PcbDesignIntentDraft;

/** Complete parser-valid example. It demonstrates shape, not resolved design facts. */
export const PCB_DESIGN_INTENT_VALID_EXAMPLE: PcbDesignIntentDraft = deepFreeze(validExample);
