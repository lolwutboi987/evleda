import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { z } from "zod";

/**
 * Boundary contract between an untrusted design-planning model and later,
 * separately-authorized KiCad mutation stages.  V1 is deliberately small:
 * one schematic sheet, single-unit symbols, and a rectangular two-layer PCB.
 */
export const PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION = "evleda.pcb-design-intent-draft.v1" as const;
export const PCB_DESIGN_CONTRACT_SCHEMA_VERSION = "evleda.pcb-design-contract.v1" as const;
export const PCB_DESIGN_CANONICALIZATION_VERSION = "evleda-c14n-json-v1" as const;
export const PCB_DESIGN_SEMANTIC_POINTER_VERSION = "evleda-semantic-pointer-v1" as const;

export const PCB_DESIGN_CONTRACT_LIMITS = Object.freeze({
  maxPayloadBytes: 256 * 1024,
  maxSnapshotDepth: 32,
  maxSnapshotNodes: 100_000,
  maxSnapshotArrayLength: 1_024,
  maxSnapshotObjectKeys: 1_024,
  maxComponents: 64,
  maxPinsPerComponent: 128,
  maxNets: 128,
  minimumEndpointsPerNet: 2,
  pointToPointEndpointCount: 2,
  maxEndpointsPerNet: 256,
  maxNetClasses: 32,
  maxUnresolvedItems: 128,
  maxNetNameChars: 64,
  maxUnresolvedPathChars: 256,
  maxNormalizedPathChars: 512,
  maxFormattedIssues: 12
});

export type PcbDesignContractErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_DRAFT"
  | "UNRESOLVED_DRAFT"
  | "INVALID_CONTRACT"
  | "NON_CANONICAL_CONTRACT"
  | "CONTRACT_IDENTITY_MISMATCH";

export class PcbDesignContractError extends Error {
  public constructor(
    public readonly code: PcbDesignContractErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PcbDesignContractError";
  }
}

const cleanString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, "Must not have leading or trailing whitespace")
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must not contain control characters");

const identifier = cleanString(64).regex(/^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/u);
const reservedNetNames = new Set(["__proto__", "constructor", "prototype", "~no-connect", "~unnamed"]);
const netNameSchema = cleanString(PCB_DESIGN_CONTRACT_LIMITS.maxNetNameChars)
  .regex(
    /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u,
    "Must be a safe PCB net name without protocol delimiters"
  )
  .refine((value) => /[A-Za-z0-9]/u.test(value), "Must contain at least one letter or digit")
  .refine(
    (value) => !reservedNetNames.has(value.toLowerCase()) && !/^unconnected-\(/iu.test(value),
    "Must not use a reserved connectivity-protocol net name"
  );
const componentReference = cleanString(32).regex(/^[A-Z][A-Z0-9_-]{0,31}$/u);
const pinNumber = cleanString(32).regex(/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u);
const libraryIdentifier = cleanString(192).regex(/^[^\s:]+:[^\s:]+$/u);
const rejectNegativeZero = <Schema extends z.ZodType<number>>(schema: Schema) =>
  schema.refine((value) => !Object.is(value, -0), "Must not be negative zero");
const boundedNumber = (minimum: number, maximum: number) =>
  rejectNegativeZero(z.number().finite().min(minimum).max(maximum));
const boundedInteger = (minimum: number, maximum: number) =>
  rejectNegativeZero(z.number().int().min(minimum).max(maximum));
const zeroLiteral = rejectNegativeZero(z.literal(0));
const millimetres = boundedNumber(0, 500);
const semanticPointerPattern = /^\/(?:[^~\/\u0000-\u001f\u007f]|~[01])+(?:\/(?:[^~\/\u0000-\u001f\u007f]|~[01])+)*$/u;
const stablePathPattern = /^(?:\$|(?:[A-Za-z0-9_-]|%[0-9A-F]{4})+(?:\.(?:[A-Za-z0-9_-]|%[0-9A-F]{4})+)*)$/u;
const isCanonicalStablePathText = (value: string): boolean => {
  if (!stablePathPattern.test(value)) return false;
  if (value === "$") return true;
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (character === "." || /[A-Za-z0-9_-]/u.test(character)) {
      index += 1;
      continue;
    }
    const code = Number.parseInt(value.slice(index + 1, index + 5), 16);
    const decoded = String.fromCharCode(code);
    if (/[A-Za-z0-9_-]/u.test(decoded) || code <= 0x1f || code === 0x7f) return false;
    index += 5;
  }
  return true;
};

/** Encode one semantic-path token without delimiter or percent ambiguities. */
export const encodePcbDesignPathToken = (value: string): string => {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    encoded += /[A-Za-z0-9_-]/u.test(character)
      ? character
      : `%${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
};

/** Runtime/schema definition shared by compilation questions and answer IDs. */
export const pcbDesignStablePathSchema = z.string()
  .max(PCB_DESIGN_CONTRACT_LIMITS.maxNormalizedPathChars)
  .regex(stablePathPattern, `Must use ${PCB_DESIGN_SEMANTIC_POINTER_VERSION} normalized path syntax`)
  .refine(isCanonicalStablePathText, "Path escapes must be uppercase, necessary, and non-control UTF-16 escapes");

export const isPcbDesignStablePath = (value: unknown): value is string =>
  pcbDesignStablePathSchema.safeParse(value).success;

const copperLayerSchema = z.enum(["F.Cu", "B.Cu"]);
const copperLayersSchema = z.array(copperLayerSchema).length(2);
const allowedLayersSchema = z.array(copperLayerSchema).min(1).max(2);
const rotationSchema = z.union([zeroLiteral, z.literal(90), z.literal(180), z.literal(270)]);
const netRoleSchema = z.enum([
  "ground",
  "power_input",
  "power_output",
  "power",
  "analog",
  "digital",
  "clock",
  "control",
  "interface",
  "passive"
]);

const scopeClosedSchema = z
  .object({
    sheetCount: z.literal(1),
    componentUnitPolicy: z.literal("single_unit"),
    board: z
      .object({
        shape: z.literal("rectangle"),
        widthMm: boundedNumber(5, 500),
        heightMm: boundedNumber(5, 500),
        layerCount: z.literal(2),
        copperLayers: copperLayersSchema
      })
      .strict()
  })
  .strict();

const scopeDraftSchema = z
  .object({
    sheetCount: z.literal(1),
    componentUnitPolicy: z.literal("single_unit"),
    board: z
      .object({
        shape: z.literal("rectangle"),
        widthMm: boundedNumber(5, 500).nullable(),
        heightMm: boundedNumber(5, 500).nullable(),
        layerCount: z.literal(2),
        copperLayers: copperLayersSchema
      })
      .strict()
  })
  .strict();

const endpointSchema = z
  .object({ reference: componentReference, pin: pinNumber })
  .strict();

const connectedPinAssignmentSchema = z
  .object({ kind: z.literal("net"), net: netNameSchema })
  .strict();
const noConnectPinAssignmentSchema = z.object({ kind: z.literal("no_connect") }).strict();
const unresolvedPinAssignmentSchema = z
  .object({ kind: z.literal("unresolved"), question: cleanString(512) })
  .strict();
const closedPinAssignmentSchema = z.discriminatedUnion("kind", [
  connectedPinAssignmentSchema,
  noConnectPinAssignmentSchema
]);
const draftPinAssignmentSchema = z.discriminatedUnion("kind", [
  connectedPinAssignmentSchema,
  noConnectPinAssignmentSchema,
  unresolvedPinAssignmentSchema
]);

const closedComponentSchema = z
  .object({
    reference: componentReference,
    symbolLibId: libraryIdentifier,
    value: cleanString(192),
    footprintLibId: libraryIdentifier,
    unit: z.literal(1),
    pins: z
      .array(z.object({ pin: pinNumber, assignment: closedPinAssignmentSchema }).strict())
      .min(1)
      .max(PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent)
  })
  .strict();

const draftComponentSchema = z
  .object({
    reference: componentReference,
    symbolLibId: libraryIdentifier.nullable(),
    value: cleanString(192).nullable(),
    footprintLibId: libraryIdentifier.nullable(),
    unit: z.literal(1),
    pins: z
      .array(z.object({ pin: pinNumber, assignment: draftPinAssignmentSchema }).strict())
      .min(1)
      .max(PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent)
  })
  .strict();

const voltageSchema = z
  .object({
    minimumV: boundedNumber(-500, 500),
    nominalV: boundedNumber(-500, 500),
    maximumV: boundedNumber(-500, 500)
  })
  .strict();

const currentSchema = z
  .object({
    nominalA: boundedNumber(0, 100),
    maximumContinuousA: boundedNumber(0, 100),
    peakA: boundedNumber(0, 200),
    peakDurationMs: boundedNumber(0.001, 86_400_000)
  })
  .strict();

const dcSpeedSchema = z
  .object({
    kind: z.literal("dc"),
    maximumFrequencyMHz: zeroLiteral,
    minimumEdgeTimeNs: z.null()
  })
  .strict();
const signalSpeedSchema = z
  .object({
    kind: z.literal("signal"),
    maximumFrequencyMHz: boundedNumber(0.000_001, 100_000),
    minimumEdgeTimeNs: boundedNumber(0.001, 1_000_000_000)
  })
  .strict();
const speedSchema = z.discriminatedUnion("kind", [dcSpeedSchema, signalSpeedSchema]);

const electricalSchema = z
  .object({ voltage: voltageSchema, current: currentSchema, speed: speedSchema })
  .strict();

const closedNetSchema = z
  .object({
    name: netNameSchema,
    role: netRoleSchema,
    endpoints: z.array(endpointSchema)
      .min(PCB_DESIGN_CONTRACT_LIMITS.minimumEndpointsPerNet)
      .max(PCB_DESIGN_CONTRACT_LIMITS.maxEndpointsPerNet),
    electrical: electricalSchema,
    netClassId: identifier
  })
  .strict();

const draftNetSchema = z
  .object({
    name: netNameSchema,
    role: netRoleSchema.nullable(),
    endpoints: z.array(endpointSchema).max(PCB_DESIGN_CONTRACT_LIMITS.maxEndpointsPerNet),
    electrical: electricalSchema.nullable(),
    netClassId: identifier.nullable()
  })
  .strict();

const closedNetClassSchema = z
  .object({
    id: identifier,
    traceWidthMm: boundedNumber(0.05, 20),
    clearanceMm: boundedNumber(0.05, 10),
    copperToEdgeMm: boundedNumber(0.1, 50),
    allowedLayers: allowedLayersSchema
  })
  .strict();

const draftNetClassSchema = z
  .object({
    id: identifier,
    traceWidthMm: boundedNumber(0.05, 20).nullable(),
    clearanceMm: boundedNumber(0.05, 10).nullable(),
    copperToEdgeMm: boundedNumber(0.1, 50).nullable(),
    allowedLayers: allowedLayersSchema.nullable()
  })
  .strict();

const regionSchema = z
  .object({ minXmm: millimetres, maxXmm: millimetres, minYmm: millimetres, maxYmm: millimetres })
  .strict();
const edgePreferenceSchema = z.enum(["none", "top", "right", "bottom", "left"]);

const closedPlacementConstraintSchema = z
  .object({
    reference: componentReference,
    // V1 physical verification consumes only F.CrtYd/F.Fab geometry.  Drafts
    // retain a requested back side so the compiler can report it as an
    // explicit unsupported feature, but a closed V1 contract is front-only.
    side: z.literal("front"),
    regionMm: regionSchema,
    allowedRotationsDeg: z.array(rotationSchema).min(1).max(4),
    minimumEdgeClearanceMm: boundedNumber(0, 50),
    minimumCourtyardClearanceMm: boundedNumber(0, 10),
    edgePreference: edgePreferenceSchema
  })
  .strict();

const draftPlacementConstraintSchema = z
  .object({
    reference: componentReference,
    side: z.enum(["front", "back"]).nullable(),
    regionMm: regionSchema.nullable(),
    allowedRotationsDeg: z.array(rotationSchema).min(1).max(4).nullable(),
    minimumEdgeClearanceMm: boundedNumber(0, 50).nullable(),
    minimumCourtyardClearanceMm: boundedNumber(0, 10).nullable(),
    edgePreference: edgePreferenceSchema.nullable()
  })
  .strict();

const forbiddenViaPolicySchema = z.object({ mode: z.literal("forbidden"), maxTotal: zeroLiteral }).strict();
const boundedViaPolicySchema = z
  .object({
    mode: z.literal("bounded"),
    maxTotal: boundedInteger(1, 256),
    diameterMm: boundedNumber(0.2, 3),
    drillMm: boundedNumber(0.1, 2),
    minimumAnnularRingMm: boundedNumber(0.05, 1)
  })
  .strict();
const viaPolicySchema = z.discriminatedUnion("mode", [forbiddenViaPolicySchema, boundedViaPolicySchema]);
const routeLengthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unbounded") }).strict(),
  z.object({ mode: z.literal("bounded"), maximumMm: boundedNumber(0.1, 5_000) }).strict()
]);

const closedNetRoutingConstraintSchema = z
  .object({
    net: netNameSchema,
    topology: z.enum(["point_to_point", "tree"]),
    preferredLayer: z.enum(["F.Cu", "B.Cu", "either"]),
    maxVias: boundedInteger(0, 32),
    routeLength: routeLengthSchema
  })
  .strict();

const draftNetRoutingConstraintSchema = z
  .object({
    net: netNameSchema,
    topology: z.enum(["point_to_point", "tree"]).nullable(),
    preferredLayer: z.enum(["F.Cu", "B.Cu", "either"]).nullable(),
    maxVias: boundedInteger(0, 32).nullable(),
    routeLength: routeLengthSchema.nullable()
  })
  .strict();

const closedRoutingConstraintsSchema = z
  .object({
    cornerStyle: z.literal("miter_45"),
    maximumTurnAngleDeg: boundedNumber(0.1, 45),
    minimumStraightBeforeTurnMm: boundedNumber(0, 100),
    allowRightAngleCorners: z.literal(false),
    allowAcuteInteriorCorners: z.literal(false),
    allowBacktracking: z.literal(false),
    allowSelfIntersections: z.literal(false),
    viaPolicy: viaPolicySchema,
    nets: z.array(closedNetRoutingConstraintSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNets)
  })
  .strict();

const draftRoutingConstraintsSchema = z
  .object({
    cornerStyle: z.literal("miter_45").nullable(),
    maximumTurnAngleDeg: boundedNumber(0.1, 45).nullable(),
    minimumStraightBeforeTurnMm: boundedNumber(0, 100).nullable(),
    allowRightAngleCorners: z.literal(false).nullable(),
    allowAcuteInteriorCorners: z.literal(false).nullable(),
    allowBacktracking: z.literal(false).nullable(),
    allowSelfIntersections: z.literal(false).nullable(),
    viaPolicy: viaPolicySchema.nullable(),
    nets: z.array(draftNetRoutingConstraintSchema).max(PCB_DESIGN_CONTRACT_LIMITS.maxNets)
  })
  .strict();

const unresolvedItemSchema = z
  .object({
    path: cleanString(PCB_DESIGN_CONTRACT_LIMITS.maxUnresolvedPathChars).regex(
      semanticPointerPattern,
      `Must use ${PCB_DESIGN_SEMANTIC_POINTER_VERSION} syntax with only ~0 and ~1 escapes`
    ),
    question: cleanString(512)
  })
  .strict();

const draftBaseSchema = z
  .object({
    schemaVersion: z.literal(PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION),
    kind: z.literal("pcb_design_intent_draft"),
    scope: scopeDraftSchema,
    components: z.array(draftComponentSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
    nets: z.array(draftNetSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNets),
    netClasses: z.array(draftNetClassSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses),
    placementConstraints: z.array(draftPlacementConstraintSchema).max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
    routingConstraints: draftRoutingConstraintsSchema,
    unresolved: z.array(unresolvedItemSchema).max(PCB_DESIGN_CONTRACT_LIMITS.maxUnresolvedItems)
  })
  .strict();

const contractPayloadBaseSchema = z
  .object({
    schemaVersion: z.literal(PCB_DESIGN_CONTRACT_SCHEMA_VERSION),
    kind: z.literal("pcb_design_contract"),
    scope: scopeClosedSchema,
    components: z.array(closedComponentSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
    nets: z.array(closedNetSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNets),
    netClasses: z.array(closedNetClassSchema).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses),
    placementConstraints: z
      .array(closedPlacementConstraintSchema)
      .min(1)
      .max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
    routingConstraints: closedRoutingConstraintsSchema
  })
  .strict();

type DraftMutable = z.infer<typeof draftBaseSchema>;
type ContractPayloadMutable = z.infer<typeof contractPayloadBaseSchema>;
type ContractMutable = ContractPayloadMutable & { identity: CanonicalIdentity };

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type PcbDesignIntentDraft = DeepReadonly<DraftMutable>;
export type PcbDesignContractPayload = DeepReadonly<ContractPayloadMutable>;
export type PcbDesignContract = DeepReadonly<ContractMutable>;

export type PcbDesignSemanticPathResult =
  | { readonly success: true; readonly path: string }
  | { readonly success: false; readonly reason: "syntax" | "unresolved" | "ambiguous" | "too_long" };

const decodeSemanticPointer = (pointer: string): readonly string[] | null => {
  if (!semanticPointerPattern.test(pointer)) return null;
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
};

const ownData = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const keyedEntry = (
  value: unknown,
  key: string,
  selector: string
): { readonly success: true; readonly value: unknown; readonly key: string } | { readonly success: false; readonly ambiguous: boolean } => {
  if (!Array.isArray(value)) return { success: false, ambiguous: false };
  const matches = value.filter((entry) => ownData(entry, key) === selector);
  if (matches.length !== 1) return { success: false, ambiguous: matches.length > 1 };
  return { success: true, value: matches[0], key: selector };
};

const normalizedPathResult = (tokens: readonly string[]): PcbDesignSemanticPathResult => {
  const path = tokens.map(encodePcbDesignPathToken).join(".");
  return path.length <= PCB_DESIGN_CONTRACT_LIMITS.maxNormalizedPathChars && stablePathPattern.test(path)
    ? { success: true, path }
    : { success: false, reason: "too_long" };
};

const resolveObjectTail = (
  cursor: unknown,
  pointerTokens: readonly string[],
  index: number,
  normalizedTokens: string[]
): PcbDesignSemanticPathResult => {
  let current = cursor;
  for (let tokenIndex = index; tokenIndex < pointerTokens.length; tokenIndex += 1) {
    const token = pointerTokens[tokenIndex]!;
    if (Array.isArray(current) || current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
      return { success: false, reason: "unresolved" };
    }
    normalizedTokens.push(token);
    current = (current as Record<string, unknown>)[token];
  }
  return normalizedPathResult(normalizedTokens);
};

/**
 * Resolve an EvlEDA semantic pointer against a parsed draft. Keyed collections
 * use their unique domain key, never a positional array index.
 */
const normalizePcbDesignUnresolvedPathUnchecked = (
  document: PcbDesignIntentDraft | DraftMutable,
  pointer: string
): PcbDesignSemanticPathResult => {
  const tokens = decodeSemanticPointer(pointer);
  if (tokens === null) return { success: false, reason: "syntax" };
  const root = tokens[0]!;

  if (root === "scope") {
    return resolveObjectTail(document.scope, tokens, 1, ["scope"]);
  }

  if (root === "components") {
    if (tokens.length === 1) return normalizedPathResult(["components"]);
    const component = keyedEntry(document.components, "reference", tokens[1]!);
    if (!component.success) return { success: false, reason: component.ambiguous ? "ambiguous" : "unresolved" };
    if (tokens.length === 2) return normalizedPathResult(["component", component.key]);
    const field = tokens[2]!;
    if (!Object.hasOwn(component.value as object, field)) return { success: false, reason: "unresolved" };
    if (field !== "pins") {
      return resolveObjectTail(ownData(component.value, field), tokens, 3, ["component", component.key, field]);
    }
    if (tokens.length === 3) return normalizedPathResult(["component", component.key, "pins"]);
    const pin = keyedEntry(ownData(component.value, "pins"), "pin", tokens[3]!);
    if (!pin.success) return { success: false, reason: pin.ambiguous ? "ambiguous" : "unresolved" };
    return resolveObjectTail(pin.value, tokens, 4, ["component", component.key, "pin", pin.key]);
  }

  if (root === "nets") {
    if (tokens.length === 1) return normalizedPathResult(["nets"]);
    const net = keyedEntry(document.nets, "name", tokens[1]!);
    if (!net.success) return { success: false, reason: net.ambiguous ? "ambiguous" : "unresolved" };
    if (tokens.length === 2) return normalizedPathResult(["net", net.key]);
    const field = tokens[2]!;
    if (!Object.hasOwn(net.value as object, field)) return { success: false, reason: "unresolved" };
    if (field !== "endpoints") {
      return resolveObjectTail(ownData(net.value, field), tokens, 3, ["net", net.key, field]);
    }
    if (tokens.length === 3) return normalizedPathResult(["net", net.key, "endpoints"]);
    if (tokens.length < 5) return { success: false, reason: "unresolved" };
    const endpoints = ownData(net.value, "endpoints");
    if (!Array.isArray(endpoints)) return { success: false, reason: "unresolved" };
    const matches = endpoints.filter((entry) =>
      ownData(entry, "reference") === tokens[3] && ownData(entry, "pin") === tokens[4]);
    if (matches.length !== 1) return { success: false, reason: matches.length > 1 ? "ambiguous" : "unresolved" };
    return resolveObjectTail(matches[0], tokens, 5, ["net", net.key, "endpoint", tokens[3]!, tokens[4]!]);
  }

  if (root === "netClasses") {
    if (tokens.length === 1) return normalizedPathResult(["netClasses"]);
    const netClass = keyedEntry(document.netClasses, "id", tokens[1]!);
    if (!netClass.success) return { success: false, reason: netClass.ambiguous ? "ambiguous" : "unresolved" };
    return resolveObjectTail(netClass.value, tokens, 2, ["netClass", netClass.key]);
  }

  if (root === "placementConstraints") {
    if (tokens.length === 1) return normalizedPathResult(["placementConstraints"]);
    const placement = keyedEntry(document.placementConstraints, "reference", tokens[1]!);
    if (!placement.success) return { success: false, reason: placement.ambiguous ? "ambiguous" : "unresolved" };
    return resolveObjectTail(placement.value, tokens, 2, ["placement", placement.key]);
  }

  if (root === "routingConstraints") {
    if (tokens.length === 1) return normalizedPathResult(["routing"]);
    if (tokens[1] !== "nets") {
      return resolveObjectTail(document.routingConstraints, tokens, 1, ["routing"]);
    }
    if (tokens.length === 2) return normalizedPathResult(["routing", "nets"]);
    const route = keyedEntry(document.routingConstraints.nets, "net", tokens[2]!);
    if (!route.success) return { success: false, reason: route.ambiguous ? "ambiguous" : "unresolved" };
    return resolveObjectTail(route.value, tokens, 3, ["route", route.key]);
  }

  if ((root === "schemaVersion" || root === "kind") && tokens.length === 1) {
    return normalizedPathResult([root]);
  }
  return { success: false, reason: "unresolved" };
};

export const normalizePcbDesignUnresolvedPath = (
  document: PcbDesignIntentDraft | DraftMutable,
  pointer: string
): PcbDesignSemanticPathResult => {
  try {
    return normalizePcbDesignUnresolvedPathUnchecked(document, pointer);
  } catch {
    return { success: false, reason: "unresolved" };
  }
};

interface IssueContext {
  addIssue(issue: { code: "custom"; message: string; path?: PropertyKey[] }): void;
}

const issue = (context: IssueContext, message: string, path?: PropertyKey[]): void => {
  context.addIssue(path === undefined ? { code: "custom", message } : { code: "custom", message, path });
};

const endpointKey = (reference: string, pin: string): string => `${reference}\u0000${pin}`;
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const compareEndpoints = (left: { reference: string; pin: string }, right: { reference: string; pin: string }): number =>
  compareText(left.reference, right.reference) || compareText(left.pin, right.pin);

const requireUnique = <Entry>(
  entries: readonly Entry[],
  keyOf: (entry: Entry) => string,
  label: string,
  context: IssueContext,
  path: PropertyKey[]
): Set<string> => {
  const keys = new Set<string>();
  entries.forEach((entry, index) => {
    const key = keyOf(entry);
    if (keys.has(key)) issue(context, `Duplicate ${label}: ${key}`, [...path, index]);
    keys.add(key);
  });
  return keys;
};

const validateScope = (
  scope: RelationshipDocument["scope"],
  context: IssueContext,
  allowFourLayers = false,
): void => {
  const layers = scope.board.copperLayers;
  if (allowFourLayers && scope.board.layerCount === 4) {
    if (new Set(layers).size !== 4 || !["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"].every(layer => layers.includes(layer as typeof layers[number]))) {
      issue(context, "Four-layer scope must contain F.Cu, In1.Cu, In2.Cu and B.Cu exactly once", ["scope", "board", "copperLayers"]);
    }
  } else if (scope.board.layerCount !== 2 || new Set(layers).size !== 2 || !layers.includes("F.Cu") || !layers.includes("B.Cu")) {
    issue(context, "Two-layer scope must contain F.Cu and B.Cu exactly once", ["scope", "board", "copperLayers"]);
  }
};

const validateElectrical = (
  nets: readonly { name: string; role: string | null; electrical: z.infer<typeof electricalSchema> | null }[],
  context: IssueContext
): void => {
  nets.forEach((net, index) => {
    if (net.electrical === null) return;
    const { voltage, current } = net.electrical;
    if (!(voltage.minimumV <= voltage.nominalV && voltage.nominalV <= voltage.maximumV)) {
      issue(context, `Net ${net.name} voltage must satisfy minimum <= nominal <= maximum`, ["nets", index, "electrical", "voltage"]);
    }
    if (!(current.nominalA <= current.maximumContinuousA && current.maximumContinuousA <= current.peakA)) {
      issue(context, `Net ${net.name} current must satisfy nominal <= continuous maximum <= peak`, ["nets", index, "electrical", "current"]);
    }
    if (net.role === "ground" && voltage.nominalV !== 0) {
      issue(context, `Ground net ${net.name} must have 0 V nominal voltage`, ["nets", index, "electrical", "voltage", "nominalV"]);
    }
  });
};

const validateRegion = (
  placement: {
    reference: string;
    regionMm: z.infer<typeof regionSchema> | null;
    minimumEdgeClearanceMm: number | null;
  },
  board: { widthMm: number | null; heightMm: number | null },
  index: number,
  context: IssueContext
): void => {
  const region = placement.regionMm;
  if (region === null) return;
  if (region.minXmm > region.maxXmm || region.minYmm > region.maxYmm) {
    issue(context, `Placement region for ${placement.reference} has inverted bounds`, ["placementConstraints", index, "regionMm"]);
  }
  if (board.widthMm !== null && region.maxXmm > board.widthMm) {
    issue(context, `Placement region for ${placement.reference} exceeds board width`, ["placementConstraints", index, "regionMm"]);
  }
  if (board.heightMm !== null && region.maxYmm > board.heightMm) {
    issue(context, `Placement region for ${placement.reference} exceeds board height`, ["placementConstraints", index, "regionMm"]);
  }
  const edge = placement.minimumEdgeClearanceMm;
  if (edge !== null && board.widthMm !== null && board.heightMm !== null &&
      (region.minXmm < edge || region.minYmm < edge || region.maxXmm > board.widthMm - edge || region.maxYmm > board.heightMm - edge)) {
    issue(context, `Placement region for ${placement.reference} violates its minimum edge clearance`, ["placementConstraints", index]);
  }
};

type RelationshipDocument = {
  readonly scope: {
    readonly sheetCount: 1;
    readonly componentUnitPolicy: "single_unit";
    readonly board: { readonly shape: "rectangle"; readonly widthMm: number | null; readonly heightMm: number | null;
      readonly layerCount: 2 | 4; readonly copperLayers: readonly ("F.Cu" | "In1.Cu" | "In2.Cu" | "B.Cu")[] };
  };
  readonly components: readonly {
    readonly reference: string;
    readonly pins: readonly { readonly pin: string; readonly assignment: z.infer<typeof draftPinAssignmentSchema> }[];
  }[];
  readonly nets: readonly {
    readonly name: string;
    readonly role: string | null;
    readonly endpoints: readonly z.infer<typeof endpointSchema>[];
    readonly electrical: z.infer<typeof electricalSchema> | null;
    readonly netClassId: string | null;
  }[];
  readonly netClasses: readonly {
    readonly id: string;
    readonly traceWidthMm: number | null;
    readonly clearanceMm: number | null;
    readonly copperToEdgeMm: number | null;
    readonly allowedLayers: readonly ("F.Cu" | "In1.Cu" | "In2.Cu" | "B.Cu")[] | null;
  }[];
  readonly placementConstraints: readonly {
    readonly reference: string;
    readonly regionMm: z.infer<typeof regionSchema> | null;
    readonly allowedRotationsDeg: readonly number[] | null;
    readonly minimumEdgeClearanceMm: number | null;
  }[];
  readonly routingConstraints: {
    readonly viaPolicy: z.infer<typeof viaPolicySchema> | null;
    readonly nets: readonly {
      readonly net: string;
      readonly topology: "point_to_point" | "tree" | null;
      readonly preferredLayer: "F.Cu" | "B.Cu" | "either" | null;
      readonly maxVias: number | null;
    }[];
  };
};

/** Shared electrical/library/placement relationships; contains no routing-topology projection. */
export const validatePcbDesignCommonRelationships = (
  document: Omit<RelationshipDocument, "routingConstraints">,
  context: IssueContext,
  closed: boolean,
  options: { readonly allowFourLayers?: boolean } = {},
): ReadonlySet<string> => {
  validateScope(document.scope, context, options.allowFourLayers);
  validateElectrical(document.nets, context);
  const componentRefs = requireUnique(document.components, (entry) => entry.reference, "component reference", context, ["components"]);
  const netNames = requireUnique(document.nets, (entry) => entry.name, "net name", context, ["nets"]);
  const classIds = requireUnique(document.netClasses, (entry) => entry.id, "net-class ID", context, ["netClasses"]);
  const pins = new Map<string, z.infer<typeof draftPinAssignmentSchema>>();

  document.components.forEach((component, componentIndex) => {
    requireUnique(component.pins, (entry) => entry.pin, `pin on ${component.reference}`, context, ["components", componentIndex, "pins"]);
    component.pins.forEach((pin) => {
      pins.set(endpointKey(component.reference, pin.pin), pin.assignment);
      if (pin.assignment.kind === "net" && !netNames.has(pin.assignment.net)) {
        issue(context, `Pin ${component.reference}.${pin.pin} references unknown net ${pin.assignment.net}`, ["components", componentIndex, "pins"]);
      }
    });
  });

  const endpointNets = new Map<string, Set<string>>();
  for (const net of document.nets) for (const endpoint of net.endpoints) {
    const key = endpointKey(endpoint.reference, endpoint.pin);
    const names = endpointNets.get(key) ?? new Set<string>();
    names.add(net.name);
    endpointNets.set(key, names);
  }
  document.nets.forEach((net, netIndex) => {
    requireUnique(net.endpoints, (entry) => endpointKey(entry.reference, entry.pin), `endpoint on net ${net.name}`, context, ["nets", netIndex, "endpoints"]);
    if (net.netClassId !== null && !classIds.has(net.netClassId)) {
      issue(context, `Net ${net.name} references unknown net class ${net.netClassId}`, ["nets", netIndex, "netClassId"]);
    }
    net.endpoints.forEach((endpoint, endpointIndex) => {
      const key = endpointKey(endpoint.reference, endpoint.pin);
      if (!componentRefs.has(endpoint.reference) || !pins.has(key)) {
        issue(context, `Net ${net.name} references unknown endpoint ${endpoint.reference}.${endpoint.pin}`, ["nets", netIndex, "endpoints", endpointIndex]);
        return;
      }
      const names = endpointNets.get(key)!;
      if (names.size > 1) {
        issue(
          context,
          `Endpoint ${endpoint.reference}.${endpoint.pin} occurs on multiple nets: ${[...names].sort(compareText).join(", ")}`,
          ["nets", netIndex, "endpoints", endpointIndex]
        );
      }
      const assignment = pins.get(key)!;
      if (
        assignment.kind === "no_connect" ||
        assignment.kind === "unresolved" ||
        (assignment.kind === "net" && assignment.net !== net.name)
      ) {
        issue(context, `Endpoint ${endpoint.reference}.${endpoint.pin} is asymmetric with its pin assignment`, ["nets", netIndex, "endpoints", endpointIndex]);
      }
    });
  });

  document.components.forEach((component, componentIndex) => component.pins.forEach((pin, pinIndex) => {
    const actualNets = endpointNets.get(endpointKey(component.reference, pin.pin)) ?? new Set<string>();
    if (pin.assignment.kind === "net" && !actualNets.has(pin.assignment.net)) {
      issue(context, `Pin ${component.reference}.${pin.pin} assignment is missing from net ${pin.assignment.net}`, ["components", componentIndex, "pins", pinIndex]);
    }
    if (pin.assignment.kind === "no_connect" && actualNets.size > 0) {
      issue(
        context,
        `No-connect pin ${component.reference}.${pin.pin} occurs on net(s) ${[...actualNets].sort(compareText).join(", ")}`,
        ["components", componentIndex, "pins", pinIndex]
      );
    }
    if (closed && pin.assignment.kind === "unresolved") {
      issue(context, `Closed contract contains unresolved pin ${component.reference}.${pin.pin}`, ["components", componentIndex, "pins", pinIndex]);
    }
  }));

  document.netClasses.forEach((netClass, index) => {
    if (netClass.allowedLayers !== null && new Set(netClass.allowedLayers).size !== netClass.allowedLayers.length) {
      issue(context, `Net class ${netClass.id} repeats an allowed layer`, ["netClasses", index, "allowedLayers"]);
    }
    if (netClass.allowedLayers?.some(layer => !document.scope.board.copperLayers.includes(layer))) {
      issue(context, `Net class ${netClass.id} permits a disabled copper layer`, ["netClasses", index, "allowedLayers"]);
    }
  });
  if (closed) {
    const usedClassIds = new Set(document.nets.map((net) => net.netClassId));
    document.netClasses.forEach((netClass, index) => {
      if (!usedClassIds.has(netClass.id)) issue(context, `Net class ${netClass.id} is unused`, ["netClasses", index]);
    });
  }

  const placements = requireUnique(document.placementConstraints, (entry) => entry.reference, "placement reference", context, ["placementConstraints"]);
  document.placementConstraints.forEach((placement, index) => {
    if (!componentRefs.has(placement.reference)) issue(context, `Placement references unknown component ${placement.reference}`, ["placementConstraints", index, "reference"]);
    if (placement.allowedRotationsDeg !== null && new Set(placement.allowedRotationsDeg).size !== placement.allowedRotationsDeg.length) {
      issue(context, `Placement for ${placement.reference} repeats a rotation`, ["placementConstraints", index, "allowedRotationsDeg"]);
    }
    validateRegion(placement, document.scope.board, index, context);
  });
  if (closed) {
    for (const reference of componentRefs) if (!placements.has(reference)) issue(context, `Component ${reference} is missing a placement constraint`, ["placementConstraints"]);
  }

  return netNames;
};

const validateRelationships = (document: RelationshipDocument, context: IssueContext, closed: boolean): void => {
  const netNames = validatePcbDesignCommonRelationships(document, context, closed);
  const routeNets = requireUnique(document.routingConstraints.nets, (entry) => entry.net, "routing-net constraint", context, ["routingConstraints", "nets"]);
  const classById = new Map(document.netClasses.map((entry) => [entry.id, entry]));
  const netByName = new Map(document.nets.map((entry) => [entry.name, entry]));
  document.routingConstraints.nets.forEach((route, index) => {
    const net = netByName.get(route.net);
    if (net === undefined) {
      issue(context, `Routing constraint references unknown net ${route.net}`, ["routingConstraints", "nets", index, "net"]);
      return;
    }
    if (closed && route.topology === "point_to_point" &&
        net.endpoints.length !== PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount) {
      issue(
        context,
        `Point-to-point net ${route.net} must have exactly ${PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount} endpoints`,
        ["routingConstraints", "nets", index, "topology"]
      );
    }
    const viaPolicy = document.routingConstraints.viaPolicy;
    if (viaPolicy?.mode === "forbidden" && route.maxVias !== null && route.maxVias !== 0) {
      issue(context, `Net ${route.net} permits vias while the global policy forbids them`, ["routingConstraints", "nets", index, "maxVias"]);
    }
    if (viaPolicy?.mode === "bounded" && route.maxVias !== null && route.maxVias > viaPolicy.maxTotal) {
      issue(context, `Net ${route.net} exceeds the global via bound`, ["routingConstraints", "nets", index, "maxVias"]);
    }
    if (net.netClassId === null || route.preferredLayer === null) return;
    const netClass = classById.get(net.netClassId);
    if (netClass?.allowedLayers === null || netClass === undefined) return;
    if (route.preferredLayer === "either" && netClass.allowedLayers.length !== 2) {
      issue(context, `Net ${route.net} cannot prefer either layer because its class does not allow both`, ["routingConstraints", "nets", index, "preferredLayer"]);
    }
    if (route.preferredLayer !== "either" && !netClass.allowedLayers.includes(route.preferredLayer)) {
      issue(context, `Net ${route.net} prefers a layer forbidden by class ${netClass.id}`, ["routingConstraints", "nets", index, "preferredLayer"]);
    }
    if (netClass.allowedLayers.length === 1 && route.maxVias !== null && route.maxVias !== 0) {
      issue(context, `Single-layer net ${route.net} cannot permit vias`, ["routingConstraints", "nets", index, "maxVias"]);
    }
  });
  if (closed) for (const name of netNames) if (!routeNets.has(name)) issue(context, `Net ${name} is missing a routing constraint`, ["routingConstraints", "nets"]);

  const via = document.routingConstraints.viaPolicy;
  if (via?.mode === "bounded") {
    const declaredPerNetMaximum = document.routingConstraints.nets.reduce(
      (total, route) => total + (route.maxVias ?? 0),
      0
    );
    if (declaredPerNetMaximum > via.maxTotal) {
      issue(
        context,
        `Sum of per-net via maxima (${declaredPerNetMaximum}) exceeds global maxTotal (${via.maxTotal})`,
        ["routingConstraints", "viaPolicy", "maxTotal"]
      );
    }
  }
  if (via?.mode === "bounded" && via.drillMm + 2 * via.minimumAnnularRingMm > via.diameterMm + Number.EPSILON) {
    issue(context, "Bounded via diameter cannot provide the declared minimum annular ring", ["routingConstraints", "viaPolicy"]);
  }
};

export const pcbDesignIntentDraftSchema = draftBaseSchema.superRefine((draft, context) => {
  validateRelationships(draft, context, false);
  requireUnique(draft.unresolved, (entry) => entry.path, "unresolved path", context, ["unresolved"]);
  const normalizedPaths = new Map<string, string>();
  draft.unresolved.forEach((entry, index) => {
    const normalized = normalizePcbDesignUnresolvedPath(draft, entry.path);
    if (!normalized.success) {
      const message = normalized.reason === "too_long"
        ? `Normalized unresolved path exceeds ${PCB_DESIGN_CONTRACT_LIMITS.maxNormalizedPathChars} characters`
        : normalized.reason === "ambiguous"
          ? "Unresolved path selects an ambiguous keyed collection entry"
          : `Unresolved path does not resolve under ${PCB_DESIGN_SEMANTIC_POINTER_VERSION}`;
      issue(context, message, ["unresolved", index, "path"]);
      return;
    }
    const previous = normalizedPaths.get(normalized.path);
    if (previous !== undefined && previous !== entry.path) {
      issue(context, `Unresolved paths collide after ${PCB_DESIGN_SEMANTIC_POINTER_VERSION} normalization`, ["unresolved", index, "path"]);
      return;
    }
    normalizedPaths.set(normalized.path, entry.path);
  });
});

export const pcbDesignContractPayloadSchema = contractPayloadBaseSchema.superRefine((contract, context) => {
  validateRelationships(contract, context, true);
});

const canonicalIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    schemaVersion: z.literal(PCB_DESIGN_CONTRACT_SCHEMA_VERSION),
    canonicalizationVersion: z.literal(PCB_DESIGN_CANONICALIZATION_VERSION)
  })
  .strict();

const cloneAssignment = <Assignment extends z.infer<typeof draftPinAssignmentSchema>>(assignment: Assignment): Assignment =>
  structuredClone(assignment);

const canonicalizeDraft = (draft: DraftMutable): DraftMutable => ({
  ...structuredClone(draft),
  scope: {
    ...structuredClone(draft.scope),
    board: { ...structuredClone(draft.scope.board), copperLayers: ["F.Cu", "B.Cu"] }
  },
  components: draft.components
    .map((component) => ({
      ...structuredClone(component),
      pins: component.pins
        .map((pin) => ({ pin: pin.pin, assignment: cloneAssignment(pin.assignment) }))
        .sort((left, right) => compareText(left.pin, right.pin))
    }))
    .sort((left, right) => compareText(left.reference, right.reference)),
  nets: draft.nets
    .map((net) => ({ ...structuredClone(net), endpoints: [...net.endpoints].map((entry) => ({ ...entry })).sort(compareEndpoints) }))
    .sort((left, right) => compareText(left.name, right.name)),
  netClasses: draft.netClasses
    .map((netClass) => ({
      ...structuredClone(netClass),
      allowedLayers: netClass.allowedLayers === null
        ? null
        : [...netClass.allowedLayers].sort((left, right) => (left === right ? 0 : left === "F.Cu" ? -1 : 1))
    }))
    .sort((left, right) => compareText(left.id, right.id)),
  placementConstraints: draft.placementConstraints
    .map((placement) => ({
      ...structuredClone(placement),
      allowedRotationsDeg: placement.allowedRotationsDeg === null ? null : [...placement.allowedRotationsDeg].sort((left, right) => left - right)
    }))
    .sort((left, right) => compareText(left.reference, right.reference)),
  routingConstraints: {
    ...structuredClone(draft.routingConstraints),
    nets: [...draft.routingConstraints.nets].map((entry) => structuredClone(entry)).sort((left, right) => compareText(left.net, right.net))
  },
  unresolved: [...draft.unresolved]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.question, right.question))
});

const canonicalizePayload = (payload: ContractPayloadMutable): ContractPayloadMutable => ({
  ...structuredClone(payload),
  scope: {
    ...structuredClone(payload.scope),
    board: { ...structuredClone(payload.scope.board), copperLayers: ["F.Cu", "B.Cu"] }
  },
  components: payload.components
    .map((component) => ({
      ...structuredClone(component),
      pins: component.pins
        .map((pin) => ({ pin: pin.pin, assignment: structuredClone(pin.assignment) }))
        .sort((left, right) => compareText(left.pin, right.pin))
    }))
    .sort((left, right) => compareText(left.reference, right.reference)),
  nets: payload.nets
    .map((net) => ({ ...structuredClone(net), endpoints: [...net.endpoints].map((entry) => ({ ...entry })).sort(compareEndpoints) }))
    .sort((left, right) => compareText(left.name, right.name)),
  netClasses: payload.netClasses
    .map((netClass) => ({
      ...structuredClone(netClass),
      allowedLayers: [...netClass.allowedLayers].sort((left, right) => (left === right ? 0 : left === "F.Cu" ? -1 : 1))
    }))
    .sort((left, right) => compareText(left.id, right.id)),
  placementConstraints: payload.placementConstraints
    .map((placement) => ({
      ...structuredClone(placement),
      allowedRotationsDeg: [...placement.allowedRotationsDeg].sort((left, right) => left - right)
    }))
    .sort((left, right) => compareText(left.reference, right.reference)),
  routingConstraints: {
    ...structuredClone(payload.routingConstraints),
    nets: [...payload.routingConstraints.nets].map((entry) => structuredClone(entry)).sort((left, right) => compareText(left.net, right.net))
  }
});

const payloadFromContract = (contract: ContractMutable): ContractPayloadMutable => {
  const { identity: _identity, ...payload } = contract;
  return payload;
};

const canonicalOrderIssueMessage = "Closed PCB design contract is not in canonical array order";
const identityIssueMessage = "Closed PCB design contract identity does not reproduce";

export const pcbDesignContractSchema = z
  .object({ ...contractPayloadBaseSchema.shape, identity: canonicalIdentitySchema })
  .strict()
  .superRefine((contract, context) => {
    validateRelationships(contract, context, true);
    const payload = payloadFromContract(contract);
    const canonicalPayload = canonicalizePayload(payload);
    if (canonicalJson(payload) !== canonicalJson(canonicalPayload)) {
      issue(context, canonicalOrderIssueMessage);
    }
    const expected = canonicalIdentity(canonicalPayload, PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
    if (canonicalJson(contract.identity) !== canonicalJson(expected)) {
      issue(context, identityIssueMessage, ["identity"]);
    }
  });

export type PcbDesignJsonSnapshotFailure =
  | "bytes"
  | "depth"
  | "nodes"
  | "array_length"
  | "object_keys"
  | "invalid_json";

export class PcbDesignJsonSnapshotError extends Error {
  public constructor(
    public readonly reason: "too_large" | "invalid",
    public readonly failure: PcbDesignJsonSnapshotFailure
  ) {
    super("PCB design JSON snapshot failed");
    this.name = "PcbDesignJsonSnapshotError";
  }
}

export interface PcbDesignJsonSnapshotPolicy {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly rejectAliases: boolean;
  readonly checkpoint?: () => void;
}

export interface PcbDesignJsonSnapshot {
  readonly value: unknown;
  readonly bytes: number;
}

/**
 * Capture one descriptor-backed view of untrusted JSON-shaped data. Accessors,
 * hidden properties, custom prototypes, sparse arrays, symbols, and toJSON
 * functions are rejected without being invoked. The returned graph contains
 * only newly allocated arrays, null-prototype records, and JSON scalars.
 */
export const snapshotPcbDesignJson = (
  source: unknown,
  policy: PcbDesignJsonSnapshotPolicy
): PcbDesignJsonSnapshot => {
  const ancestors = new Set<object>();
  const seen = new Set<object>();
  const localFailures = new Set<unknown>();
  const checkpointFailures = new Set<unknown>();
  let nodes = 0;
  let bytes = 0;

  const fail = (
    reason: "too_large" | "invalid",
    failure: PcbDesignJsonSnapshotFailure
  ): never => {
    const error = new PcbDesignJsonSnapshotError(reason, failure);
    localFailures.add(error);
    throw error;
  };
  const checkpoint = (): void => {
    if (policy.checkpoint === undefined) return;
    try {
      policy.checkpoint();
    } catch (error) {
      checkpointFailures.add(error);
      throw error;
    }
  };
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > policy.maxBytes) fail("too_large", "bytes");
  };
  const scalarBytes = (value: string | number): number => {
    const rawBytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 1;
    if (rawBytes > policy.maxBytes) fail("too_large", "bytes");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("invalid", "invalid_json");
    return Buffer.byteLength(serialized, "utf8");
  };

  const capture = (value: unknown, depth: number): unknown => {
    checkpoint();
    nodes += 1;
    if (nodes > policy.maxNodes) fail("too_large", "nodes");
    if (depth > policy.maxDepth) fail("invalid", "depth");
    if (value === null) {
      addBytes(4);
      return null;
    }
    if (typeof value === "boolean") {
      addBytes(value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      addBytes(scalarBytes(value));
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("invalid", "invalid_json");
      addBytes(scalarBytes(value));
      return value;
    }
    if (typeof value !== "object") return fail("invalid", "invalid_json");
    const objectValue: object = value;
    if (ancestors.has(objectValue)) fail("invalid", "invalid_json");
    if (policy.rejectAliases && seen.has(objectValue)) fail("invalid", "invalid_json");
    seen.add(objectValue);
    ancestors.add(objectValue);
    try {
      if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        const descriptors = new Map<PropertyKey, PropertyDescriptor>();
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) return fail("invalid", "invalid_json");
          descriptors.set(key, descriptor);
        }
        const lengthDescriptor = descriptors.get("length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
          return fail("invalid", "invalid_json");
        }
        const length = lengthDescriptor.value as number;
        if (length > policy.maxArrayLength) fail("too_large", "array_length");
        if (keys.length !== length + 1) fail("invalid", "invalid_json");
        addBytes(2 + Math.max(0, length - 1));
        const clone: unknown[] = new Array(length);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors.get(String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            return fail("invalid", "invalid_json");
          }
          clone[index] = capture(descriptor.value, depth + 1);
        }
        return clone;
      }

      const prototype = Object.getPrototypeOf(objectValue);
      if (prototype !== Object.prototype && prototype !== null) fail("invalid", "invalid_json");
      const keys = Reflect.ownKeys(objectValue);
      if (keys.length > policy.maxObjectKeys) fail("too_large", "object_keys");
      addBytes(2 + Math.max(0, keys.length - 1));
      const clone = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") return fail("invalid", "invalid_json");
        const keyBytes = Buffer.byteLength(key, "utf8");
        if (keyBytes > policy.maxBytes) fail("too_large", "bytes");
        addBytes(scalarBytes(key) + 1);
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return fail("invalid", "invalid_json");
        }
        clone[key] = capture(descriptor.value, depth + 1);
      }
      return clone;
    } finally {
      ancestors.delete(objectValue);
    }
  };

  try {
    const value = capture(source, 0);
    checkpoint();
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") !== bytes) {
      fail("invalid", "invalid_json");
    }
    return { value, bytes };
  } catch (error) {
    if (localFailures.has(error) || checkpointFailures.has(error)) throw error;
    return fail("invalid", "invalid_json");
  }
};

const snapshotContractInput = (
  value: unknown,
  invalidCode: Extract<PcbDesignContractErrorCode, "INVALID_DRAFT" | "INVALID_CONTRACT">
): unknown => {
  try {
    return snapshotPcbDesignJson(value, {
      maxBytes: PCB_DESIGN_CONTRACT_LIMITS.maxPayloadBytes,
      maxDepth: PCB_DESIGN_CONTRACT_LIMITS.maxSnapshotDepth,
      maxNodes: PCB_DESIGN_CONTRACT_LIMITS.maxSnapshotNodes,
      maxArrayLength: PCB_DESIGN_CONTRACT_LIMITS.maxSnapshotArrayLength,
      maxObjectKeys: PCB_DESIGN_CONTRACT_LIMITS.maxSnapshotObjectKeys,
      rejectAliases: true
    }).value;
  } catch (cause) {
    if (cause instanceof PcbDesignJsonSnapshotError && cause.reason === "too_large") {
      throw new PcbDesignContractError(
        "PAYLOAD_TOO_LARGE",
        `PCB design payload exceeds its bounded structure or byte limit; limit is ${PCB_DESIGN_CONTRACT_LIMITS.maxPayloadBytes}`,
        { cause }
      );
    }
    throw new PcbDesignContractError(
      invalidCode,
      "PCB design input must be bounded, plain, acyclic JSON data",
      { cause }
    );
  }
};

const formatIssues = (error: z.ZodError, priorityMessages: readonly string[] = []): string => {
  const prioritized = priorityMessages.flatMap((message) => error.issues.filter((entry) => entry.message === message));
  const prioritySet = new Set(priorityMessages);
  const remainder = error.issues.filter((entry) => !prioritySet.has(entry.message));
  const selected = [...prioritized, ...remainder].slice(0, PCB_DESIGN_CONTRACT_LIMITS.maxFormattedIssues);
  const formatted = selected
    .map((entry) => `${entry.path.length === 0 ? "$" : entry.path.join(".")}: ${entry.message}`)
    .join("; ");
  const omitted = error.issues.length - selected.length;
  return omitted > 0 ? `${formatted}; ... ${omitted} additional issue(s) omitted` : formatted;
};

const deepFreeze = <Value>(value: Value): DeepReadonly<Value> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
};

/** Parse and normalize bounded, untrusted model output without closing it. */
export const parsePcbDesignIntentDraft = (value: unknown): PcbDesignIntentDraft => {
  const snapshot = snapshotContractInput(value, "INVALID_DRAFT");
  const parsed = pcbDesignIntentDraftSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new PcbDesignContractError("INVALID_DRAFT", `Invalid PCB design intent draft: ${formatIssues(parsed.error)}`, { cause: parsed.error });
  }
  return deepFreeze(canonicalizeDraft(parsed.data));
};

/** Validate and normalize a payload before computing its canonical identity. */
export const pcbDesignContractIdentity = (value: unknown): CanonicalIdentity => {
  const snapshot = snapshotContractInput(value, "INVALID_CONTRACT");
  const parsed = pcbDesignContractPayloadSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new PcbDesignContractError(
      "INVALID_CONTRACT",
      `Cannot identify an invalid PCB design contract payload: ${formatIssues(parsed.error)}`,
      { cause: parsed.error }
    );
  }
  return canonicalIdentity(canonicalizePayload(parsed.data), PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
};

/**
 * Close a fully-resolved draft.  This does not emit commands or mutate KiCad;
 * it only converts a validated intent into an immutable canonical contract.
 */
export const closePcbDesignIntentDraft = (value: unknown): PcbDesignContract => {
  const draft = parsePcbDesignIntentDraft(value);
  if (draft.unresolved.length !== 0) {
    throw new PcbDesignContractError(
      "UNRESOLVED_DRAFT",
      `PCB design intent still has ${draft.unresolved.length} unresolved item(s): ${draft.unresolved.map((entry) => entry.path).join(", ")}`
    );
  }
  const candidate: unknown = {
    schemaVersion: PCB_DESIGN_CONTRACT_SCHEMA_VERSION,
    kind: "pcb_design_contract",
    scope: draft.scope,
    components: draft.components,
    nets: draft.nets,
    netClasses: draft.netClasses,
    placementConstraints: draft.placementConstraints,
    routingConstraints: draft.routingConstraints
  };
  const payloadResult = pcbDesignContractPayloadSchema.safeParse(candidate);
  if (!payloadResult.success) {
    throw new PcbDesignContractError(
      "UNRESOLVED_DRAFT",
      `PCB design intent is not fully resolvable: ${formatIssues(payloadResult.error)}`,
      { cause: payloadResult.error }
    );
  }
  const payload = canonicalizePayload(payloadResult.data);
  const contract: ContractMutable = {
    ...payload,
    identity: canonicalIdentity(payload, PCB_DESIGN_CONTRACT_SCHEMA_VERSION)
  };
  return parsePcbDesignContract(contract);
};

/** Parse a closed artifact, rejecting order changes and identity tampering. */
export const parsePcbDesignContract = (value: unknown): PcbDesignContract => {
  const snapshot = snapshotContractInput(value, "INVALID_CONTRACT");
  const parsed = pcbDesignContractSchema.safeParse(snapshot);
  if (!parsed.success) {
    const hasCanonicalOrderIssue = parsed.error.issues.some((entry) => entry.message === canonicalOrderIssueMessage);
    const hasIdentityIssue = parsed.error.issues.some((entry) => entry.message === identityIssueMessage);
    const messages = formatIssues(parsed.error, [canonicalOrderIssueMessage, identityIssueMessage]);
    const code: PcbDesignContractErrorCode = hasCanonicalOrderIssue
      ? "NON_CANONICAL_CONTRACT"
      : hasIdentityIssue
        ? "CONTRACT_IDENTITY_MISMATCH"
        : "INVALID_CONTRACT";
    throw new PcbDesignContractError(code, `Invalid closed PCB design contract: ${messages}`, { cause: parsed.error });
  }
  return deepFreeze(parsed.data);
};
