import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { bindKicadPhysicalFootprintLibraries, verifyHostKicadNativePadObservation,
  type KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import { parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { assessCopperCommon, type NativePadClusterCapture, type PhysicalPad } from "./fresh-pcb-pad-model.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

type Pin = NonNullable<KicadNativePadObservationExpected["physicalFootprints"]>[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const assessedConnectivity = new WeakSet<object>();
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Plane connectivity: ${message}`); }
export interface FreshPlaneConnectivityInput {
  readonly compilationBundle: PcbPlaneCompilationBundle;
  /** Exact current saved source/path supplied under the calling host's read/recheck guard. */
  readonly pcbPath: string;
  readonly pcbSource: string;
  /** Current marker/project authority. A cached or stage-only scope is not a substitute. */
  readonly scopeIdentity: CanonicalIdentity;
  readonly physicalFootprints: readonly Pin[];
  readonly physicalFootprintResolver: NonNullable<KicadNativePadObservationExpected["physicalFootprintResolver"]>;
}
export interface FreshPlaneConnectivityEndpointRequest {
  readonly net: string;
  readonly reference: string;
  readonly pin: string;
  /** All source members are requested individually; native evidence determines eligibility. */
  readonly physicalPadUuids: readonly string[];
}

/** Builds an exact native request from V2 plus pre-approved physical library pins. No collection or filesystem read. */
export function prepareFreshPlaneConnectivity(input: FreshPlaneConnectivityInput) {
  const bundle = input.compilationBundle;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "an authenticated actual V2 bundle is required");
  const scope = input.scopeIdentity;
  requireValue(scope.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(scope.digest) && scope.canonicalizationVersion === "evleda-c14n-json-v1"
    && typeof scope.schemaVersion === "string" && scope.schemaVersion.length > 0, "current host scope identity is invalid");
  const board = parseFreshPcbSource(input.pcbSource), pins = input.physicalFootprints;
  requireValue(pins.length === bundle.contract.components.length && new Set(pins.map(pin => pin.reference)).size === pins.length
    && pins.every(pin => bundle.contract.components.some(component => component.reference === pin.reference && component.footprintLibId === pin.libraryId)
      && bundle.libraryBinding.footprints.some(footprint => footprint.reference === pin.reference && footprint.libraryId === pin.libraryId)
      && pin.sourceIdentity.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(pin.sourceIdentity.digest) && Number.isSafeInteger(pin.sourceIdentity.size) && pin.sourceIdentity.size > 0),
  "complete approved physical library pins must match the actual V2 component/library binding");
  for (const pin of pins) {
    const inspected = input.physicalFootprintResolver.inspectFootprint(pin.libraryId), compiled = bundle.libraryBinding.footprints.find(footprint => footprint.reference === pin.reference)!;
    requireValue(inspected !== null && same(inspected.sourceIdentity, pin.sourceIdentity)
      && same(inspected.pads.map(pad => pad.number).sort(), [...compiled.pads].sort()), "approved physical library logical terminals differ from the compiled V2 library binding");
  }
  const physicalFootprints = freezePcbPlaneArtifact(pins.map(pin => ({ reference: pin.reference, libraryId: pin.libraryId, sourceIdentity: { ...pin.sourceIdentity } })));
  const endpointRequests: FreshPlaneConnectivityEndpointRequest[] = bundle.contract.nets.flatMap(net => net.endpoints.map(endpoint => {
    const footprints = board.footprints.filter(footprint => footprint.reference === endpoint.reference);
    requireValue(footprints.length === 1, `saved endpoint footprint ${endpoint.reference} is missing or ambiguous`);
    const members = footprints[0]!.pads.filter(pad => pad.number === endpoint.pin);
    requireValue(members.length > 0 && members.every(pad => pad.physical.id !== null && UUID.test(pad.physical.id)), `saved ${endpoint.reference}:${endpoint.pin} has missing or unbound physical members`);
    return { net: net.name, reference: endpoint.reference, pin: endpoint.pin, physicalPadUuids: members.map(pad => pad.physical.id!) };
  }));
  const requestedPrimitiveIds = endpointRequests.flatMap(endpoint => endpoint.physicalPadUuids);
  requireValue(requestedPrimitiveIds.length > 0 && requestedPrimitiveIds.length <= 512 && new Set(requestedPrimitiveIds).size === requestedPrimitiveIds.length,
    "complete individual endpoint query inventory is duplicate or outside the current native capture bound");
  const sourceIdentity = contentIdentity(input.pcbSource);
  const binding = { schemaVersion: "evleda.fresh-plane-connectivity-scope.v1" as const, bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity,
    libraryBindingIdentity: bundle.libraryBinding.identity, verificationPlanIdentity: bundle.verificationPlan.identity,
    hostScopeIdentity: { ...scope }, sourceIdentity, pcbPath: input.pcbPath, physicalFootprints, endpointRequests };
  const nativePadExpected: KicadNativePadObservationExpected = Object.freeze({ pcbPath: input.pcbPath, pcbSource: input.pcbSource,
    requestedPrimitiveIds: Object.freeze(requestedPrimitiveIds), enabledCopperLayers: bundle.contract.scope.board.copperLayers,
    scopeIdentity: canonicalIdentity(binding, binding.schemaVersion), physicalFootprints, physicalFootprintResolver: input.physicalFootprintResolver });
  const physicalLibraryBindings = bindKicadPhysicalFootprintLibraries(board, nativePadExpected);
  const payload = { ...binding, physicalLibraryBindings,
    physicalLibraryBindingIdentity: canonicalIdentity(physicalLibraryBindings, "evleda.fresh-plane-connectivity-physical-libraries.v1") };
  // The approved resolver is a host capability, not serialized evidence. The
  // identity binds its verified source/physical outputs, never a function name.
  return Object.freeze({ ...freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, "evleda.fresh-plane-connectivity-request.v1") }), nativePadExpected });
}

type NetStatus = "connected" | "disconnected" | "needs-review" | "unsupported" | "invalid-evidence";
const usable = (pad: PhysicalPad) => pad.role === "numbered-copper" && pad.issues.length === 0
  && pad.observedUsableCopperLayers !== null && pad.observedUsableCopperLayers.length > 0;

/** Assess only saved-source native PAD reachability; no V1/LED acceptance is invoked. */
export function assessFreshPlaneConnectivity(input: FreshPlaneConnectivityInput & { readonly nativePads: unknown }) {
  // Recompute against CURRENT caller-bound source/scope/library pins. A prior
  // preparation result cannot override a changed saved source or library.
  const prepared = prepareFreshPlaneConnectivity(input);
  const observation = verifyHostKicadNativePadObservation(input.nativePads, prepared.nativePadExpected);
  const inventory = observation.inventory;
  requireValue(inventory !== null && same(observation.physicalLibraryBindings, prepared.physicalLibraryBindings), "complete current source-pinned physical inventory is required");
  const physical = new Map(inventory.physicalPads.map(pad => [pad.uuid, pad]));
  const queryBySource = new Map(observation.clusters.queries.map(query => [query.sourceUuids[0]!, query]));
  requireValue(observation.clusters.queries.length === prepared.nativePadExpected.requestedPrimitiveIds.length
    && queryBySource.size === observation.clusters.queries.length
    && observation.clusters.queries.every((query, index) => query.sourceUuids.length === 1 && query.sourceUuids[0] === prepared.nativePadExpected.requestedPrimitiveIds[index]
      && query.status === "complete" && same(query.filterTypes, ["KOT_PCB_PAD"])), "every endpoint physical member requires its own complete ordered PAD-filtered query");
  const nets = input.compilationBundle.contract.nets.map(net => {
    const requests = prepared.endpointRequests.filter(endpoint => endpoint.net === net.name), allIds = requests.flatMap(endpoint => endpoint.physicalPadUuids), allowed = new Set(allIds);
    const capture: NativePadClusterCapture = { source: observation.clusters.source, queries: allIds.map(id => queryBySource.get(id)!) };
    const reasons: string[] = [], invalidReturnedPhysicalPadUuids = new Set<string>();
    let invalid = false, unsupported = false;
    const endpoints = requests.map(request => {
      const matches = inventory.terminals.filter(terminal => terminal.reference === request.reference && terminal.number === request.pin);
      const terminal = matches.length === 1 ? matches[0]! : null;
      const sourceMembers = request.physicalPadUuids.map(id => physical.get(id));
      const wrongNet = sourceMembers.some(pad => pad?.netName !== net.name);
      if (wrongNet) { invalid = true; reasons.push(`${request.reference}:${request.pin} has a physical member assigned to a different or missing net.`); }
      const eligiblePhysicalPadUuids = sourceMembers.filter((pad): pad is PhysicalPad => pad !== undefined && usable(pad) && pad.netName === net.name).map(pad => pad.uuid);
      const membershipMatches = terminal !== null && same([...terminal.physicalPadUuids].sort(), [...request.physicalPadUuids].sort());
      if (!membershipMatches || !terminal?.eligibleForPinMatching || eligiblePhysicalPadUuids.length !== request.physicalPadUuids.length) {
        unsupported = true; reasons.push(`${request.reference}:${request.pin} has unresolved physical-terminal or native copper-layer eligibility.`);
      }
      const assessed = terminal === null ? null : assessCopperCommon(inventory, { terminalKey: terminal.key, requiredPhysicalPadUuids: request.physicalPadUuids }, capture);
      // The complete source-bound query capture is retained once per net below,
      // rather than copying it into every same-net endpoint subfinding.
      const copperCommon = assessed === null ? null : (({ capture: _capture, ...summary }) => summary)(assessed);
      if (copperCommon?.status === "invalid-evidence" || copperCommon?.status === "unproven") invalid = true;
      return { ...request, terminalKey: terminal?.key ?? null, eligiblePhysicalPadUuids,
        ineligiblePhysicalPadUuids: request.physicalPadUuids.filter(id => !eligiblePhysicalPadUuids.includes(id)),
        nativeCopperCommon: copperCommon, componentInternalConnectivity: "not-inferred" as const };
    });
    const sets = capture.queries.map(query => new Set(query.returnedPadUuids));
    for (const [index, query] of capture.queries.entries()) {
      if (!sets[index]!.has(query.sourceUuids[0]!) || sets[index]!.size !== query.returnedPadUuids.length) { invalid = true; reasons.push("Native cluster omits its source or duplicates a physical UUID."); }
      for (const id of query.returnedPadUuids) {
        const pad = physical.get(id);
        if (!allowed.has(id) || pad === undefined || !usable(pad) || pad.netName !== net.name) {
          invalid = true; invalidReturnedPhysicalPadUuids.add(id);
        }
      }
      for (let previous = 0; previous < index; previous++) {
        const a = sets[previous]!, b = sets[index]!;
        if ([...a].some(id => b.has(id)) && (a.size !== b.size || [...a].some(id => !b.has(id)))) {
          invalid = true; reasons.push("Intersecting complete individually sourced clusters are incomplete or asymmetric.");
        }
      }
    }
    if (invalidReturnedPhysicalPadUuids.size) reasons.push("Native reachability returned wrong-net, uncontracted, unknown or ineligible physical terminals.");
    const components = [...new Map(sets.map(set => { const members = [...set].sort(); return [canonicalJson(members), members] as const; })).values()];
    const commonComponents = components.filter(component => endpoints.every(endpoint => endpoint.eligiblePhysicalPadUuids.some(id => component.includes(id))));
    const logicalReachability = invalid ? "invalid-evidence" as const : unsupported ? "unproven" as const : commonComponents.length > 0 ? "reachable" as const : "disconnected" as const;
    const everyMemberReachable = !invalid && !unsupported && components.some(component => allIds.every(id => component.includes(id)));
    const status: NetStatus = invalid ? "invalid-evidence" : unsupported ? "unsupported" : commonComponents.length === 0 ? "disconnected" : everyMemberReachable ? "connected" : "needs-review";
    if (status === "needs-review") reasons.push("Logical endpoints share a copper component, but some same-terminal physical members remain separate; no internal tie or universal short requirement is inferred.");
    return { net: net.name, topology: input.compilationBundle.contract.routingConstraints.nets.find(route => route.net === net.name)!.topology,
      status, reasons: [...new Set(reasons)], endpoints, logicalEndpointReachability: { status: logicalReachability, commonComponents: commonComponents.map(component => ({ physicalPadUuids: component,
        endpoints: endpoints.map(endpoint => ({ reference: endpoint.reference, pin: endpoint.pin,
          contributingPhysicalPadUuids: endpoint.eligiblePhysicalPadUuids.filter(id => component.includes(id)),
          separatedPhysicalPadUuids: endpoint.eligiblePhysicalPadUuids.filter(id => !component.includes(id)) })) })) },
      everyEligiblePhysicalMemberReachable: everyMemberReachable, observedComponents: components,
      invalidReturnedPhysicalPadUuids: [...invalidReturnedPhysicalPadUuids], nativeQueries: capture.queries };
  });
  const status = nets.some(net => net.status === "invalid-evidence") ? "invalid-evidence" : nets.some(net => net.status === "unsupported") ? "incomplete"
    : nets.some(net => net.status === "needs-review") ? "needs-review" : nets.every(net => net.status === "connected") ? "connected"
      : nets.some(net => net.status === "connected") ? "partially-connected" : "disconnected";
  const payload = { schemaVersion: "evleda.fresh-plane-connectivity.v1" as const, family: "plane-v2" as const, status,
    bundleIdentity: prepared.bundleIdentity, contractIdentity: prepared.contractIdentity, libraryBindingIdentity: prepared.libraryBindingIdentity,
    verificationPlanIdentity: prepared.verificationPlanIdentity, hostScopeIdentity: prepared.hostScopeIdentity,
    requestIdentity: prepared.identity, physicalLibraryBindingIdentity: prepared.physicalLibraryBindingIdentity, physicalLibraryBindings: prepared.physicalLibraryBindings,
    savedSourceIdentity: prepared.sourceIdentity, nativeSourceIdentity: observation.nativePcbIdentity, nativeObservationIdentity: observation.rawEnvelopeIdentity,
    nativeExpectedIdentity: observation.expectedIdentity, evidenceSource: observation.clusters.source, nets,
    nativePhysicalInventoryIdentity: canonicalIdentity(inventory, inventory.schemaVersion),
    limitations: { evidence: "host-collected-native-PAD-reachability-on-exact-saved-source" as const, currentFileGuard: "required-of-caller" as const,
      intendedPlaneContact: "not_evaluated" as const, fillFreshness: "not_established" as const, singlePlaneComponent: "not_evaluated" as const,
      thermalContacts: "not_evaluated" as const, islandPolicy: "not_evaluated" as const, routeTopologyAndGeometry: "not_evaluated" as const,
      crossNetShortAbsence: "not_established-by-native-connectivity-traversal" as const, nativeDrcAndClearance: "not_evaluated" as const,
      highFrequencyValidity: "not_established" as const, componentInternalConnectivity: "not_inferred" as const },
    verificationPlanRowsPassed: [] as readonly string[], acceptanceEvaluated: false, fabricationAuthorized: false };
  const result = freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  assessedConnectivity.add(result); return result;
}

export type FreshPlaneConnectivityAssessment = ReturnType<typeof assessFreshPlaneConnectivity>;
/** A serialized/self-rehashed summary is not host-collected native endpoint authority. */
export function isFreshPlaneConnectivityAssessment(value: unknown): value is FreshPlaneConnectivityAssessment {
  return value !== null && typeof value === "object" && assessedConnectivity.has(value);
}
