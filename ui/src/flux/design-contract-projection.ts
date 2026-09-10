import { z } from "zod";

const cleanText = (maximum: number) => z.string().min(1).max(maximum).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const identifier = cleanText(64).regex(/^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/u);
const componentReference = cleanText(32).regex(/^[A-Z][A-Z0-9_-]{0,31}$/u);
const pinNumber = cleanText(32).regex(/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u);
const libraryIdentifier = cleanText(192).regex(/^[^\s:]+:[^\s:]+$/u);
const netName = cleanText(64).regex(/^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u);
const finite = (minimum: number, maximum: number) => z.number().finite().min(minimum).max(maximum).refine((value) => !Object.is(value, -0));
const integer = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum).refine((value) => !Object.is(value, -0));
const identity = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  schemaVersion: z.literal("evleda.pcb-design-contract.v1"),
  canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
}).strict();

const assignment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("net"), net: netName }).strict(),
  z.object({ kind: z.literal("no_connect") }).strict(),
]);
const endpoint = z.object({ reference: componentReference, pin: pinNumber }).strict();
const routeLength = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unbounded") }).strict(),
  z.object({ mode: z.literal("bounded"), maximumMm: finite(0.1, 5_000) }).strict(),
]);
const viaPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("forbidden"), maxTotal: z.literal(0) }).strict(),
  z.object({ mode: z.literal("bounded"), maxTotal: integer(1, 256), diameterMm: finite(0.2, 3), drillMm: finite(0.1, 2), minimumAnnularRingMm: finite(0.05, 1) }).strict(),
]);

export const fluxDesignContractSchema = z.object({
  schemaVersion: z.literal("evleda.pcb-design-contract.v1"),
  kind: z.literal("pcb_design_contract"),
  scope: z.object({
    sheetCount: z.literal(1),
    componentUnitPolicy: z.literal("single_unit"),
    board: z.object({
      shape: z.literal("rectangle"),
      widthMm: finite(5, 500),
      heightMm: finite(5, 500),
      layerCount: z.literal(2),
      copperLayers: z.tuple([z.literal("F.Cu"), z.literal("B.Cu")]),
    }).strict(),
  }).strict(),
  components: z.array(z.object({
    reference: componentReference,
    symbolLibId: libraryIdentifier,
    value: cleanText(192),
    footprintLibId: libraryIdentifier,
    unit: z.literal(1),
    pins: z.array(z.object({ pin: pinNumber, assignment }).strict()).min(1).max(128),
  }).strict()).min(1).max(64),
  nets: z.array(z.object({
    name: netName,
    role: z.enum(["ground", "power_input", "power_output", "power", "analog", "digital", "clock", "control", "interface", "passive"]),
    endpoints: z.array(endpoint).min(2).max(256),
    electrical: z.object({
      voltage: z.object({ minimumV: finite(-500, 500), nominalV: finite(-500, 500), maximumV: finite(-500, 500) }).strict(),
      current: z.object({ nominalA: finite(0, 100), maximumContinuousA: finite(0, 100), peakA: finite(0, 200), peakDurationMs: finite(0.001, 86_400_000) }).strict(),
      speed: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("dc"), maximumFrequencyMHz: z.literal(0), minimumEdgeTimeNs: z.null() }).strict(),
        z.object({ kind: z.literal("signal"), maximumFrequencyMHz: finite(0.000_001, 100_000), minimumEdgeTimeNs: finite(0.001, 1_000_000_000) }).strict(),
      ]),
    }).strict(),
    netClassId: identifier,
  }).strict()).min(1).max(128),
  netClasses: z.array(z.object({
    id: identifier,
    traceWidthMm: finite(0.05, 20),
    clearanceMm: finite(0.05, 10),
    copperToEdgeMm: finite(0.1, 50),
    allowedLayers: z.array(z.enum(["F.Cu", "B.Cu"])).min(1).max(2),
  }).strict()).min(1).max(32),
  placementConstraints: z.array(z.object({
    reference: componentReference,
    side: z.literal("front"),
    regionMm: z.object({ minXmm: finite(0, 500), maxXmm: finite(0, 500), minYmm: finite(0, 500), maxYmm: finite(0, 500) }).strict(),
    allowedRotationsDeg: z.array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).min(1).max(4),
    minimumEdgeClearanceMm: finite(0, 50),
    minimumCourtyardClearanceMm: finite(0, 10),
    edgePreference: z.enum(["none", "top", "right", "bottom", "left"]),
  }).strict()).min(1).max(64),
  routingConstraints: z.object({
    cornerStyle: z.literal("miter_45"),
    maximumTurnAngleDeg: finite(0.1, 45),
    minimumStraightBeforeTurnMm: finite(0, 100),
    allowRightAngleCorners: z.literal(false),
    allowAcuteInteriorCorners: z.literal(false),
    allowBacktracking: z.literal(false),
    allowSelfIntersections: z.literal(false),
    viaPolicy,
    nets: z.array(z.object({
      net: netName,
      topology: z.enum(["point_to_point", "tree"]),
      preferredLayer: z.enum(["F.Cu", "B.Cu", "either"]),
      maxVias: integer(0, 32),
      routeLength,
    }).strict()).min(1).max(128),
  }).strict(),
  identity,
}).strict();

export type FluxDesignContractProjection = z.infer<typeof fluxDesignContractSchema>;

/** Fail-closed semantic projection used only after the public contract crosses the browser boundary. */
export const parseFluxDesignContract = (value: unknown): FluxDesignContractProjection | undefined => {
  const parsed = fluxDesignContractSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
