import { pcbExternalPowerInputsDraftSchema, pcbExternalPowerInputsSchema, validatePcbExternalPowerRelationships } from "./pcb-external-power.js";
import { pcbDerivedPowerSourcesDraftSchema, pcbDerivedPowerSourcesSchema, validatePcbDerivedPowerRelationships } from "./pcb-derived-power.js";
import { z } from "zod";
import { pcbCopperLayerSchema, pcbLayerCountSchema, pcbRouteLayerPreferenceSchema, pcbCopperLayerOrder,
  comparePcbCopperLayers } from "./pcb-copper-layers.js";
import { pcbBoardFeaturesSchema, validatePcbBoardFeatureRelationships } from "./pcb-board-features.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { pcbInterfaceRequirementsDraftSchema, pcbInterfaceRequirementsSchema,
  validatePcbInterfaceRelationships, canonicalizePcbInterfaceRequirements } from "./pcb-interface-requirements.js";
import {
  pcbDesignContractPayloadSchema,
  pcbDesignIntentDraftSchema,
  PCB_DESIGN_CONTRACT_LIMITS,
  validatePcbDesignCommonRelationships,
  snapshotPcbDesignJson,
} from "./pcb-design-contract.js";

export const PCB_PLANE_DRAFT_SCHEMA_VERSION = "evleda.pcb-design-intent-draft.v2" as const;
export const PCB_PLANE_CONTRACT_SCHEMA_VERSION = "evleda.pcb-design-contract.v2" as const;
export const PCB_PLANE_CONTRACT_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxPlanes: 2, maxNets: 128, maxEndpoints: 256 });

type ReadonlyTree<T> = T extends readonly (infer V)[] ? readonly ReadonlyTree<V>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyTree<T[K]> } : T;
export function freezePcbPlaneArtifact<T>(value: T): ReadonlyTree<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePcbPlaneArtifact(child);
    Object.freeze(value);
  }
  return value as ReadonlyTree<T>;
}
export function snapshotPcbPlaneValue(value: unknown, maxBytes = PCB_PLANE_CONTRACT_LIMITS.maxBytes): unknown {
  // Preserve numeric tokens such as -0 until the schema can reject them.
  return snapshotPcbDesignJson(value, { maxBytes, maxDepth: 64, maxNodes: 100_000,
    maxArrayLength: 1024, maxObjectKeys: 1024, rejectAliases: false }).value;
}

const closed = pcbDesignContractPayloadSchema.shape;
const draft = pcbDesignIntentDraftSchema.shape;
const netName = closed.nets.element.shape.name;
const identifier = closed.netClasses.element.shape.id;
const endpoint = closed.nets.element.shape.endpoints.element;
const region = closed.placementConstraints.element.shape.regionMm;
const number = (min: number, max: number) => z.number().finite().min(min).max(max).refine(value => !Object.is(value, -0), "Negative zero is not canonical");
const width = number(0.05, 20);
const clearance = number(0.05, 10);
const area = number(0, 250_000);
const layer = pcbCopperLayerSchema;
const boardLayers = z.array(layer).min(2).max(4);
const allowedLayers = z.array(layer).min(1).max(4);
const scope = closed.scope.extend({ board: closed.scope.shape.board.extend({ layerCount: pcbLayerCountSchema, copperLayers: boardLayers }).strict() }).strict();
const scopeDraft = draft.scope.extend({ board: draft.scope.shape.board.extend({ layerCount: pcbLayerCountSchema, copperLayers: boardLayers }).strict() }).strict();
const netClasses = z.array(closed.netClasses.element.extend({ allowedLayers }).strict()).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses);
const netClassesDraft = z.array(draft.netClasses.element.extend({ allowedLayers: allowedLayers.nullable() }).strict()).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxNetClasses);
const closedRoute = closed.routingConstraints.shape.nets.element;
const draftRoute = draft.routingConstraints.shape.nets.element;
const boundary = region.extend({ kind: z.literal("rectangle") }).strict();
const thermal = z.object({ mode: z.literal("thermal"), gapMm: clearance, spokeWidthMm: width,
  minimumConnectedSpokes: z.number().int().min(1).max(4) }).strict();
const thermalDraft = thermal.extend({ gapMm: clearance.nullable(), spokeWidthMm: width.nullable(),
  minimumConnectedSpokes: thermal.shape.minimumConnectedSpokes.nullable() }).strict();
const solid = z.object({ mode: z.literal("solid") }).strict();
const singleIslandPolicy = z.object({ removeUnconnected: z.literal(true), minimumAreaMm2: area,
  requireSingleConnectedComponent: z.literal(true) }).strict();
const regionalIslandPolicy = z.object({ removeUnconnected: z.literal(true), minimumAreaMm2: area,
  requireSingleConnectedComponent: z.literal(false), referencePlaneId: identifier,
  engineeringBasis: z.string().trim().min(1).max(1024) }).strict();
const islandPolicy = z.discriminatedUnion("requireSingleConnectedComponent", [singleIslandPolicy, regionalIslandPolicy]);
const islandPolicyDraft = z.discriminatedUnion("requireSingleConnectedComponent", [
  singleIslandPolicy.extend({ minimumAreaMm2: area.nullable() }).strict(),
  regionalIslandPolicy.extend({ minimumAreaMm2: area.nullable(), referencePlaneId: identifier.nullable(),
    engineeringBasis: regionalIslandPolicy.shape.engineeringBasis.nullable() }).strict(),
]);
const plane = z.object({ id: identifier, net: netName, layer, boundary, clearanceMm: clearance,
  minimumCopperWidthMm: width, copperFill: z.literal("solid"),
  padConnection: z.discriminatedUnion("mode", [solid, thermal]), islandPolicy }).strict();
const planeDraft = plane.extend({ net: netName.nullable(), layer: layer.nullable(), boundary: boundary.nullable(),
  clearanceMm: clearance.nullable(), minimumCopperWidthMm: width.nullable(), copperFill: z.literal("solid").nullable(),
  padConnection: z.discriminatedUnion("mode", [solid, thermalDraft]).nullable(),
  islandPolicy: islandPolicyDraft.nullable() }).strict();

const terminalReference = z.object({ signalEndpoint: endpoint, referenceEndpoint: endpoint }).strict();
const continuousReference = z.object({ mode: z.literal("continuous_plane"), planeId: identifier,
  signalLayer: layer, coverageMarginMm: number(0, 50), layerTransitions: z.literal("forbidden"),
  terminalReferences: z.array(terminalReference).min(1).max(PCB_PLANE_CONTRACT_LIMITS.maxEndpoints) }).strict();
const noReference = z.object({ mode: z.literal("none") }).strict();
const referenceDraft = z.discriminatedUnion("mode", [noReference, continuousReference.extend({
  planeId: identifier.nullable(), signalLayer: layer.nullable(), coverageMarginMm: number(0, 50).nullable(),
  terminalReferences: z.array(terminalReference).max(PCB_PLANE_CONTRACT_LIMITS.maxEndpoints).nullable(),
}).strict()]).nullable();
// Plane access may serve many local return terminals; ordinary trace routes keep their V1 ceiling.
const accessRouting = z.object({ preferredLayer: pcbRouteLayerPreferenceSchema.describe("An exact layer constrains every access track. either means the two outer layers; any permits the net class's declared enabled layers. Each plane retains one exact layer."), maxVias: z.number().finite().int().min(0).max(64).refine(value => !Object.is(value, -0), "Negative zero is not canonical"),
  routeLength: closedRoute.shape.routeLength }).strict();
const accessDraft = accessRouting.extend({ preferredLayer: accessRouting.shape.preferredLayer.nullable(), maxVias: accessRouting.shape.maxVias.nullable(),
  routeLength: closedRoute.shape.routeLength.nullable() }).strict();
const routed = closedRoute.extend({ preferredLayer: pcbRouteLayerPreferenceSchema, referencePath: z.discriminatedUnion("mode", [noReference, continuousReference]) }).strict();
const additionalPlaneIds = z.array(identifier).min(1).max(1);
const planeRoute = z.object({ net: netName, topology: z.literal("plane"), planeId: identifier, additionalPlaneIds: additionalPlaneIds.optional(), accessRouting }).strict();
const routedDraft = draftRoute.extend({ preferredLayer: pcbRouteLayerPreferenceSchema.nullable(), referencePath: referenceDraft }).strict();
const planeRouteDraft = planeRoute.extend({ planeId: identifier.nullable(), additionalPlaneIds: additionalPlaneIds.nullable().optional(), accessRouting: accessDraft.nullable() }).strict();
const minimumHoleToHoleMm = number(0.05, 10).refine(value => {
  try { routeSourceMmToNativeNm(value); return true; } catch { return false; }
}, "Hole spacing must be exact integer nanometres");
const routing = closed.routingConstraints.extend({ minimumHoleToHoleMm: minimumHoleToHoleMm.optional(),
  nets: z.array(z.discriminatedUnion("topology", [routed, planeRoute])).min(1).max(128) }).strict();
const routingDraft = draft.routingConstraints.extend({ minimumHoleToHoleMm: minimumHoleToHoleMm.nullable().optional(),
  nets: z.array(z.discriminatedUnion("topology", [routedDraft, planeRouteDraft])).max(128) }).strict();

const draftBase = z.object({ ...draft, schemaVersion: z.literal(PCB_PLANE_DRAFT_SCHEMA_VERSION), scope: scopeDraft, netClasses: netClassesDraft,
  nativeRuleMode: z.literal("contract-derived-v1").describe("Opt in to contract-derived native numeric floors and exact per-net/via rules; omission preserves legacy native settings. This does not qualify manufacturing or channel escape locality.").nullable().optional(),
  routingConstraints: routingDraft, planes: z.array(planeDraft).max(2),
  externalPowerInputs: pcbExternalPowerInputsDraftSchema.nullable().optional(),
  derivedPowerSources: pcbDerivedPowerSourcesDraftSchema.nullable().optional(),
  boardFeatures: pcbBoardFeaturesSchema.nullable().optional(),
  interfaceRequirements: pcbInterfaceRequirementsDraftSchema.nullable().optional() }).strict();
const payloadBase = z.object({ ...closed, schemaVersion: z.literal(PCB_PLANE_CONTRACT_SCHEMA_VERSION), scope, netClasses,
  nativeRuleMode: z.literal("contract-derived-v1").optional(),
  routingConstraints: routing, planes: z.array(plane).min(1).max(2),
  externalPowerInputs: pcbExternalPowerInputsSchema.optional(),
  derivedPowerSources: pcbDerivedPowerSourcesSchema.optional(),
  boardFeatures: pcbBoardFeaturesSchema.optional(),
  interfaceRequirements: pcbInterfaceRequirementsSchema.optional() }).strict();
type DraftValue = z.infer<typeof draftBase>;
type PayloadValue = z.infer<typeof payloadBase>;
export type PcbPlaneDesignIntentDraft = ReadonlyTree<DraftValue>;
export type PcbPlaneDesignContractPayload = ReadonlyTree<PayloadValue>;
export type PcbPlaneDesignContract = PcbPlaneDesignContractPayload & { readonly identity: CanonicalIdentity };

const key = (point: { reference: string; pin: string }) => `${point.reference}:${point.pin}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pointerToken = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const arrayEntryKey = (collection: string, entry: unknown): string | null => {
  if (!record(entry)) return null;
  const field = collection === "planes" || collection === "netClasses" || collection === "interfaces" || collection === "externalPowerInputs" || collection === "derivedPowerSources" ? "id"
    : collection === "components" || collection === "placementConstraints" || collection === "boardFeatures" ? "reference"
      : collection === "pins" ? "pin" : collection === "nets" ? ("net" in entry ? "net" : "name") : null;
  if (field !== null && typeof entry[field] === "string") return entry[field];
  if (collection === "terminalReferences" && record(entry.signalEndpoint)) return `${entry.signalEndpoint.reference}:${entry.signalEndpoint.pin}`;
  if (collection === "endpoints" && typeof entry.reference === "string" && typeof entry.pin === "string") return `${entry.reference}:${entry.pin}`;
  if (collection === "additionalReceivers" && record(entry.positive)) return `${entry.positive.reference}:${entry.positive.pin}`;
  if (collection === "protection" && typeof entry.componentReference === "string") return entry.componentReference;
  if (collection === "escapes" && record(entry.terminal)) return `${entry.terminal.reference}:${entry.terminal.pin}`;
  return null;
};

/** Resolve numeric or keyed draft paths to stable keyed RFC6901 pointers. */
export function normalizePcbPlaneUnresolvedPath(document: unknown, pointer: string): string | null {
  if (typeof pointer !== "string" || pointer.length > 512 || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return null;
  let current: unknown = document;
  let collection = "";
  const resolved: string[] = [];
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (token === "") return null;
    if (Array.isArray(current)) {
      const matches = current.filter(entry => arrayEntryKey(collection, entry) === token);
      const index = /^(?:0|[1-9]\d*)$/u.test(token) ? Number(token) : -1;
      const byIndex = index >= 0 && index < current.length ? current[index] : undefined;
      if (matches.length > 1 || (matches.length === 1 && byIndex !== undefined && matches[0] !== byIndex)) return null;
      const entry = matches[0] ?? byIndex;
      if (entry === undefined) return null;
      resolved.push(pointerToken(arrayEntryKey(collection, entry) ?? token));
      current = entry;
    } else if (!["__proto__", "constructor", "prototype"].includes(token) && record(current) && Object.hasOwn(current, token)) {
      resolved.push(pointerToken(token)); collection = token; current = current[token];
    } else return null;
  }
  const result = `/${resolved.join("/")}`;
  return result.length <= 512 ? result : null;
}

function relationships(document: DraftValue | PayloadValue, context: z.RefinementCtx, closedContract: boolean): void {
  const constructionUnresolved = document.interfaceRequirements === null || document.interfaceRequirements?.construction === null;
  if (document.scope.board.layerCount === 4 && document.interfaceRequirements?.construction?.mode !== "four_layer"
    && (closedContract || !constructionUnresolved)) {
    context.addIssue({ code: "custom", path: ["interfaceRequirements", "construction"], message: "Four-layer boards require an explicit four-layer physical construction" });
  }
  if (document.routingConstraints.minimumHoleToHoleMm !== undefined && document.nativeRuleMode !== "contract-derived-v1") {
    context.addIssue({ code: "custom", path: ["routingConstraints", "minimumHoleToHoleMm"], message: "Explicit hole spacing requires nativeRuleMode=contract-derived-v1" });
  }
  validatePcbDesignCommonRelationships(document, context, closedContract, { allowFourLayers: true });
  validatePcbInterfaceRelationships(document, context, closedContract);
  validatePcbExternalPowerRelationships(document, context);
  validatePcbDerivedPowerRelationships(document, context);
  validatePcbBoardFeatureRelationships(document, context);
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: "custom", path, message });
  if (document.scope.board.layerCount === 2 && document.planes.length > 1) issue(["planes"], "Two-layer plane contracts retain the single-plane limit");
  const unique = <T>(values: readonly T[], getKey: (value: T) => string, path: PropertyKey[]) => {
    const seen = new Set<string>();
    values.forEach((value, index) => { const name = getKey(value); if (seen.has(name)) issue([...path, index], `Duplicate ${name}`); seen.add(name); });
  };
  unique(document.planes, p => p.id, ["planes"]);
  unique(document.planes.filter(p => p.layer !== null), p => p.layer!, ["planes"]);
  unique(document.routingConstraints.nets, r => r.net, ["routingConstraints", "nets"]);
  const nets = new Map(document.nets.map(n => [n.name, n]));
  const classes = new Map(document.netClasses.map(c => [c.id, c]));
  const planes = new Map(document.planes.map(p => [p.id, p]));
  for (const [index, p] of document.planes.entries()) {
    const path: PropertyKey[] = ["planes", index];
    const net = p.net === null ? undefined : nets.get(p.net);
    if (p.net !== null && net === undefined) issue([...path, "net"], "Plane references an unknown net");
    if (net?.role !== null && net?.role !== undefined && net.role !== "ground") issue([...path, "net"], "This bounded V2 family supports a ground plane only");
    const netClass = net?.netClassId == null ? undefined : classes.get(net.netClassId);
    if (p.layer !== null && !document.scope.board.copperLayers.includes(p.layer)) issue([...path, "layer"], "Plane layer is not enabled by this board");
    if (p.layer !== null && netClass?.allowedLayers != null && !netClass.allowedLayers.includes(p.layer)) issue([...path, "layer"], "Plane layer is forbidden by its net class");
    if (p.clearanceMm !== null && netClass?.clearanceMm != null && p.clearanceMm < netClass.clearanceMm) issue([...path, "clearanceMm"], "Plane clearance cannot weaken its net-class clearance");
    if (p.boundary !== null) {
      const b = p.boundary, board = document.scope.board;
      if (b.minXmm >= b.maxXmm || b.minYmm >= b.maxYmm) issue([...path, "boundary"], "Plane boundary must have positive area");
      const edge = netClass?.copperToEdgeMm ?? 0;
      if (b.minXmm < edge || b.minYmm < edge || (board.widthMm !== null && b.maxXmm > board.widthMm - edge)
          || (board.heightMm !== null && b.maxYmm > board.heightMm - edge)) issue([...path, "boundary"], "Plane boundary exceeds its board or copper-to-edge requirement");
      if (p.islandPolicy?.minimumAreaMm2 != null && p.islandPolicy.minimumAreaMm2 > (b.maxXmm - b.minXmm) * (b.maxYmm - b.minYmm)) issue([...path, "islandPolicy", "minimumAreaMm2"], "Island threshold exceeds the entire plane boundary area");
    }
    if (p.padConnection?.mode === "thermal" && p.padConnection.spokeWidthMm !== null && p.minimumCopperWidthMm !== null
        && p.padConnection.spokeWidthMm < p.minimumCopperWidthMm) issue([...path, "padConnection", "spokeWidthMm"], "Thermal spokes must satisfy the declared minimum plane copper width");
    const owners = document.routingConstraints.nets.filter(r => r.topology === "plane" && (r.planeId === p.id || r.additionalPlaneIds?.includes(p.id)));
    if (owners.length > 1 || (closedContract && owners.length !== 1)) issue(path, "Every plane must have exactly one plane-topology routing owner");
    if (p.net !== null && owners.some(r => r.net !== p.net)) issue([...path, "net"], "Plane net differs from its routing owner");
    if (p.islandPolicy?.requireSingleConnectedComponent === false) {
      const policyPath = [...path, "islandPolicy"], referenceId = p.islandPolicy.referencePlaneId;
      if (document.scope.board.layerCount !== 4) issue(policyPath, "Regional grounding requires a supplemental plane on a four-layer board");
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (owner?.topology === "plane") {
        if (owner.additionalPlaneIds !== null && !owner.additionalPlaneIds?.includes(p.id)) issue(policyPath, "Only an additional plane may use regional grounding");
        if (referenceId !== null && owner.planeId !== null && referenceId !== owner.planeId) issue([...policyPath, "referencePlaneId"], "Regional grounding must use its owner's primary plane");
      }
      const primary = referenceId === null ? undefined : planes.get(referenceId);
      if (referenceId !== null && (primary === undefined || referenceId === p.id)) issue([...policyPath, "referencePlaneId"], "An existing distinct primary plane is required");
      if (primary !== undefined && (primary.islandPolicy?.requireSingleConnectedComponent === false
        || primary.net !== null && p.net !== null && primary.net !== p.net)) issue(policyPath, "The primary plane must retain its single-component policy and ground net");
      if (document.routingConstraints.nets.some(r => r.topology !== "plane" && r.referencePath?.mode === "continuous_plane" && r.referencePath.planeId === p.id)
        || (document.interfaceRequirements?.interfaces ?? []).some(pair => pair.routing?.referencePlaneId === p.id))
        issue(policyPath, "A required signal/interface reference plane cannot use regional grounding");
    }
  }
  let viaSum = 0;
  const globalVia = document.routingConstraints.viaPolicy;
  for (const [index, route] of document.routingConstraints.nets.entries()) {
    const path: PropertyKey[] = ["routingConstraints", "nets", index];
    const net = nets.get(route.net);
    if (net === undefined) { issue([...path, "net"], "Unknown routing net"); continue; }
    const netClass = net.netClassId === null ? undefined : classes.get(net.netClassId);
    const access = route.topology === "plane" ? route.accessRouting : route;
    const maxVias = access?.maxVias;
    if (maxVias != null) {
      viaSum += maxVias;
      if (globalVia?.mode === "forbidden" && maxVias !== 0) issue(path, "Global via policy forbids plane-access and trace vias");
      if (globalVia?.mode === "bounded" && maxVias > globalVia.maxTotal) issue(path, "Per-net via maximum exceeds the global bound");
      if (netClass?.allowedLayers?.length === 1 && maxVias !== 0) issue(path, "Single-layer net class cannot permit vias");
    }
    const preferred = access?.preferredLayer;
    if (preferred === "any" && document.scope.board.layerCount === 2) issue(route.topology === "plane"
      ? [...path, "accessRouting", "preferredLayer"] : [...path, "preferredLayer"], "Two-layer routing uses an exact outer layer or either; any is reserved for four-layer declarations");
    if (preferred != null && netClass?.allowedLayers != null) {
      if (preferred === "either" ? netClass.allowedLayers.length !== 2 || !netClass.allowedLayers.includes("F.Cu") || !netClass.allowedLayers.includes("B.Cu")
        : preferred !== "any" && !netClass.allowedLayers.includes(preferred)) issue(path, "Routing layer is incompatible with its net class");
    }
    if (route.topology === "plane") {
      const target = route.planeId === null ? undefined : planes.get(route.planeId);
      if (route.planeId !== null && (target === undefined || (target.net !== null && target.net !== route.net))) issue([...path, "planeId"], "Plane routing must reference its own declared plane/net");
      const ids = [route.planeId, ...(route.additionalPlaneIds ?? [])].filter(id => id !== null);
      if (new Set(ids).size !== ids.length) issue([...path, "additionalPlaneIds"], "Plane routing repeats a plane ID");
      for (const id of route.additionalPlaneIds ?? []) {
        const additional = planes.get(id);
        if (additional === undefined || additional.net !== null && additional.net !== route.net) issue([...path, "additionalPlaneIds"], "Additional plane must belong to the same routing net");
      }
      continue;
    }
    if (route.topology !== null && document.planes.some(p => p.net === route.net)) issue([...path, "topology"], "A plane net requires explicit plane topology, not a trace tree or path");
    if (route.topology === "point_to_point" && (closedContract || net.endpoints.length > 0) && net.endpoints.length !== 2) issue([...path, "topology"], "Point-to-point routing requires exactly two endpoints");
    const reference = route.referencePath;
    if (reference?.mode !== "continuous_plane") continue;
    const target = reference.planeId === null ? undefined : planes.get(reference.planeId);
    if (reference.planeId !== null && target === undefined) issue([...path, "referencePath", "planeId"], "Unknown reference plane");
    if (reference.signalLayer !== null && target?.layer != null) {
      const order = pcbCopperLayerOrder(document.scope.board.layerCount);
      const signalIndex = order.indexOf(reference.signalLayer), referenceIndex = order.indexOf(target.layer);
      if (signalIndex < 0 || referenceIndex < 0 || Math.abs(signalIndex - referenceIndex) !== 1) issue([...path, "referencePath", "signalLayer"], "Reference plane must be on an adjacent enabled copper layer");
    }
    if (reference.signalLayer !== null && route.preferredLayer !== null && reference.signalLayer !== route.preferredLayer) issue([...path, "referencePath"], "Referenced routes require one exact signal layer");
    if (route.maxVias !== null && route.maxVias !== 0) issue([...path, "maxVias"], "Reference-path layer transitions are forbidden in this bounded family");
    if (reference.terminalReferences !== null) {
      unique(reference.terminalReferences, r => key(r.signalEndpoint), [...path, "referencePath", "terminalReferences"]);
      const signalEndpoints = new Set(net.endpoints.map(key));
      const groundEndpoints = target?.net == null ? null : new Set(nets.get(target.net)?.endpoints.map(key) ?? []);
      for (const terminal of reference.terminalReferences) {
        if (!signalEndpoints.has(key(terminal.signalEndpoint))) issue([...path, "referencePath", "terminalReferences"], "Signal terminal does not belong to this route net");
        if (groundEndpoints !== null && !groundEndpoints.has(key(terminal.referenceEndpoint))) issue([...path, "referencePath", "terminalReferences"], "Reference terminal does not belong to the plane net");
      }
      if (closedContract && reference.terminalReferences.length !== signalEndpoints.size) issue([...path, "referencePath", "terminalReferences"], "Every signal endpoint requires one explicit reference terminal");
    }
  }
  if (globalVia?.mode === "bounded") {
    if (viaSum > globalVia.maxTotal) issue(["routingConstraints", "viaPolicy"], "Combined trace and plane-access via maxima exceed the global budget");
    if (globalVia.drillMm + 2 * globalVia.minimumAnnularRingMm > globalVia.diameterMm + Number.EPSILON) issue(["routingConstraints", "viaPolicy"], "Via geometry cannot provide its required annular ring");
  }
  if (closedContract) for (const net of document.nets) {
    if (!document.routingConstraints.nets.some(r => r.net === net.name)) issue(["routingConstraints", "nets"], `Missing routing constraint for ${net.name}`);
  }
}

export const pcbPlaneDesignIntentDraftSchema = draftBase.superRefine((value, context) => {
  relationships(value, context, false);
  const resolved = new Set<string>();
  for (const [index, entry] of value.unresolved.entries()) {
    const path = normalizePcbPlaneUnresolvedPath(value, entry.path);
    if (path === null || resolved.has(path)) context.addIssue({ code: "custom", path: ["unresolved", index, "path"], message: "Unresolved path is unknown, ambiguous, or duplicated" });
    else resolved.add(path);
  }
});
export const pcbPlaneDesignContractPayloadSchema = payloadBase.superRefine((value, context) => relationships(value, context, true));

function canonicalize<T extends DraftValue | PayloadValue>(input: T): T {
  const value = structuredClone(input);
  value.scope.board.copperLayers.sort(comparePcbCopperLayers);
  value.components.sort((a, b) => compare(a.reference, b.reference));
  value.boardFeatures?.sort((a, b) => compare(a.reference, b.reference));
  for (const component of value.components) component.pins.sort((a, b) => compare(a.pin, b.pin));
  value.nets.sort((a, b) => compare(a.name, b.name));
  for (const net of value.nets) net.endpoints.sort((a, b) => compare(key(a), key(b)));
  value.netClasses.sort((a, b) => compare(a.id, b.id));
  for (const netClass of value.netClasses) netClass.allowedLayers?.sort(comparePcbCopperLayers);
  value.placementConstraints.sort((a, b) => compare(a.reference, b.reference));
  for (const placement of value.placementConstraints) placement.allowedRotationsDeg?.sort((a, b) => a - b);
  value.planes.sort((a, b) => compare(a.id, b.id));
  canonicalizePcbInterfaceRequirements(value.interfaceRequirements);
  value.externalPowerInputs?.sort((a, b) => compare(a.id, b.id));
  value.derivedPowerSources?.sort((a, b) => compare(a.id, b.id));
  value.routingConstraints.nets.sort((a, b) => compare(a.net, b.net));
  for (const route of value.routingConstraints.nets) if (route.topology !== "plane" && route.referencePath?.mode === "continuous_plane") {
    route.referencePath.terminalReferences?.sort((a, b) => compare(key(a.signalEndpoint), key(b.signalEndpoint)));
  }
  if ("unresolved" in value) value.unresolved = value.unresolved.map(entry => ({ ...entry,
    path: normalizePcbPlaneUnresolvedPath(input, entry.path)! })).sort((a, b) => compare(a.path, b.path));
  return value;
}

export function parsePcbPlaneDesignIntentDraft(input: unknown): PcbPlaneDesignIntentDraft {
  return freezePcbPlaneArtifact(canonicalize(pcbPlaneDesignIntentDraftSchema.parse(snapshotPcbPlaneValue(input))));
}
export function closePcbPlaneDesignIntentDraft(input: unknown): PcbPlaneDesignContract {
  const value = parsePcbPlaneDesignIntentDraft(input);
  if (value.unresolved.length > 0) throw new Error("Plane contract still contains unresolved questions");
  const { unresolved: _unresolved, ...common } = value;
  const payload = canonicalize(pcbPlaneDesignContractPayloadSchema.parse({ ...common,
    schemaVersion: PCB_PLANE_CONTRACT_SCHEMA_VERSION, kind: "pcb_design_contract" }));
  return freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, PCB_PLANE_CONTRACT_SCHEMA_VERSION) });
}
export function parsePcbPlaneDesignContract(input: unknown): PcbPlaneDesignContract {
  const value = snapshotPcbPlaneValue(input);
  if (!record(value) || !Object.hasOwn(value, "identity")) throw new Error("Plane contract identity is missing");
  const { identity, ...inputPayload } = value;
  const payload = pcbPlaneDesignContractPayloadSchema.parse(inputPayload);
  if (canonicalJson(payload) !== canonicalJson(canonicalize(payload))) throw new Error("Plane contract arrays are not canonical");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, PCB_PLANE_CONTRACT_SCHEMA_VERSION))) throw new Error("Plane contract identity mismatch");
  return freezePcbPlaneArtifact({ ...payload, identity: identity as unknown as CanonicalIdentity });
}
