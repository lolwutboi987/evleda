import { z } from "zod";
import { pcbDesignContractPayloadSchema } from "./pcb-design-contract.js";
import type { PcbPlaneDesignContractPayload, PcbPlaneDesignIntentDraft } from "./pcb-design-plane-contract.js";

export const PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION = "evleda.pcb-interface-requirements.v1" as const;
const common = pcbDesignContractPayloadSchema.shape;
const identifier = common.netClasses.element.shape.id;
const endpoint = common.nets.element.shape.endpoints.element;
const netName = common.nets.element.shape.name;
const reference = endpoint.shape.reference;
const pin = endpoint.shape.pin;
const text = z.string().min(1).max(1024).refine(value => value.trim() === value && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value), "Provide bounded scalar text without surrounding whitespace or control characters");
const number = (min: number, max: number) => z.number().finite().min(min).max(max)
  .refine(value => !Object.is(value, -0), "Negative zero is not canonical");
const positive = number(0.000_001, 1_000_000);
const nativeThickness = number(0.000_001, 2147.483637).refine(value => Number(value.toFixed(6)) === value,
  "Saved native construction requires exact integer-nanometre thicknesses");
const nativeMaterialScalar = (min: number, max: number) => number(min, max).refine(value =>
  Number(value !== 0 && value <= 0.0001 ? value.toFixed(16) : value.toPrecision(10)) === value,
  "Material scalar cannot be saved exactly by the pinned native stackup serializer; provide an explicit representable value");
const nativeMaterialText = text.refine(value => value.toLowerCase() !== "not specified",
  "The native unspecified-material sentinel cannot stand for an explicit material or finish declaration");
const frequency = number(1, 1e15);
const length = number(0, 1_000_000);
const layer = z.enum(["F.Cu", "B.Cu"]);
const source = z.object({ kind: z.literal("caller_assertion"), reference: text, description: text }).strict();
const sourceDraft = source.extend({ reference: text.nullable(), description: text.nullable() }).strict();
const interval = z.object({ minimumMm: number(0.05, 20), maximumMm: number(0.05, 20) }).strict();
const intervalDraft = interval.extend({ minimumMm: interval.shape.minimumMm.nullable(), maximumMm: interval.shape.maximumMm.nullable() }).strict();
const geometry = z.object({ traceWidthMm: interval, edgeGapMm: interval, maxEtchLengthMm: positive,
  maxEtchSkewMm: length, maxUncoupledLengthMm: length }).strict();
const geometryDraft = geometry.extend({ traceWidthMm: intervalDraft.nullable(), edgeGapMm: intervalDraft.nullable(),
  maxEtchLengthMm: positive.nullable(), maxEtchSkewMm: length.nullable(), maxUncoupledLengthMm: length.nullable() }).strict();
const roleEndpoints = z.object({ positive: endpoint, negative: endpoint }).strict();
const roleEndpointsDraft = roleEndpoints.extend({ positive: endpoint.nullable(), negative: endpoint.nullable() }).strict();
const endpoints = z.object({ source: roleEndpoints, receiver: roleEndpoints }).strict();
const endpointsDraft = endpoints.extend({ source: roleEndpointsDraft.nullable(), receiver: roleEndpointsDraft.nullable() }).strict();
const nets = z.object({ positive: netName, negative: netName }).strict();
const netsDraft = nets.extend({ positive: netName.nullable(), negative: netName.nullable() }).strict();
const inversion = z.object({ policy: z.enum(["forbidden", "allowed_at_receiver"]), receiverMapping: z.enum(["normal", "inverted"]) }).strict();
const inversionDraft = inversion.extend({ policy: inversion.shape.policy.nullable(), receiverMapping: inversion.shape.receiverMapping.nullable() }).strict();
const routing = z.object({ allowedLayers: z.array(layer).min(1).max(2), layerTransitions: z.literal("forbidden"),
  stubs: z.literal("forbidden"), polarityInversion: inversion, referencePlaneId: identifier }).strict();
const routingDraft = routing.extend({ allowedLayers: routing.shape.allowedLayers.nullable(), layerTransitions: z.literal("forbidden").nullable(),
  stubs: z.literal("forbidden").nullable(), polarityInversion: inversionDraft.nullable(), referencePlaneId: identifier.nullable() }).strict();
const noTermination = z.object({ kind: z.literal("none"), source }).strict();
const integrated = z.object({ kind: z.literal("integrated"), componentReference: reference, positivePin: pin, negativePin: pin, source }).strict();
const parallel = integrated.extend({ kind: z.literal("parallel"), resistanceOhms: positive, maximumDistanceToEndpointMm: length }).strict();
const seriesLeg = z.object({ componentReference: reference, sourcePin: pin, linePin: pin, resistanceOhms: positive }).strict();
const series = z.object({ kind: z.literal("source_series"), positive: seriesLeg, negative: seriesLeg,
  maximumDistanceToEndpointMm: length, source }).strict();
const termination = z.discriminatedUnion("kind", [noTermination, integrated, parallel, series]);
const integratedDraft = integrated.extend({ componentReference: reference.nullable(), positivePin: pin.nullable(), negativePin: pin.nullable(), source: sourceDraft.nullable() }).strict();
const seriesLegDraft = seriesLeg.extend({ componentReference: reference.nullable(), sourcePin: pin.nullable(), linePin: pin.nullable(), resistanceOhms: positive.nullable() }).strict();
const terminationDraft = z.discriminatedUnion("kind", [noTermination.extend({ source: sourceDraft.nullable() }).strict(), integratedDraft,
  integratedDraft.extend({ kind: z.literal("parallel"), resistanceOhms: positive.nullable(), maximumDistanceToEndpointMm: length.nullable() }).strict(),
  series.extend({ positive: seriesLegDraft.nullable(), negative: seriesLegDraft.nullable(), maximumDistanceToEndpointMm: length.nullable(), source: sourceDraft.nullable() }).strict()]);
const terminations = z.object({ source: termination, receiver: termination }).strict();
const terminationsDraft = terminations.extend({ source: terminationDraft.nullable(), receiver: terminationDraft.nullable() }).strict();
const noImpedance = z.object({ mode: z.literal("none") }).strict();
const impedance = z.object({ mode: z.literal("differential"), targetOhms: positive, toleranceOhms: length,
  frequencyHz: frequency, constructionId: identifier, source }).strict();
const impedanceDraft = impedance.extend({ targetOhms: positive.nullable(), toleranceOhms: length.nullable(), frequencyHz: frequency.nullable(),
  constructionId: identifier.nullable(), source: sourceDraft.nullable() }).strict();
const material = z.object({ material: nativeMaterialText, relativePermittivity: nativeMaterialScalar(1, 1000), lossTangent: nativeMaterialScalar(0, 100), frequencyHz: frequency, source }).strict();
const materialDraft = material.extend({ material: nativeMaterialText.nullable(), relativePermittivity: material.shape.relativePermittivity.nullable(),
  lossTangent: material.shape.lossTangent.nullable(), frequencyHz: frequency.nullable(), source: sourceDraft.nullable() }).strict();
const dielectric = material.extend({ thicknessMm: nativeThickness, substrateRelativePermeability: positive }).strict();
const dielectricDraft = materialDraft.extend({ thicknessMm: nativeThickness.nullable(), substrateRelativePermeability: positive.nullable() }).strict();
const absentMask = z.object({ kind: z.literal("absent") }).strict();
const presentMask = material.extend({ kind: z.literal("present"), thicknessMm: nativeThickness }).strict();
const presentMaskDraft = materialDraft.extend({ kind: z.literal("present"), thicknessMm: nativeThickness.nullable() }).strict();
const mask = z.discriminatedUnion("kind", [absentMask, presentMask]);
const maskDraft = z.discriminatedUnion("kind", [absentMask, presentMaskDraft]);
const masks = z.object({ front: mask, back: mask }).strict();
const masksDraft = masks.extend({ front: maskDraft.nullable(), back: maskDraft.nullable() }).strict();
const exterior = z.object({ front: z.literal("air"), back: z.literal("air") }).strict();
const exteriorDraft = exterior.extend({ front: z.literal("air").nullable(), back: z.literal("air").nullable() }).strict();
const conductor = z.object({ conductivitySiemensPerMetre: number(1, 1e10), relativePermeability: positive, roughnessNm: length, source }).strict();
const conductorDraft = conductor.extend({ conductivitySiemensPerMetre: conductor.shape.conductivitySiemensPerMetre.nullable(),
  relativePermeability: positive.nullable(), roughnessNm: length.nullable(), source: sourceDraft.nullable() }).strict();
const noConstruction = z.object({ mode: z.literal("none") }).strict();
export const pcbInterfaceConstructionSchema = z.object({ mode: z.literal("two_layer"), id: identifier,
  boardThicknessMm: nativeThickness, frontCopperThicknessMm: nativeThickness, backCopperThicknessMm: nativeThickness,
  dielectric, conductor, solderMask: masks, exterior, surfaceFinish: nativeMaterialText, source }).strict();
const constructionDraft = pcbInterfaceConstructionSchema.extend({ boardThicknessMm: nativeThickness.nullable(), frontCopperThicknessMm: nativeThickness.nullable(),
  backCopperThicknessMm: nativeThickness.nullable(), dielectric: dielectricDraft.nullable(), conductor: conductorDraft.nullable(),
  solderMask: masksDraft.nullable(), exterior: exteriorDraft.nullable(), surfaceFinish: nativeMaterialText.nullable(), source: sourceDraft.nullable() }).strict();
export const pcbDifferentialPairRequirementSchema = z.object({ id: identifier, kind: z.literal("differential_pair"), nets, endpoints,
  geometry, routing, terminations, impedance: z.discriminatedUnion("mode", [noImpedance, impedance]), source }).strict();
const pairDraft = pcbDifferentialPairRequirementSchema.extend({ nets: netsDraft.nullable(), endpoints: endpointsDraft.nullable(),
  geometry: geometryDraft.nullable(), routing: routingDraft.nullable(), terminations: terminationsDraft.nullable(),
  impedance: z.discriminatedUnion("mode", [noImpedance, impedanceDraft]).nullable(), source: sourceDraft.nullable() }).strict();
export const pcbInterfaceRequirementsSchema = z.object({ schemaVersion: z.literal(PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION),
  construction: z.discriminatedUnion("mode", [noConstruction, pcbInterfaceConstructionSchema]),
  interfaces: z.array(pcbDifferentialPairRequirementSchema).min(1).max(32) }).strict();
export const pcbInterfaceRequirementsDraftSchema = pcbInterfaceRequirementsSchema.extend({
  construction: z.discriminatedUnion("mode", [noConstruction, constructionDraft]).nullable(),
  interfaces: z.array(pairDraft).max(32) }).strict();
export type PcbInterfaceRequirements = z.infer<typeof pcbInterfaceRequirementsSchema>;
export type PcbInterfaceRequirementsDraft = z.infer<typeof pcbInterfaceRequirementsDraftSchema>;
export type PcbDifferentialPairRequirement = z.infer<typeof pcbDifferentialPairRequirementSchema>;
export type PcbInterfaceConstruction = z.infer<typeof pcbInterfaceConstructionSchema>;

const key = (point: { readonly reference: string; readonly pin: string }) => `${point.reference}:${point.pin}`;
const sides = ["source", "receiver"] as const;
const polarities = ["positive", "negative"] as const;
const opposite = (polarity: typeof polarities[number]) => polarity === "positive" ? "negative" : "positive";

/** Validates declared relationships only. Caller citations never establish native or physical authority. */
export function validatePcbInterfaceRelationships(document: PcbPlaneDesignIntentDraft | PcbPlaneDesignContractPayload,
  context: z.RefinementCtx, closed: boolean): void {
  const requirements = document.interfaceRequirements;
  if (requirements == null) return;
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: "custom", path: ["interfaceRequirements", ...path], message });
  const construction = requirements.construction;
  if (construction?.mode === "two_layer" && construction.boardThicknessMm != null) {
    // Either mask convention requires the total to accommodate the two copper layers and homogeneous dielectric.
    // This does not infer the total from mask thicknesses or claim a fabrication tolerance.
    const minimum = (construction.frontCopperThicknessMm ?? 0) + (construction.backCopperThicknessMm ?? 0)
      + (construction.dielectric?.thicknessMm ?? 0);
    const roundoff = Number.EPSILON * Math.max(1, minimum, construction.boardThicknessMm) * 4;
    if (minimum - construction.boardThicknessMm > roundoff) issue(["construction", "boardThicknessMm"], "Declared board thickness cannot be less than its explicit copper and homogeneous dielectric thicknesses combined");
    const maskThickness = (side: "front" | "back") => {
      const mask = construction.solderMask?.[side];
      return mask?.kind === "absent" ? 0 : mask?.thicknessMm;
    };
    const thicknesses = [construction.frontCopperThicknessMm, construction.backCopperThicknessMm,
      construction.dielectric?.thicknessMm, maskThickness("front"), maskThickness("back")];
    if (thicknesses.every((value): value is number => value != null)
        && thicknesses.reduce((sum, value) => sum + Math.round(value * 1e6), 0) !== Math.round(construction.boardThicknessMm * 1e6))
      issue(["construction", "boardThicknessMm"], "Explicit total must equal the declared copper, homogeneous dielectric and present-mask thicknesses in the native stackup; no total is inferred or substituted");
  }
  const seenIds = new Set<string>(), usedNets = new Set<string>();
  const allNets = new Map(document.nets.map(net => [net.name, net]));
  const classes = new Map(document.netClasses.map(netClass => [netClass.id, netClass]));
  const components = new Map(document.components.map(component => [component.reference, component]));
  for (const [index, pair] of requirements.interfaces.entries()) {
    const path: PropertyKey[] = ["interfaces", index];
    if (seenIds.has(pair.id)) issue([...path, "id"], "Duplicate interface ID");
    seenIds.add(pair.id);
    if (pair.nets?.positive != null && pair.nets.positive === pair.nets.negative) issue([...path, "nets"], "Differential pair requires exactly two distinct member nets");
    const endpointKeys = new Set<string>();
    const allowedEndpoints = { positive: new Set<string>(), negative: new Set<string>() };
    const isSeries = sides.some(side => pair.terminations?.[side]?.kind === "source_series");
    if (closed && isSeries) issue([...path, "terminations"], "Source-series split-net topology is unsupported by the closed two-member-net contract");
    const inversion = pair.routing?.polarityInversion;
    if (inversion?.policy === "forbidden" && inversion.receiverMapping === "inverted") issue([...path, "routing", "polarityInversion"], "Receiver inversion is forbidden by this interface");
    if (pair.routing?.allowedLayers != null && new Set(pair.routing.allowedLayers).size !== pair.routing.allowedLayers.length) issue([...path, "routing", "allowedLayers"], "Duplicate allowed copper layer");
    for (const field of ["traceWidthMm", "edgeGapMm"] as const) {
      const interval = pair.geometry?.[field];
      if (interval?.minimumMm != null && interval.maximumMm != null && interval.minimumMm > interval.maximumMm) issue([...path, "geometry", field], "Minimum exceeds maximum");
    }
    if (pair.geometry?.maxEtchLengthMm != null) {
      if (pair.geometry.maxEtchSkewMm != null && pair.geometry.maxEtchSkewMm > pair.geometry.maxEtchLengthMm) issue([...path, "geometry", "maxEtchSkewMm"], "Etch skew budget exceeds the maximum member etch length");
      if (pair.geometry.maxUncoupledLengthMm != null && pair.geometry.maxUncoupledLengthMm > pair.geometry.maxEtchLengthMm) issue([...path, "geometry", "maxUncoupledLengthMm"], "Uncoupled length budget exceeds the maximum member etch length");
    }
    for (const polarity of polarities) {
      const name = pair.nets?.[polarity];
      const net = name == null ? undefined : allNets.get(name);
      if (name != null) {
        if (usedNets.has(name)) issue([...path, "nets", polarity], "A net cannot belong to multiple differential interfaces");
        usedNets.add(name);
        if (net === undefined) issue([...path, "nets", polarity], "Unknown differential-pair net");
        if (net?.role === "ground" || net?.role === "power" || net?.role === "power_input" || net?.role === "power_output") issue([...path, "nets", polarity], "Differential members must be signal nets");
      }
      const netClass = net?.netClassId == null ? undefined : classes.get(net.netClassId);
      const interval = pair.geometry?.traceWidthMm;
      if (netClass?.traceWidthMm != null && ((interval?.minimumMm != null && netClass.traceWidthMm < interval.minimumMm)
          || (interval?.maximumMm != null && netClass.traceWidthMm > interval.maximumMm))) issue([...path, "geometry", "traceWidthMm"], "Member net-class trace width is outside the interface interval");
      if (netClass?.clearanceMm != null && pair.geometry?.edgeGapMm?.minimumMm != null && pair.geometry.edgeGapMm.minimumMm < netClass.clearanceMm) issue([...path, "geometry", "edgeGapMm"], "Pair gap cannot weaken either member net-class clearance");
      if (pair.routing?.allowedLayers != null && netClass?.allowedLayers != null
          && pair.routing.allowedLayers.some(layer => !netClass.allowedLayers!.includes(layer))) issue([...path, "routing", "allowedLayers"], "Interface layer is forbidden by a member net class");
      const route = document.routingConstraints.nets.find(route => route.net === name);
      if (route?.topology === "plane") issue([...path, "nets", polarity], "Differential member cannot use plane topology");
      if (route != null && route.topology !== "plane") {
        if (route.maxVias != null && route.maxVias !== 0) issue([...path, "routing", "layerTransitions"], "This interface forbids all member layer transitions");
        if (route.preferredLayer != null && pair.routing?.allowedLayers != null
            && (route.preferredLayer === "either" || !pair.routing.allowedLayers.includes(route.preferredLayer))) issue([...path, "routing", "allowedLayers"], "Each member requires one exact allowed signal layer");
        if (route.referencePath != null && route.referencePath.mode !== "continuous_plane") issue([...path, "routing", "referencePlaneId"], "Differential members require explicit continuous reference-plane coverage");
        if (route.referencePath?.mode === "continuous_plane" && pair.routing?.referencePlaneId != null
            && route.referencePath.planeId != null && route.referencePath.planeId !== pair.routing.referencePlaneId) issue([...path, "routing", "referencePlaneId"], "Member reference plane differs from interface reference plane");
      }
    }
    const memberRoutes = polarities.map(polarity => document.routingConstraints.nets.find(route => route.net === pair.nets?.[polarity]));
    const memberLayers = memberRoutes.map(route => route?.topology === "plane" ? null : route?.preferredLayer).filter(layer => layer != null);
    if (new Set(memberLayers).size > 1) issue([...path, "routing", "allowedLayers"], "Pair members must use the same signal layer");
    if (pair.routing?.referencePlaneId != null && !document.planes.some(plane => plane.id === pair.routing!.referencePlaneId)) issue([...path, "routing", "referencePlaneId"], "Unknown interface reference plane");
    for (const side of sides) for (const polarity of polarities) {
      const point = pair.endpoints?.[side]?.[polarity];
      if (point == null) continue;
      if (endpointKeys.has(key(point))) issue([...path, "endpoints", side, polarity], "Every source/receiver polarity role requires a distinct physical pin");
      endpointKeys.add(key(point));
      const mapped = side === "receiver" && inversion?.receiverMapping === "inverted" ? opposite(polarity) : polarity;
      const name = pair.nets?.[mapped];
      if (side === "receiver" && inversion?.receiverMapping == null) continue;
      allowedEndpoints[mapped].add(key(point));
      if (!isSeries && name != null && !allNets.get(name)?.endpoints.some(endpoint => key(endpoint) === key(point))) issue([...path, "endpoints", side, polarity], "Endpoint role does not belong to its declared member net/polarity mapping");
      if (!components.get(point.reference)?.pins.some(pin => pin.pin === point.pin)) issue([...path, "endpoints", side, polarity], "Endpoint names an unknown component pin");
    }
    const externalComponents = new Set<string>();
    for (const side of sides) {
      const declaration = pair.terminations?.[side];
      if (declaration == null || declaration.kind === "none") continue;
      if (declaration.kind === "source_series") {
        for (const polarity of polarities) {
          const leg = declaration[polarity];
          if (leg?.componentReference == null) continue;
          const component = components.get(leg.componentReference);
          if (component === undefined) issue([...path, "terminations", side, polarity, "componentReference"], "Series declaration names an unknown component");
          if (leg.sourcePin != null && leg.sourcePin === leg.linePin) issue([...path, "terminations", side, polarity], "Series source and line roles require distinct component pins");
          for (const field of ["sourcePin", "linePin"] as const) if (leg[field] != null && component !== undefined && !component.pins.some(pin => pin.pin === leg[field]))
            issue([...path, "terminations", side, polarity, field], "Series declaration names an unknown component pin");
        }
        continue;
      }
      if (declaration.componentReference != null && !components.has(declaration.componentReference)) issue([...path, "terminations", side, "componentReference"], "Termination names an unknown component");
      if (declaration.positivePin != null && declaration.positivePin === declaration.negativePin) issue([...path, "terminations", side], "Termination polarities require distinct pins");
      if (declaration.kind === "parallel" && declaration.componentReference != null) {
        if (externalComponents.has(declaration.componentReference)) issue([...path, "terminations", side], "One external component cannot terminate both source and receiver roles");
        externalComponents.add(declaration.componentReference);
      }
      for (const polarity of polarities) {
        const terminalPin = declaration[polarity === "positive" ? "positivePin" : "negativePin"];
        if (declaration.componentReference == null || terminalPin == null) continue;
        const point = { reference: declaration.componentReference, pin: terminalPin };
        if (!components.get(point.reference)?.pins.some(pin => pin.pin === point.pin)) issue([...path, "terminations", side, `${polarity}Pin`], "Termination names an unknown component pin");
        const mapped = side === "receiver" && inversion?.receiverMapping === "inverted" ? opposite(polarity) : polarity;
        if (side === "receiver" && inversion?.receiverMapping == null) continue;
        const name = pair.nets?.[mapped];
        if (name != null && !allNets.get(name)?.endpoints.some(endpoint => key(endpoint) === key(point))) issue([...path, "terminations", side, `${polarity}Pin`], "Termination pin is not on its exact member net/polarity mapping");
        if (declaration.kind === "integrated") {
          const role = pair.endpoints?.[side]?.[polarity];
          if (role != null && key(role) !== key(point)) issue([...path, "terminations", side, `${polarity}Pin`], "Integrated termination must name the actual source/receiver role pin");
        } else {
          if (endpointKeys.has(key(point))) issue([...path, "terminations", side, `${polarity}Pin`], "External parallel termination requires its own explicit component pin");
          allowedEndpoints[mapped].add(key(point));
        }
      }
    }
    if (!isSeries && closed) for (const polarity of polarities) {
      const name = pair.nets?.[polarity];
      const net = name == null ? undefined : allNets.get(name);
      if (net !== undefined && (net.endpoints.length !== allowedEndpoints[polarity].size || net.endpoints.some(point => !allowedEndpoints[polarity].has(key(point))))) issue([...path, "nets", polarity], "Member endpoints must be exactly its source, receiver, and declared external termination pins; undeclared taps/stubs are unsupported");
      const route = document.routingConstraints.nets.find(route => route.net === name);
      if (net !== undefined && net.endpoints.length > 2 && route?.topology !== "tree") issue([...path, "terminations"], "External termination anchors require explicit tree routing on each member net");
    }
    if (pair.impedance?.mode === "differential") {
      const impedance = pair.impedance, construction = requirements.construction;
      if (impedance.targetOhms != null && impedance.toleranceOhms != null && impedance.toleranceOhms >= impedance.targetOhms) issue([...path, "impedance", "toleranceOhms"], "Impedance tolerance must leave a positive lower target bound");
      if (construction?.mode === "none") issue([...path, "impedance", "constructionId"], "Differential impedance requires an explicit two-layer construction and material source declarations");
      if (construction?.mode === "two_layer") {
        if (impedance.constructionId != null && impedance.constructionId !== construction.id) issue([...path, "impedance", "constructionId"], "Impedance references an unknown construction");
        if (impedance.frequencyHz != null && construction.dielectric?.frequencyHz != null && impedance.frequencyHz !== construction.dielectric.frequencyHz) issue([...path, "impedance", "frequencyHz"], "Dielectric properties must be explicitly supplied at the requested impedance frequency");
        for (const side of ["front", "back"] as const) {
          const mask = construction.solderMask?.[side];
          if (impedance.frequencyHz != null && mask?.kind === "present" && mask.frequencyHz != null && impedance.frequencyHz !== mask.frequencyHz) issue(["construction", "solderMask", side, "frequencyHz"], "Mask properties must be explicitly supplied at the requested impedance frequency");
        }
      }
    }
  }
}

/** These topologies are retained as intent, then explicitly declined by the bounded compiler. */
export function unsupportedPcbInterfaceRequirements(requirements: PcbPlaneDesignIntentDraft["interfaceRequirements"]): { path: string; message: string }[] {
  return requirements?.interfaces.flatMap(pair => sides.flatMap(side => pair.terminations?.[side]?.kind === "source_series"
    ? [{ path: `/interfaceRequirements/interfaces/${pair.id}/terminations/${side}`, message: "Source-series termination splits member nets. This bounded two-member-net interface topology is unsupported; preserve the source and line pin declarations for a future topology implementation." }] : [])) ?? [];
}

export function canonicalizePcbInterfaceRequirements(requirements: PcbInterfaceRequirementsDraft | PcbInterfaceRequirements | null | undefined): void {
  requirements?.interfaces.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const pair of requirements?.interfaces ?? []) pair.routing?.allowedLayers?.sort((a, b) => a === b ? 0 : a === "F.Cu" ? -1 : 1);
}

export const PCB_INTERFACE_EXECUTION_GUIDANCE = "Interface requirements are explicit caller-asserted design intent, including all material and source metadata; they are not verified physical authority. "
  + "Preserve both member nets, all four endpoint roles, receiver polarity mapping and every declared termination pin. Verify the complete source-to-receiver routes, including bends, launches, uncoupled lengths and termination placement; an isolated straight section is insufficient. "
  + "Construction is an explicit new-board declaration; it does not establish a live IPC stackup setter or fabricated material properties. Read back saved native construction before analysis. Analytical differential impedance is model-limited and is not measured impedance, device qualification, or manufacturing release. "
  + "Every interface verification row remains unknown until its independent current-source assessor provides supported evidence; compilation supplies no pass.";
