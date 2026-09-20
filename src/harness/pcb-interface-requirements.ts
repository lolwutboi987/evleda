import { z } from "zod";
import { text, number, positive, frequency, length, source, sourceDraft, pcbInterfaceConstructionSchema,
  pcbInterfaceConstructionDraftSchema as constructionDraft } from "./pcb-construction-schema.js";
export { pcbInterfaceConstructionSchema } from "./pcb-construction-schema.js";
import { pcbFourLayerConstructionSchema, pcbFourLayerConstructionDraftSchema, type PcbFourLayerConstruction } from "./pcb-four-layer-construction.js";
import { pcbDesignContractPayloadSchema } from "./pcb-design-contract.js";
import type { PcbPlaneDesignContractPayload, PcbPlaneDesignIntentDraft } from "./pcb-design-plane-contract.js";

export const PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION = "evleda.pcb-interface-requirements.v1" as const;
const common = pcbDesignContractPayloadSchema.shape;
const identifier = common.netClasses.element.shape.id;
const endpoint = common.nets.element.shape.endpoints.element;
const netName = common.nets.element.shape.name;
const reference = endpoint.shape.reference;
const pin = endpoint.shape.pin;
const layer = z.enum(["F.Cu", "B.Cu"]);
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
const channelEscape = z.object({ terminal: endpoint, traceWidthMm: interval, maximumRoutedLengthMm: positive }).strict();
const channelEscapeDraft = channelEscape.extend({ maximumRoutedLengthMm: positive.nullable() }).strict();
const channelReturn = z.object({ pin, net: netName }).strict();
const channelProtection = z.object({ componentReference: reference, positivePins: z.array(pin).min(1).max(8),
  negativePins: z.array(pin).min(1).max(8), ground: channelReturn, supply: channelReturn, source }).strict();
const channelProtectionDraft = channelProtection.extend({ source: sourceDraft.nullable() }).strict();
const transferPins = z.object({ inputPin: pin, outputPin: pin }).strict();
const transferPinsDraft = transferPins.extend({ inputPin: pin.nullable(), outputPin: pin.nullable() }).strict();
const feedThrough = z.object({ kind: z.literal("two_line_protection"), componentReference: reference, inputNets: nets,
  positive: transferPins, negative: transferPins, source }).strict();
const feedThroughDraft = feedThrough.extend({ componentReference: reference.nullable(), inputNets: netsDraft.nullable(),
  positive: transferPinsDraft.nullable(), negative: transferPinsDraft.nullable(), source: sourceDraft.nullable() }).strict();
/** Explicit bounded four-net channel. No inferred pins, internal copper, or dimensional defaults. */
const channel = z.object({ kind: z.literal("source_series"), launchNets: nets,
  additionalReceivers: z.array(roleEndpoints).min(1).max(4), protection: z.array(channelProtection).min(1).max(4),
  escapes: z.array(channelEscape).min(1).max(64), maximumLaunchEtchLengthMm: positive,
  maximumBranchEtchLengthMm: length, maxEtchLengthMm: positive, maxTotalCopperLengthMm: positive, maxEtchSkewMm: length, source,
  feedThrough: feedThrough.optional() }).strict();
const channelDraft = channel.extend({ launchNets: netsDraft.nullable(), additionalReceivers: z.array(roleEndpointsDraft).min(1).max(4).nullable(),
  protection: z.array(channelProtectionDraft).min(1).max(4).nullable(), escapes: z.array(channelEscapeDraft).min(1).max(64).nullable(), maximumLaunchEtchLengthMm: positive.nullable(),
  maximumBranchEtchLengthMm: length.nullable(), maxEtchLengthMm: positive.nullable(), maxTotalCopperLengthMm: positive.nullable(), maxEtchSkewMm: length.nullable(), source: sourceDraft.nullable(),
  feedThrough: feedThroughDraft.nullable().optional() }).strict();
const noImpedance = z.object({ mode: z.literal("none") }).strict();
const impedance = z.object({ mode: z.literal("differential"), targetOhms: positive, toleranceOhms: length,
  frequencyHz: frequency, constructionId: identifier, source }).strict();
const impedanceDraft = impedance.extend({ targetOhms: positive.nullable(), toleranceOhms: length.nullable(), frequencyHz: frequency.nullable(),
  constructionId: identifier.nullable(), source: sourceDraft.nullable() }).strict();
const noConstruction = z.object({ mode: z.literal("none") }).strict();
export const pcbDifferentialPairRequirementSchema = z.object({ id: identifier, kind: z.literal("differential_pair"), nets, endpoints,
  geometry, routing, terminations, impedance: z.discriminatedUnion("mode", [noImpedance, impedance]), source, channel: channel.optional() }).strict();
const pairDraft = pcbDifferentialPairRequirementSchema.extend({ nets: netsDraft.nullable(), endpoints: endpointsDraft.nullable(),
  geometry: geometryDraft.nullable(), routing: routingDraft.nullable(), terminations: terminationsDraft.nullable(),
  impedance: z.discriminatedUnion("mode", [noImpedance, impedanceDraft]).nullable(), source: sourceDraft.nullable(), channel: channelDraft.optional() }).strict();
export const pcbInterfaceRequirementsSchema = z.object({ schemaVersion: z.literal(PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION),
  construction: z.discriminatedUnion("mode", [noConstruction, pcbInterfaceConstructionSchema, pcbFourLayerConstructionSchema]),
  interfaces: z.array(pcbDifferentialPairRequirementSchema).min(1).max(32) }).strict();
export const pcbInterfaceRequirementsDraftSchema = pcbInterfaceRequirementsSchema.extend({
  construction: z.discriminatedUnion("mode", [noConstruction, constructionDraft, pcbFourLayerConstructionDraftSchema]).nullable(),
  interfaces: z.array(pairDraft).max(32) }).strict();
export type PcbInterfaceRequirements = z.infer<typeof pcbInterfaceRequirementsSchema>;
export type PcbInterfaceRequirementsDraft = z.infer<typeof pcbInterfaceRequirementsDraftSchema>;
export type PcbDifferentialPairRequirement = z.infer<typeof pcbDifferentialPairRequirementSchema>;
export type PcbInterfaceConstruction = z.infer<typeof pcbInterfaceConstructionSchema>;
export type PcbDeclaredInterfaceConstruction = PcbInterfaceConstruction | PcbFourLayerConstruction;

const key = (point: { readonly reference: string; readonly pin: string }) => `${point.reference}:${point.pin}`;
const sides = ["source", "receiver"] as const;
const polarities = ["positive", "negative"] as const;
const opposite = (polarity: typeof polarities[number]) => polarity === "positive" ? "negative" : "positive";

function validateChannel(document: PcbPlaneDesignIntentDraft | PcbPlaneDesignContractPayload,
  pair: NonNullable<PcbPlaneDesignIntentDraft["interfaceRequirements"]>["interfaces"][number], path: PropertyKey[],
  issue: (path: PropertyKey[], message: string) => void, closed: boolean, usedNets: Set<string>): void {
  const channel = pair.channel!;
  const transfer = channel.feedThrough, hasTransfer = transfer !== undefined;
  const fail = (field: string, message: string) => issue([...path, "channel", field], message);
  const series = pair.terminations?.source;
  if (series != null && series.kind !== "source_series") fail("kind", "Bounded channel requires source_series at its source");
  if (pair.terminations?.receiver != null && pair.terminations.receiver.kind !== "none") fail("kind", "Bounded source-series channel requires an explicit unterminated receiver");
  if (pair.routing?.polarityInversion?.receiverMapping === "inverted") fail("kind", "Bounded source-series channels require preserved receiver polarity");
  const names = [...polarities.map(p => pair.nets?.[p]), ...polarities.map(p => channel.launchNets?.[p]),
    ...(hasTransfer ? polarities.map(p => transfer?.inputNets?.[p]) : [])].filter((n): n is string => n != null);
  if (new Set(names).size !== names.length) fail("launchNets", hasTransfer ? "Feed-through channel requires exactly six distinct signal nets" : "Channel requires exactly four distinct signal nets");
  const protectionNet = (componentReference: string, pin: string, polarity: typeof polarities[number]) => !hasTransfer ? pair.nets?.[polarity]
    : transfer?.componentReference !== componentReference ? undefined : pin === transfer[polarity]?.inputPin ? transfer.inputNets?.[polarity]
      : pin === transfer[polarity]?.outputPin ? pair.nets?.[polarity] : undefined;
  if (hasTransfer) {
    if (channel.protection != null && channel.protection.length !== 1) fail("feedThrough", "Initial feed-through support requires exactly one two-line protection stage");
    const protection = channel.protection?.[0];
    if (transfer?.componentReference != null && protection != null && protection.componentReference !== transfer.componentReference) fail("feedThrough", "Feed-through must name the exact declared protection component");
    for (const polarity of polarities) {
      const leg = transfer?.[polarity], declared = protection?.[polarity === "positive" ? "positivePins" : "negativePins"];
      if (leg?.inputPin != null && leg.outputPin != null && (leg.inputPin === leg.outputPin || declared != null
        && (declared.length !== 2 || !declared.includes(leg.inputPin) || !declared.includes(leg.outputPin)))) fail("feedThrough", "Each transfer must map the complete distinct protection input/output pin pair");
    }
    if (closed && transfer != null && protection != null) {
      const component = document.components.find(value => value.reference === transfer.componentReference);
      const pins = [...protection.positivePins, ...protection.negativePins, protection.ground.pin, protection.supply.pin];
      if (component?.pins.length !== 6 || component.pins.some(value => !pins.includes(value.pin))) fail("feedThrough", "The bounded transfer requires the exact complete six-pin protection component");
    }
  }
  const allowed = new Map(names.map(name => [name, new Set<string>()]));
  const nets = new Map(document.nets.map(net => [net.name, net]));
  const add = (name: string | null | undefined, point: { reference: string; pin: string } | null | undefined, field: string) => {
    if (name == null || point == null) return;
    const members = allowed.get(name)!;
    if (members.has(key(point))) fail(field, "Every channel signal anchor must be explicitly distinct");
    members.add(key(point));
    if (!nets.get(name)?.endpoints.some(p => key(p) === key(point))) fail(field, "Channel anchor is not a member of its exact declared polarity and section net");
  };
  for (const polarity of polarities) {
    const launch = channel.launchNets?.[polarity], line = pair.nets?.[polarity], input = hasTransfer ? transfer?.inputNets?.[polarity] : line;
    add(launch, pair.endpoints?.source?.[polarity], "launchNets");
    add(line, pair.endpoints?.receiver?.[polarity], "additionalReceivers");
    if (series?.kind === "source_series") {
      const leg = series[polarity];
      if (leg?.componentReference != null && leg.sourcePin != null) add(launch, { reference: leg.componentReference, pin: leg.sourcePin }, "launchNets");
      if (leg?.componentReference != null && leg.linePin != null) add(input, { reference: leg.componentReference, pin: leg.linePin }, "launchNets");
    }
    for (const receiver of channel.additionalReceivers ?? []) add(line, receiver[polarity], "additionalReceivers");
    for (const protection of channel.protection ?? []) for (const pin of protection[polarity === "positive" ? "positivePins" : "negativePins"])
      add(protectionNet(protection.componentReference, pin, polarity), { reference: protection.componentReference, pin }, "protection");
    if (launch != null) {
      if (usedNets.has(launch)) fail("launchNets", "A net cannot belong to multiple differential interfaces");
      usedNets.add(launch);
    }
    if (hasTransfer && input != null) {
      if (usedNets.has(input)) fail("feedThrough", "A net cannot belong to multiple differential interfaces");
      usedNets.add(input);
    }
  }
  if (series?.kind === "source_series" && series.positive?.componentReference != null
      && series.positive.componentReference === series.negative?.componentReference) fail("launchNets", "Each source-series leg requires its own resistor component");
  const layers = new Set<string>();
  for (const name of names) {
    const net = nets.get(name), route = document.routingConstraints.nets.find(route => route.net === name);
    if (net === undefined || net.role != null && ["ground", "power", "power_input", "power_output"].includes(net.role)) fail("launchNets", "Every channel member must be an explicit signal net");
    if (closed && net && (net.endpoints.length !== allowed.get(name)!.size || net.endpoints.some(p => !allowed.get(name)!.has(key(p)))))
      fail("launchNets", "Channel net endpoints must exactly equal all declared anchors; undeclared taps are unsupported");
    if (net && net.endpoints.length > 2 && route?.topology !== "tree") fail("launchNets", "Multiple channel anchors require explicit tree routing");
    if (route?.topology === "plane") fail("launchNets", "Channel signal cannot use plane topology");
    if (route && route.topology !== "plane") {
      if (route.maxVias != null && route.maxVias !== 0) fail("launchNets", "Channel routes forbid vias");
      if (route.preferredLayer != null) {
        layers.add(route.preferredLayer);
        if (route.preferredLayer !== "F.Cu" && route.preferredLayer !== "B.Cu"
          || pair.routing?.allowedLayers != null && !pair.routing.allowedLayers.some(layer => layer === route.preferredLayer)) fail("launchNets", "Each channel net requires the same exact allowed outer signal layer");
      }
      if (route.referencePath?.mode !== "continuous_plane" && (closed || route.referencePath != null)) fail("launchNets", "All four channel nets require continuous reference-plane paths");
      if (route.referencePath?.mode === "continuous_plane" && route.referencePath.planeId != null && route.referencePath.planeId !== pair.routing?.referencePlaneId)
        fail("launchNets", "All channel reference paths must name the interface plane");
    }
    const cls = document.netClasses.find(cls => cls.id === net?.netClassId);
    if (cls?.traceWidthMm != null && pair.geometry?.traceWidthMm != null
        && (pair.geometry.traceWidthMm.minimumMm != null && cls.traceWidthMm < pair.geometry.traceWidthMm.minimumMm
          || pair.geometry.traceWidthMm.maximumMm != null && cls.traceWidthMm > pair.geometry.traceWidthMm.maximumMm)) fail("launchNets", "Channel class width must remain inside the body interval");
    if (cls?.clearanceMm != null && pair.geometry?.edgeGapMm?.minimumMm != null && cls.clearanceMm > pair.geometry.edgeGapMm.minimumMm) fail("launchNets", "Channel gap cannot weaken any member class clearance");
    if (cls?.allowedLayers != null && pair.routing?.allowedLayers?.some(layer => !cls.allowedLayers!.includes(layer))) fail("launchNets", "Channel allowed layer is forbidden by a member class");
  }
  if (layers.size > 1) fail("launchNets", "All four channel nets must use the same signal layer");
  const plane = document.planes.find(plane => plane.id === pair.routing?.referencePlaneId);
  for (const protection of channel.protection ?? []) {
    const pins = [...protection.positivePins, ...protection.negativePins, protection.ground.pin, protection.supply.pin];
    if (new Set(pins).size !== pins.length) fail("protection", "Protection signal, ground and supply pins must be distinct");
    for (const role of ["ground", "supply"] as const) {
      const declared = protection[role], net = nets.get(declared.net);
      if (!net?.endpoints.some(p => p.reference === protection.componentReference && p.pin === declared.pin)) fail("protection", "Protection return anchor must belong to its exact declared net");
      if (role === "ground" && (net?.role !== "ground" || plane != null && declared.net !== plane.net)) fail("protection", "Protection ground must use the declared ground reference plane net");
      if (role === "supply" && (net == null || !["power", "power_input", "power_output"].includes(net.role ?? ""))) fail("protection", "Protection supply requires a declared power net");
    }
  }
  for (const protection of channel.protection ?? []) for (const polarity of polarities) {
    for (const pin of protection[polarity === "positive" ? "positivePins" : "negativePins"]) {
      const route = document.routingConstraints.nets.find(route => route.net === protectionNet(protection.componentReference, pin, polarity));
      if (route?.topology !== "plane" && route?.referencePath?.mode === "continuous_plane") {
      const references = route.referencePath.terminalReferences;
      if (references != null && !references.some(r => r.signalEndpoint?.reference === protection.componentReference && r.signalEndpoint.pin === pin
        && r.referenceEndpoint?.reference === protection.componentReference && r.referenceEndpoint.pin === protection.ground.pin))
        fail("protection", "Every protection signal requires its exact declared ground anchor in the continuous reference path");
      }
    }
  }
  const escapeKeys = new Set<string>();
  const anchorsKnown = polarities.every(p => pair.nets?.[p] != null && channel.launchNets?.[p] != null
    && pair.endpoints?.source?.[p] != null && pair.endpoints?.receiver?.[p] != null
    && series?.kind === "source_series" && series[p]?.componentReference != null && series[p]?.sourcePin != null && series[p]?.linePin != null)
    && channel.additionalReceivers != null && channel.additionalReceivers.every(r => r.positive != null && r.negative != null) && channel.protection != null
    && (!hasTransfer || transfer?.componentReference != null && polarities.every(p => transfer.inputNets?.[p] != null && transfer[p]?.inputPin != null && transfer[p]?.outputPin != null));
  for (const escape of channel.escapes ?? []) {
    const name = key(escape.terminal), interval = escape.traceWidthMm;
    if (escapeKeys.has(name) || anchorsKnown && ![...allowed.values()].some(members => members.has(name))) fail("escapes", "Escape requires one unique declared channel signal terminal");
    escapeKeys.add(name);
    if (interval.minimumMm < 0.2 || interval.minimumMm > interval.maximumMm || pair.geometry?.traceWidthMm?.maximumMm != null && interval.maximumMm > pair.geometry.traceWidthMm.maximumMm)
      fail("escapes", "Escape interval must be ordered, at least 0.2 mm, and no wider than the body maximum");
  }
  if (pair.geometry?.traceWidthMm?.minimumMm != null && pair.geometry.traceWidthMm.minimumMm < 0.2) fail("escapes", "Channel body width must preserve the native 0.2 mm floor");
  if (channel.maxEtchLengthMm != null && channel.maxEtchSkewMm != null && channel.maxEtchSkewMm > channel.maxEtchLengthMm) fail("maxEtchSkewMm", "Channel skew budget exceeds its etch budget");
}

/** Validates declared relationships only. Caller citations never establish native or physical authority. */
export function validatePcbInterfaceRelationships(document: PcbPlaneDesignIntentDraft | PcbPlaneDesignContractPayload,
  context: z.RefinementCtx, closed: boolean): void {
  const requirements = document.interfaceRequirements;
  if (requirements == null) return;
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: "custom", path: ["interfaceRequirements", ...path], message });
  const construction = requirements.construction;
  if (construction?.mode === "four_layer" && document.scope.board.layerCount !== 4
    || construction?.mode === "two_layer" && document.scope.board.layerCount !== 2) {
    issue(["construction", "mode"], "Physical construction layer count differs from the board scope");
  }
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
    if (closed && isSeries && pair.channel === undefined) issue([...path, "terminations"], "Source-series split-net topology is unsupported without an explicit bounded four-net channel");
    if (pair.channel !== undefined) validateChannel(document, pair, path, issue, closed, usedNets);
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
            && (route.preferredLayer !== "F.Cu" && route.preferredLayer !== "B.Cu"
              || !pair.routing.allowedLayers.some(layer => layer === route.preferredLayer))) issue([...path, "routing", "allowedLayers"], "Each member requires one exact allowed outer signal layer");
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
      if (construction?.mode === "none") issue([...path, "impedance", "constructionId"], "Differential impedance requires an explicit construction and material source declarations");
      if (construction?.mode === "two_layer" || construction?.mode === "four_layer") {
        if (impedance.constructionId != null && impedance.constructionId !== construction.id) issue([...path, "impedance", "constructionId"], "Impedance references an unknown construction");
        const dielectrics = construction.mode === "two_layer" ? [construction.dielectric] : [construction.frontDielectric, construction.coreDielectric, construction.backDielectric];
        if (impedance.frequencyHz != null && dielectrics.some(d => d?.frequencyHz != null && impedance.frequencyHz !== d.frequencyHz)) issue([...path, "impedance", "frequencyHz"], "Dielectric properties must be explicitly supplied at the requested impedance frequency");
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
  return requirements?.interfaces.flatMap(pair => sides.flatMap(side => pair.terminations?.[side]?.kind === "source_series" && (pair.channel === undefined || side !== "source")
    ? [{ path: `/interfaceRequirements/interfaces/${pair.id}/terminations/${side}`, message: "Source-series termination splits member nets. This bounded two-member-net interface topology is unsupported; preserve the source and line pin declarations for a future topology implementation." }] : [])) ?? [];
}

export function canonicalizePcbInterfaceRequirements(requirements: PcbInterfaceRequirementsDraft | PcbInterfaceRequirements | null | undefined): void {
  requirements?.interfaces.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const pair of requirements?.interfaces ?? []) pair.routing?.allowedLayers?.sort((a, b) => a === b ? 0 : a === "F.Cu" ? -1 : 1);
  for (const pair of requirements?.interfaces ?? []) if (pair.channel) {
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    // An unknown positive selector has no stable collection key yet; preserve
    // numeric unresolved-path binding until every receiver can be keyed.
    if (pair.channel.additionalReceivers?.every(receiver => receiver.positive != null))
      pair.channel.additionalReceivers.sort((a, b) => compare(key(a.positive!), key(b.positive!)));
    pair.channel.protection?.sort((a, b) => compare(a.componentReference, b.componentReference));
    for (const protection of pair.channel.protection ?? []) { protection.positivePins.sort(compare); protection.negativePins.sort(compare); }
    pair.channel.escapes?.sort((a, b) => compare(key(a.terminal), key(b.terminal)));
  }
}

export const PCB_CHANNEL_EXECUTION_GUIDANCE = "The explicit source-series channel retains four signal nets, both resistor pins, every connector contact and protection pin. Measure the launch and every receiver path and aggregate copper-only channel lengths and skew, including branches. Variable widths are limited to declared terminal-bound routed escapes; an incomplete route may use only the union of its explicit width intervals. Final assessment must prove each narrow edge's routed distance to its exact terminal, all opposite-polarity gaps across all four nets, and continuous reference coverage of all four nets. Resistor and protection internals are not imaginary PCB segments. Uniform-section impedance never establishes whole-channel coverage or physical compliance.";

export const PCB_INTERFACE_EXECUTION_GUIDANCE = "Interface requirements are explicit caller-asserted design intent, including all material and source metadata; they are not verified physical authority. "
  + "Preserve both member nets, all four endpoint roles, receiver polarity mapping and every declared termination pin. Verify the complete source-to-receiver routes, including bends, launches, uncoupled lengths and termination placement; an isolated straight section is insufficient. "
  + "Construction is an explicit new-board declaration; it does not establish a live IPC stackup setter or fabricated material properties. Read back saved native construction before analysis. Analytical differential impedance is model-limited and is not measured impedance, device qualification, or manufacturing release. "
  + "Every interface verification row remains unknown until its independent current-source assessor provides supported evidence; compilation supplies no pass.";
