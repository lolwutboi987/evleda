import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { collectPlaneBridgeSource } from "./plane-region-bridge-source.js";
import { planReferenceTerminalLaunchStudy, ReferenceTerminalLaunchPlanningError } from "./reference-terminal-launch-study.js";
import { boundRetainedPlaneRegionAreas, findPlaneRegionAnnulusWitnesses } from "./plane-region-annulus-witness.js";
import { channelMemberNets } from "./pcb-channel-width.js";
import { assertPcbBoardFeatureInventory } from "./pcb-board-features.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { isKicadPlaneContactsObservation, type KicadPlaneContactsObservation } from "../integrations/kicad-plane-contacts.js";
import { isReferenceCoverageCalculator, referenceCoverageRequestSchema, type ReferenceCoverageCalculator } from "../integrations/kicad-reference-coverage.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import { assertFreshPlaneReferenceCopperScope } from "./fresh-clearance-evidence.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbRouteSourceSpans, parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { isFreshPlaneConnectivityAssessment, type FreshPlaneConnectivityAssessment } from "./fresh-plane-connectivity.js";
import { assessFreshPlaneCommonChecks, type FreshPlaneCommonChecksAssessment } from "./fresh-plane-common-checks.js";
import { isSavedFreshPlaneEvidence, type SavedFreshPlaneEvidence } from "./fresh-plane-evidence.js";
import { assessFreshPlaneFilledGeometry } from "./fresh-plane-filled-geometry.js";
import { assessFreshPlaneDrillTopology } from "./fresh-plane-drill-topology.js";
import { isFreshPlaneNativeChecksAssessment, type FreshPlaneNativeChecksAssessment } from "./fresh-plane-native-checks.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { resolveFreshPlaneSourceZones, assertFreshPlaneDeclaredZoneSettings } from "./fresh-plane-mutation.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { assessSavedInterface, SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION, type SavedInterfaceAssessment } from "./saved-interface-assessment.js";

export interface FreshPlaneAcceptanceInput {
  readonly compilationBundle: PcbPlaneCompilationBundle;
  readonly pcbSource: string;
  readonly projectSettingsSource: string;
  readonly rulesSource: string;
  /** Current-session authority. Historical saved caches cannot replace this witness. */
  readonly savedEvidence: SavedFreshPlaneEvidence | null;
  readonly endpointConnectivity: FreshPlaneConnectivityAssessment;
  readonly nativeContacts?: KicadPlaneContactsObservation;
  readonly nativeChecks?: FreshPlaneNativeChecksAssessment;
  readonly referenceCoverage?: ReferenceCoverageCalculator;
  /** Host factory capability only; the saved-interface assessor authenticates it. */
  readonly transmissionLine?: KicadTransmissionLineCalculator;
}
type Status = "verified" | "failed" | "unknown";
interface Fact { readonly status: Status; readonly reasons: readonly string[] }
interface Row { readonly id: string; readonly kind: PcbPlaneCompilationBundle["verificationPlan"]["requirements"][number]["kind"];
  readonly status: "pass" | "fail" | "unknown"; readonly reasons: readonly string[] }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const fact = (status: Status, ...reasons: string[]): Fact => ({ status, reasons });
// A supported counterexample remains a failure even when another prerequisite
// cannot be evaluated. Unknown evidence can never be promoted to a pass.
const allFacts = (values: readonly Fact[]): Fact => fact(values.some(value => value.status === "failed") ? "failed"
  : values.length > 0 && values.every(value => value.status === "verified") ? "verified" : "unknown", ...values.flatMap(value => value.reasons));
const interfaceFact = (status: string, pass: readonly string[], fail: readonly string[], reasons: readonly (string | { readonly code: string; readonly message: string })[]): Fact =>
  fact(fail.includes(status) ? "failed" : pass.includes(status) ? "verified" : "unknown",
    ...reasons.map(reason => typeof reason === "string" ? reason : `${reason.code}: ${reason.message}`));
export interface FreshPlaneInterfaceAcceptance {
  readonly interfaceId: string;
  readonly assessmentIdentity: CanonicalIdentity;
  readonly construction: Fact;
  readonly topology: Fact;
  readonly pairGeometry: Fact;
  readonly termination: Fact;
  readonly impedance: Fact;
  readonly referenceCoverage: Fact & { readonly planeId: string; readonly memberNets: readonly string[]; readonly referenceRowIds: readonly string[] };
}
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Plane acceptance: ${reason}`); }
function names(values: readonly string[]): string[] { return [...values].sort(); }
function unique(values: readonly string[], label: string) { requireValue(new Set(values).size === values.length, `${label} contains duplicate identities`); }
function exactIdentity(value: { readonly identity: CanonicalIdentity }, schema: string) {
  const { identity, ...payload } = value; requireValue(same(identity, canonicalIdentity(payload, schema)), `${schema} identity does not reproduce`);
}
/** Exact decimal conversion: no binary-floating tolerance or rounding. */
function scaledFraction(value: number, places: number): { numerator: bigint; denominator: bigint } {
  const text = String(value), m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/u.exec(text);
  requireValue(Number.isFinite(value) && !Object.is(value, -0) && m !== null, "invalid exact decimal contract quantity");
  const exponent = Number(m[3] ?? 0), power = places + exponent - (m[2]?.length ?? 0);
  requireValue(Number.isSafeInteger(exponent) && Math.abs(power) <= 100, "contract quantity exponent exceeds bounds");
  const result = BigInt(m[1]! + (m[2] ?? ""));
  return power >= 0 ? { numerator: result * 10n ** BigInt(power), denominator: 1n }
    : { numerator: result, denominator: 10n ** BigInt(-power) };
}
function scaledInteger(value: number, places: number): bigint {
  const { numerator, denominator } = scaledFraction(value, places);
  requireValue(numerator % denominator === 0n, "contract quantity is not exactly representable"); return numerator / denominator;
}
function decimal(numerator: bigint, denominator: bigint): string {
  const whole = numerator / denominator, remainder = numerator % denominator;
  return remainder === 0n ? String(whole) : `${whole}.${String(remainder).padStart(String(denominator).length - 1, "0").replace(/0+$/u, "")}`;
}
function nativeLayer(name: string) { return `BL_${name.replaceAll(".", "_")}`; }
function identityFromHelper(value: { readonly sha256: string; readonly sizeBytes: number }): ContentIdentity {
  return { algorithm: "sha256", digest: value.sha256, size: value.sizeBytes };
}

/** Strict circle/capsule overlap proves a drill void enters the required ribbon.
 * Equality alone remains uncertain: this predicate never rounds tangency inward.
 */
function boreRibbonRelation(bore:{centerNm:{x:number;y:number};diameterNm:number},segment:{startNm:{x:number;y:number};endNm:{x:number;y:number};widthNm:number},marginNm:number):"overlap"|"tangent"|"separate"{
  const ax=BigInt(segment.startNm.x),ay=BigInt(segment.startNm.y),dx=BigInt(segment.endNm.x)-ax,dy=BigInt(segment.endNm.y)-ay;
  const px=BigInt(bore.centerNm.x)-ax,py=BigInt(bore.centerNm.y)-ay,length2=dx*dx+dy*dy,dot=px*dx+py*dy;
  const radius2=BigInt(segment.widthNm)+2n*BigInt(marginNm)+BigInt(bore.diameterNm),limit=radius2*radius2;
  const compare=(a:bigint,b:bigint)=>a<b?"overlap" as const:a===b?"tangent" as const:"separate" as const;
  if(length2===0n||dot<=0n)return compare(4n*(px*px+py*py),limit);
  if(dot>=length2){const ex=px-dx,ey=py-dy;return compare(4n*(ex*ex+ey*ey),limit);}
  const cross=dx*py-dy*px;return compare(4n*cross*cross,limit*length2);
}

/** Pure assessment with an optional host-owned geometric calculation; never opens or mutates CAD. */
export async function assessFreshPlaneAcceptance(supplied: FreshPlaneAcceptanceInput) {
  // Snapshot host input references before the optional awaited calculator. The
  // branded evidence/bundle objects are immutable, and source inputs are strings.
  const input = Object.freeze({ ...supplied });
  const bundle = input.compilationBundle;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "an authenticated actual V2 compilation bundle is required");
  const identities = { pcb: contentIdentity(input.pcbSource), project: contentIdentity(input.projectSettingsSource), rules: contentIdentity(input.rulesSource) };
  requireValue(isFreshPlaneConnectivityAssessment(input.endpointConnectivity), "unbranded endpoint summary is not native connectivity authority");
  const endpoint = freezePcbPlaneArtifact(structuredClone(input.endpointConnectivity));
  exactIdentity(endpoint, "evleda.fresh-plane-connectivity.v1");
  requireValue(same(endpoint.bundleIdentity, bundle.identity) && same(endpoint.contractIdentity, bundle.contract.identity)
    && same(endpoint.libraryBindingIdentity, bundle.libraryBinding.identity) && same(endpoint.verificationPlanIdentity, bundle.verificationPlan.identity)
    && same(endpoint.savedSourceIdentity, identities.pcb), "endpoint evidence belongs to different source or V2 authority");
  const rows: Row[] = bundle.verificationPlan.requirements.map(row => ({ id: row.id, kind: row.kind, status: "unknown",
    reasons: ["This mandatory V2 requirement has no complete evaluator in this bounded plane assessment."] }));
  const setRow = (id: string, value: Fact) => {
    const row = rows.find(row => row.id === id); requireValue(row !== undefined, `unknown V2 verification row ${id}`);
    rows[rows.indexOf(row)] = { ...row, status: value.status === "verified" ? "pass" : value.status === "failed" ? "fail" : "unknown", reasons: value.reasons };
  };
  const setInterfaceRow = (id: string, kind: Row["kind"], value: Fact) => {
    requireValue(rows.filter(row => row.id === id && row.kind === kind).length === 1, "interface evidence does not match an original V2 verification row");
    setRow(id, value);
  };
  const interfaceEvidence: SavedInterfaceAssessment[] = [];
  // Saved construction and route counterexamples have their own source-bound
  // scope. They do not depend on, or replace, current-session fill authority.
  for (const pair of bundle.contract.interfaceRequirements?.interfaces ?? []) {
    const assessment = await assessSavedInterface({ savedPcbBytes: Buffer.from(input.pcbSource, "utf8"), compilationBundle: bundle, interfaceId: pair.id,
      ...(input.transmissionLine === undefined ? {} : { calculator: input.transmissionLine }) });
    requireValue(assessment.schemaVersion === SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION && assessment.boardAccepted === false
      && assessment.interfaceAccepted === false && assessment.fabricationAuthorized === false, "saved interface evidence has unsupported schema or acceptance claims");
    exactIdentity(assessment, SAVED_INTERFACE_ASSESSMENT_SCHEMA_VERSION);
    requireValue(assessment.interfaceId === pair.id && same(assessment.sourceIdentity, identities.pcb)
      && same(assessment.bundleIdentity, bundle.identity) && same(assessment.contractIdentity, bundle.contract.identity)
      && same(assessment.verificationPlanIdentity, bundle.verificationPlan.identity)
      && same(assessment.requirementIdentity, canonicalIdentity(pair, "evleda.saved-interface-requirement.v1")), "saved interface evidence belongs to different source or V2 authority");
    interfaceEvidence.push(assessment);
  }
  const missing = "A current-session saved native fill witness is required; reapply and save the contract plane before acceptance.";
  const planeRegionBridges: Array<Fact & { planeId: string; referencePlaneId: string;
    scope: "qualified-source-native-annulus-contact-to-primary-plane";
    calculation: ReturnType<typeof findPlaneRegionAnnulusWitnesses> | null }> = bundle.contract.routingConstraints.nets.flatMap(route =>
      route.topology !== "plane" ? [] : (route.additionalPlaneIds ?? []).map(planeId => ({ planeId, referencePlaneId: route.planeId,
        scope: "qualified-source-native-annulus-contact-to-primary-plane" as const, ...fact("unknown", missing), calculation: null })));
  const planes: Array<{
    planeId: string; zoneUuid: string | null; configuration: Fact; geometry: ReturnType<typeof assessFreshPlaneFilledGeometry>;
    nativeGeometry: ReturnType<typeof assessFreshPlaneFilledGeometry> | null; componentCount: number;
    drillTopology:ReturnType<typeof assessFreshPlaneDrillTopology>;
    nativePolygonAttribution: Fact; minimumArea: Fact & { requiredAreaTwiceNm2: string; observedAreaTwiceNm2: readonly string[];conservativeAreaLowerBoundTwiceNm2:string|null;
      componentAreaLowerBounds?: ReturnType<typeof boundRetainedPlaneRegionAreas> };
    intendedPlaneConnectivity: Fact & { scope:"native-pad-reachability-to-stored-zone-component" | "native-region-via-contacts-to-primary-plane";directEligiblePadAnchors: readonly string[]; nativeDirectVias: readonly string[] };
    regionalPolicyConditions?: Fact & { referencePlaneId: string; engineeringBasis: string };
    islandPolicy: Fact; actualMinimumCopperWidth: Fact; thermalPolicy: Fact; actualThermalWidth: Fact;
  }> = [];
  const references: Array<{ net: string; planeId: string; status: Status; reasons: readonly string[]; segmentIds: readonly string[];
    marginNm: number; geometricStatus: "covered" | "uncovered" | "boundary_uncertain" | "not_assessed";
    referenceTerminals: Fact; intersectingBoreUuids:readonly string[];tangentBoreUuids:readonly string[];calculation: unknown;
    terminalLaunches?: readonly (Fact & { requirementId: string; geometry: ReturnType<typeof planReferenceTerminalLaunchStudy>["launches"][number] | null; foreignBoreUuids: readonly string[] })[] }> = [];
  let authority = fact("unknown", missing), sourceScope = fact("unknown", missing), nativeInventory = fact("unknown", "Current authenticated native contacts are unavailable.");
  let commonChecks: FreshPlaneCommonChecksAssessment | null = null;
  const interfaceRows = (): FreshPlaneInterfaceAcceptance[] => {
    const checks = interfaceEvidence.map(assessment => {
      const pair = bundle.contract.interfaceRequirements!.interfaces.find(pair => pair.id === assessment.interfaceId)!;
      const construction = interfaceFact(assessment.construction.status, ["matched_saved_declaration"], ["failed_saved_declaration"], assessment.construction.reasons);
      const externalResistance = [pair.terminations.source, pair.terminations.receiver].some(value => value.kind === "parallel" || value.kind === "source_series");
      const measuredTermination = interfaceFact(assessment.terminations.status, ["matched_source_facts"], ["failed_source_facts"], assessment.terminations.reasons);
      const terminationSourceFacts = fact(measuredTermination.status, ...measuredTermination.reasons,
        ...(externalResistance ? ["Observed external termination distance is straight-line planar pad-center separation; routed electrical access length and delay are not evaluated."] : []));
      // Exact pin/route/distance observations cannot establish the separate
      // resistor-value requirement. Keep those source facts usable by topology.
      const termination = !externalResistance || terminationSourceFacts.status === "failed" ? terminationSourceFacts
        : fact("unknown", ...terminationSourceFacts.reasons,
          "Declared external termination resistance remains caller-asserted; no observed component resistance or saved resistance-value assessment is available.");
      const selectedGeometry = assessment.geometry;
      const inventory = interfaceFact(assessment.sourceInventory.status, ["complete"], [], assessment.sourceInventory.reasons);
      const source = allFacts([inventory, assessment.sourceInventory.projectionComplete && selectedGeometry?.inventoryComplete === true
        ? fact("verified", "Every selected saved-source primitive is retained in the complete pair assessment.")
        : fact("unknown", "The saved primitive projection and complete geometry inventory must both be established.")]);
      const geometryCheck = (key: keyof NonNullable<SavedInterfaceAssessment["geometry"]>["checks"]): Fact => {
        const value = selectedGeometry?.checks[key];
        return value === undefined ? fact("unknown", "Complete supported saved pair geometry is unavailable.")
          : interfaceFact(value.status, ["pass"], ["fail"], value.reasons);
      };
      const anchors = allFacts(([pair.terminations.source, pair.terminations.receiver] as const).flatMap(termination => {
        if (termination.kind === "none") return [fact("verified", "No termination anchor is declared on this interface side.")];
        if (termination.kind === "source_series") {
          if (!assessment.channel) return [fact("unknown", "Complete split-net source-series channel evidence is unavailable.")];
          return [...assessment.channel.anchors.map(anchor => interfaceFact(anchor.status, ["pass"], ["fail"], [`Declared channel anchor ${anchor.selector.reference}:${anchor.selector.pad} must contact its exact net graph.`])),
            ...assessment.channel.protectionReturns.map(anchor => interfaceFact(anchor.status, ["pass"], ["fail"], [`Protection return ${anchor.reference}:${anchor.pin} must match its exact declared net.`]))];
        }
        return [termination.positivePin, termination.negativePin].map(pin => {
          // Integrated termination pins are the declared source or receiver
          // roles; external parallel terminations have separate route anchors.
          const candidates = termination.kind === "integrated" ? selectedGeometry?.sourceRoles : selectedGeometry?.terminationAnchors;
          const observed = candidates?.filter(anchor => anchor.selector.reference === termination.componentReference && anchor.selector.pad === pin) ?? [];
          return observed.length !== 1 ? fact("unknown", "Every declared termination pin requires one complete source route-anchor assessment.")
            : interfaceFact(observed[0]!.status, ["pass"], ["fail"], [`Declared termination anchor ${termination.componentReference}:${pin} must contact its unique member route.`]);
        });
      }));
      const topology = allFacts([source, ...(["sourcePolarity", "topology", "stubs", "transitions"] as const).map(geometryCheck), terminationSourceFacts, anchors]);
      const memberNets = channelMemberNets(pair), referenceRowIds: string[] = [];
      const referenceCoverage = { ...allFacts(memberNets.map(net => {
        const observed = references.filter(reference => reference.net === net && reference.planeId === pair.routing.referencePlaneId);
        if (observed.length !== 1) return fact("unknown", `Current saved-fill reference coverage is unavailable for interface member ${net}.`);
        const reference = observed[0]!; referenceRowIds.push(`reference:${net}`);
        if (reference.status === "failed" || reference.geometricStatus === "uncovered") return fact("failed", ...reference.reasons);
        return reference.status === "verified" && reference.geometricStatus === "covered" && authority.status === "verified"
          ? fact("verified", ...reference.reasons) : fact("unknown", ...reference.reasons);
      })), planeId: pair.routing.referencePlaneId, memberNets, referenceRowIds };
      const sourceGeometry = allFacts([topology, ...(["width", "minimumGap", "coupledGap", "length", "skew", "uncoupled"] as const).map(geometryCheck)]);
      const pairGeometry = allFacts([sourceGeometry, referenceCoverage]);
      const model = interfaceFact(assessment.impedance.status, ["within_tolerance"], ["outside_tolerance"], assessment.impedance.reasons);
      const impedance = model.status === "failed" || assessment.impedance.status === "not_requested" ? model
        : fact(model.status === "verified" && construction.status === "verified" && sourceGeometry.status === "verified"
          && assessment.impedance.completeRouteModelCoverage ? "verified" : "unknown",
        ...model.reasons, ...construction.reasons, ...sourceGeometry.reasons,
        assessment.impedance.completeRouteModelCoverage
          ? "The analytical target row assumes continuous reference copper; current saved-fill reference coverage is evaluated separately."
          : "Every required route interval must have complete applicable model coverage.");
      setInterfaceRow(`interface-topology:${pair.id}`, "interface_topology", topology);
      setInterfaceRow(`interface-geometry:${pair.id}`, "interface_pair_geometry", pairGeometry);
      setInterfaceRow(`interface-termination:${pair.id}`, "interface_termination", termination);
      if (pair.impedance.mode === "differential") setInterfaceRow(`interface-impedance:${pair.id}`, "interface_impedance", impedance);
      return { interfaceId: pair.id, assessmentIdentity: assessment.identity, construction, topology, pairGeometry, termination, impedance, referenceCoverage };
    });
    if (bundle.contract.interfaceRequirements !== undefined && bundle.contract.interfaceRequirements.construction.mode !== "none")
      setInterfaceRow("interface-construction", "interface_construction", allFacts(checks.map(check => check.construction)));
    return checks;
  };
  const finish = () => {
    const interfaces = interfaceRows();
    const payload = { schemaVersion: "evleda.fresh-plane-acceptance.v1" as const, family: "plane-v2" as const,
      status: rows.some(row => row.status === "fail") ? "failed" as const : "incomplete" as const,
      bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity, verificationPlanIdentity: bundle.verificationPlan.identity,
      sourceIdentities: identities, savedEvidenceIdentity: input.savedEvidence?.identity ?? null,
      evidence: { savedFill: input.savedEvidence, endpointConnectivity: endpoint,
        nativeContacts: input.nativeContacts ?? null, nativeChecks: input.nativeChecks ?? null, commonChecks,
        ...(bundle.contract.interfaceRequirements === undefined ? {} : { interfaces: interfaceEvidence }) },
      endpointConnectivityIdentity: endpoint.identity, endpointConnectivity: { status: endpoint.status, nets: endpoint.nets.map(net => ({ net: net.net, status: net.status,
        everyEligiblePhysicalMemberReachable: net.everyEligiblePhysicalMemberReachable })) },
      authority, sourceScope, nativeInventory, planes, planeRegionBridges, references, rows,
      ...(bundle.contract.interfaceRequirements === undefined ? {} : { interfaces }),
      verificationPlanRowsPassed: rows.filter(row => row.status === "pass").map(row => row.id),
      mandatoryRowsRemaining: rows.filter(row => row.status !== "pass").map(row => row.id),
      acceptanceEvaluated: true as const, accepted: false as const, fabricationAuthorized: false as const,
      limitations: { overallAcceptance: "requires-every-mandatory-V2-row-and-independent-general-gates" as const,
        physicalThermalWidth: "not-measured" as const, actualMinimumCopperWidth: "not-measured" as const,
        terminalContactContinuity:"native-model-only-not-drill-clipped-global-copper" as const,
        highFrequencyElectricalValidity: "not-established" as const,
        impedance: bundle.contract.interfaceRequirements === undefined ? "not-evaluated" as const : "interface-analytical-model-only-not-measured" as const,
        currentSourceGuards: "required-of-owning-host-before-and-after-assessment" as const } };
    return freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  };
  const expectedNoConnects=bundle.contract.components.flatMap(component=>component.pins.filter(pin=>pin.assignment.kind==="no_connect").map(pin=>`${component.reference}:${pin.pin}`)).sort();
  if(expectedNoConnects.length>0){
    const observed=endpoint.noConnectIsolation??[];
    const isolated=endpoint.nativeTerminalBindingIdentity?.schemaVersion==="evleda.fresh-native-terminal-binding.v1"
      &&same(observed.map(terminal=>`${terminal.reference}:${terminal.pin}`).sort(),expectedNoConnects)
      &&observed.every(terminal=>terminal.status==="isolated"&&terminal.disposition==="no_connect"&&terminal.semanticNet===null);
    if(!isolated){
      authority=fact("failed","Complete current native intentional-NC terminal isolation is missing or invalid.");
      sourceScope=authority;setRow("contract:integrity",authority);
      for(const row of rows.filter(row=>row.kind.startsWith("plane_")||row.kind==="reference_path"))setRow(row.id,authority);
      return finish();
    }
  }
  if (input.savedEvidence === null) { for (const row of rows) setRow(row.id, fact("unknown", missing)); return finish(); }
  const saved = input.savedEvidence;
  requireValue(isSavedFreshPlaneEvidence(saved), "serialized or copied fill evidence has no current-session authority");
  requireValue(same(saved.bundleIdentity, bundle.identity) && same(saved.contractIdentity, bundle.contract.identity)
    && same(saved.verificationPlanIdentity, bundle.verificationPlan.identity) && same(saved.savedPcbIdentity, identities.pcb)
    && same(saved.projectSettingsIdentity, identities.project) && same(saved.rulesIdentity, identities.rules)
    && same(saved.sourceScopeIdentity, endpoint.hostScopeIdentity), "saved native fill witness is stale for current source, scope or V2 authority");
  requireValue(same(endpoint.nativeSourceIdentity, identities.pcb) || same(endpoint.nativeSourceIdentity, contentIdentity(saved.stage.nativeSourceStaged)),
    "endpoint native source is not an admitted authenticated saved or staged serialization");
  requireValue(input.rulesSource === createFreshPlaneRules(bundle).source, "rules are not the exact bundle-owned canonical DRU");
  authority = fact("verified", "Authenticated V2 bundle, current saved fill, exact source and rules, and physical endpoint scope agree.");
  setRow("contract:integrity", authority);
  let board: ReturnType<typeof parseFreshPcbSource>, source: ReturnType<typeof parseFreshPcbReferenceGeometry>;
  try {
    board = parseFreshPcbSource(input.pcbSource); source = parseFreshPcbReferenceGeometry(input.pcbSource);
    assertFreshPlaneReferenceCopperScope(input.pcbSource,bundle.contract.scope.board.copperLayers);
    resolveFreshPlaneSourceZones(bundle,source.zones);
    const spans = parseFreshPcbRouteSourceSpans(input.pcbSource), viaSpans = spans.filter(span => span.kind === "via");
    requireValue(source.issues.length === 0 && source.zones.every(zone => zone.status === "supported"), "unsupported source geometry is retained and cannot be discarded");
    requireValue(source.unsupportedRouteItems.length === viaSpans.length && viaSpans.length === board.vias.length
      && source.unsupportedRouteItems.every(item => item.kind === "via" && viaSpans.filter(span => input.pcbSource.slice(span.start, span.end) === item.source).length === 1), "unsupported route primitives cannot be filtered into a coverage pass");
    assertPcbBoardFeatureInventory(bundle.contract, board, input.pcbSource);
    requireValue(same(names(endpoint.nets.map(net => net.net)), names(bundle.contract.nets.map(net => net.name))), "endpoint net inventory differs from the exact V2 contract");
    for (const net of bundle.contract.nets) {
      const observed = endpoint.nets.find(candidate => candidate.net === net.name)!;
      const key = (end: { reference: string; pin: string }) => `${end.reference}:${end.pin}`;
      requireValue(same(names(observed.endpoints.map(key)), names(net.endpoints.map(key))), "endpoint terminal inventory differs from the exact V2 net");
      for (const end of observed.endpoints) {
        const pads = board.footprints.find(fp => fp.reference === end.reference)!.pads.filter(pad => pad.number === end.pin);
        requireValue(same(names(end.physicalPadUuids), names(pads.map(pad => pad.physical.id!))), "endpoint physical-member inventory differs from the complete saved terminal");
      }
    }
    requireValue(board.segments.every(track => bundle.contract.nets.some(net => net.name === track.netName)) && board.vias.every(via => bundle.contract.nets.some(net => net.name === via.netName)), "uncontracted route copper exists");
    sourceScope = fact("verified", "Complete supported source route, footprint and layered-copper scope; through-vias retained separately from straight reference ribbons.");
  } catch (error) {
    sourceScope = fact("failed", error instanceof Error ? error.message : "Unsupported PCB source scope.");
    for (const row of rows.filter(row => row.kind.startsWith("plane_") || row.kind === "reference_path")) setRow(row.id, sourceScope);
    return finish();
  }
  // The common assessor requires the original in-process endpoint authority,
  // not the detached snapshot retained in this result's diagnostic evidence.
  commonChecks = assessFreshPlaneCommonChecks({ compilationBundle: bundle, savedEvidence: saved,
    pcbSource: input.pcbSource, endpointConnectivity: input.endpointConnectivity });
  for (const check of commonChecks.rows) {
    const index = rows.findIndex(row => row.id === check.id);
    requireValue(index >= 0 && rows[index]!.kind === check.kind, "common source check does not match an original V2 verification row");
    rows[index] = { ...rows[index]!, status: check.status, reasons: check.reasons };
  }
  const contactObservation = input.nativeContacts;
  let contacts: KicadPlaneContactsObservation["report"] | undefined;
  if (contactObservation !== undefined) {
    requireValue(isKicadPlaneContactsObservation(contactObservation), "unbranded native contact data cannot authorize plane connectivity");
    requireValue(same(contactObservation.sourceBefore, identities.pcb) && same(contactObservation.sourceAfter, identities.pcb)
      && same(identityFromHelper(contactObservation.report.source.before), identities.pcb)
      && same(identityFromHelper(contactObservation.report.source.after), identities.pcb), "native contact source differs from the saved fill witness");
    contacts = contactObservation.report;
    try {
      const sourcePads = board.footprints.flatMap(fp => fp.pads.map(pad => ({ uuid: pad.physical.id, footprintUuid: fp.id, reference: fp.reference, number: pad.number, netName: pad.netName ?? "" })));
      unique(contacts.allPads.map(pad => pad.uuid), "native pad inventory"); unique(contacts.allTracks.map(track => track.uuid), "native route inventory");
      unique(contacts.allFootprints.map(fp => fp.uuid), "native footprint inventory"); unique(contacts.zones.map(zone => zone.uuid), "native zone inventory");
      requireValue(contacts.inventory.padCount === sourcePads.length && contacts.allPads.length === sourcePads.length
        && contacts.allPads.every(pad => sourcePads.some(savedPad => same(savedPad, { uuid: pad.uuid, footprintUuid: pad.footprintUuid, reference: pad.reference, number: pad.number, netName: pad.netName }))), "native physical pad inventory differs from complete saved source");
      requireValue(contacts.inventory.footprintCount === board.footprints.length && contacts.allFootprints.length === board.footprints.length
        && contacts.allFootprints.every(fp => board.footprints.some(savedFp => savedFp.id === fp.uuid && savedFp.reference === fp.reference)), "native footprint ownership differs");
      const tracks = [...board.segments.map(track => ({ uuid: track.id, nativeClass: "PCB_TRACK", netName: track.netName, layers: [track.layer] })),
        // Source scope above permits only F-to-B through vias. Their endpoint
        // pair spans every enabled copper layer reported by native GetLayerSet.
        ...board.vias.map(via => ({ uuid: via.id, nativeClass: "PCB_VIA", netName: via.netName, layers: [...bundle.contract.scope.board.copperLayers] }))];
      requireValue(contacts.inventory.trackCount === tracks.length && contacts.allTracks.length === tracks.length && contacts.allTracks.every(track => tracks.some(savedTrack =>
        savedTrack.uuid === track.uuid && savedTrack.nativeClass === track.nativeClass && savedTrack.netName === track.netName && same(names(savedTrack.layers), names(track.layers.map(layer => layer.name))))), "native complete route inventory differs from exact saved tracks and vias");
      requireValue(contacts.inventory.zoneCount === source.zones.length && contacts.zones.length === source.zones.length
        && same(names(contacts.zones.map(zone => zone.uuid)), names(source.zones.map(zone => zone.uuid!)))
        && same(names(saved.stage.nativeFilledZones.map(zone => zone.uuid)), names(source.zones.map(zone => zone.uuid!))), "saved, stage and native zone inventories differ");
      const physical = saved.stage.nativePads.inventory;
      requireValue(physical !== null && physical.unsupportedPhysicalUuids.length === 0 && physical.physicalPads.length === contacts.allPads.length,
        "native physical pad inventory is unsupported or differs from the qualified staged observation");
      const padLayersMatch = contacts.allPads.every(pad => physical.physicalPads.some(known =>
        known.uuid === pad.uuid && same(names(known.layerMembership), names(pad.layers.map(layer => nativeLayer(layer.name))))));
      requireValue(padLayersMatch, "native physical pad layer inventory differs from the qualified staged observation");
      nativeInventory = fact("verified", "All native zone, footprint, pad and route UUIDs, nets and layers match the complete saved source.");
    } catch (error) { nativeInventory = fact("failed", error instanceof Error ? error.message : "Native inventory mismatch."); }
  }
  const nativeChecks = input.nativeChecks;
  if (nativeChecks !== undefined) {
    requireValue(isFreshPlaneNativeChecksAssessment(nativeChecks) && same(nativeChecks.bundleIdentity, bundle.identity)
      && same(nativeChecks.savedEvidenceIdentity, saved.identity) && same(nativeChecks.sourceIdentities, identities), "native validation facts are unbranded or stale");
    const drc = nativeChecks.checks.drcClearanceShorts;
    setRow("drc", fact(drc.status === "verified" ? "verified" : drc.status === "failed" ? "failed" : "unknown", ...drc.reasons));
    if (bundle.contract.nativeRuleMode !== undefined) setRow("native-numeric-rules",
      fact(drc.status === "verified" ? "verified" : drc.status === "failed" ? "failed" : "unknown",
        "Current authenticated native assessment checks exact projected settings, canonical numeric DRU and enabled required categories; route/escape/locality and complete design acceptance remain separate.", ...drc.reasons));
    const erc = nativeChecks.checks.erc;
    setRow("erc", fact(erc.status === "verified" ? "verified" : erc.status === "failed" ? "failed" : "unknown", ...erc.reasons));
  }
  const declaredZones = resolveFreshPlaneSourceZones(bundle,source.zones);
  for (const plane of bundle.contract.planes) {
    const sourceZone = declaredZones.get(plane.id), zoneUuid = sourceZone?.uuid ?? null;
    const stageZone = saved.stage.nativeFilledZones.find(zone => zone.uuid === zoneUuid);
    let configuration: Fact;
    try {
      requireValue(nativeInventory.status !== "failed" && sourceZone !== undefined && stageZone !== undefined,"The declared saved/native zone is missing or its complete inventory failed.");
      assertFreshPlaneDeclaredZoneSettings({compilationBundle:bundle,pcbSource:input.pcbSource,planeId:plane.id,sourceZone:sourceZone!,nativeZone:stageZone!.raw});
      configuration = fact("verified","This saved and native zone retains its exact declared name, net, layer, boundary and settings within the complete inventory.");
    } catch(error) { configuration = fact("failed",error instanceof Error?error.message:"Declared-zone configuration differs."); }
    const geometry = assessFreshPlaneFilledGeometry({ savedZone: sourceZone!, nativeZone: stageZone?.raw, layer: plane.layer });
    let nativeGeometry: ReturnType<typeof assessFreshPlaneFilledGeometry> | null = null;
    let attribution = fact("unknown", "Authenticated matching native contact geometry is required.");
    const nativeZone = contacts?.zones.find(zone => zone.uuid === zoneUuid);
    if (nativeInventory.status === "verified" && nativeZone !== undefined && sourceZone !== undefined) {
      const layer = nativeZone.layers.find(layer => layer.name === plane.layer);
      const chain = (points: readonly (readonly number[])[]) => ({ closed: true, nodes: points.map(point => ({ point: { x_nm: String(point[0]), y_nm: String(point[1]) } })) });
      nativeGeometry = assessFreshPlaneFilledGeometry({ savedZone: sourceZone, layer: plane.layer, nativeZone: { id: { value: zoneUuid }, type: "ZT_COPPER",
        layers: [nativeLayer(plane.layer)], filled: nativeZone.isFilled, filled_polygons: [{ layer: nativeLayer(plane.layer), shapes: { polygons: (layer?.subpolygons ?? []).map(polygon => ({ outline: chain(polygon.outline), holes: polygon.holes.map(chain) })) } }] } });
      const equalGeometry = geometry.status === "verified" && nativeGeometry.status === "verified" && same(geometry.components, nativeGeometry.components);
      const attributed = nativeZone.netName === plane.net && !nativeZone.isRuleArea && nativeZone.isFilled && !nativeZone.needRefill && nativeZone.layers.length === 1
        && layer !== undefined && equalGeometry && (plane.islandPolicy.requireSingleConnectedComponent
          ? layer.filledSubpolygonCount === 1 && layer.subpolygons.length === 1 && layer.subpolygons[0]!.index === 0
            && geometry.components.length === 1 && geometry.components[0]!.nativePolygonIndex === 0
          : layer.filledSubpolygonCount === geometry.components.length && layer.subpolygons.length === geometry.components.length
            && new Set(geometry.components.map(c=>c.nativePolygonIndex)).size === geometry.components.length
            && same(layer.subpolygons.map(p=>p.index).sort((a,b)=>a-b), geometry.components.map(c=>c.nativePolygonIndex).sort((a,b)=>a-b)));
      attribution = attributed ? fact("verified", plane.islandPolicy.requireSingleConnectedComponent
        ? "One native subpolygon matches one connected copper component in the saved and staged geometry; direct contacts have an unambiguous scope."
        : "Every native subpolygon matches one stored component; regional via contacts require their separate complete observation.")
        : fact("failed", plane.islandPolicy.requireSingleConnectedComponent ? "Native contact geometry is not exactly one matching attributed filled component."
          : "Native contact geometry does not match the declared component-attribution policy.");
    } else if (nativeInventory.status === "failed") attribution = nativeInventory;
    const drillTopology=assessFreshPlaneDrillTopology({savedEvidence:saved,pcbSource:input.pcbSource,layer:plane.layer,zoneUuid});
    const areaThreshold = scaledFraction(plane.islandPolicy.minimumAreaMm2, 12);
    const requiredAreaTwiceNm2 = decimal(2n * areaThreshold.numerator, areaThreshold.denominator);
    const minimumArea = { ...(geometry.status==="verified"&&geometry.components.some(component=>BigInt(component.areaTwiceNm2)*areaThreshold.denominator<2n*areaThreshold.numerator)
      ?fact("failed","Even the stored plane area before drill subtraction is below the exact minimum threshold.")
      :drillTopology.status!=="verified"||drillTopology.conservativeAreaLowerBoundTwiceNm2===null
      ? fact("unknown","A complete bore-aware retained-area certificate is unavailable.")
      : BigInt(drillTopology.conservativeAreaLowerBoundTwiceNm2)*areaThreshold.denominator>=2n*areaThreshold.numerator
        ? fact("verified","The conservative retained area after supported drill subtraction meets the exact threshold.")
        : fact("unknown","The conservative area lower bound is below the threshold; enclosure loss alone does not prove a physical area failure.")),requiredAreaTwiceNm2,
      observedAreaTwiceNm2:geometry.components.map(component=>component.areaTwiceNm2),conservativeAreaLowerBoundTwiceNm2:drillTopology.conservativeAreaLowerBoundTwiceNm2};
    const net = endpoint.nets.find(net => net.net === plane.net), allMembers = net?.endpoints.flatMap(endpoint => endpoint.eligiblePhysicalPadUuids) ?? [];
    const eligible = new Set(allMembers), anchorIds = attribution.status === "verified" ? (nativeZone?.directPads ?? []).filter(pad => eligible.has(pad.uuid) && pad.netName === plane.net && pad.nativeClass === "PAD").map(pad => pad.uuid) : [];
    const badContact = nativeZone !== undefined && [...nativeZone.directPads, ...nativeZone.directTracks, ...nativeZone.directVias].some(item => item.netName !== plane.net)
      || nativeZone?.directPads.some(pad => !eligible.has(pad.uuid));
    const connected = configuration.status === "failed" || attribution.status === "failed" || badContact || net?.status === "disconnected" || net?.status === "invalid-evidence"
      ? fact("failed", "The intended plane component, complete endpoint cluster or direct contact inventory does not satisfy the contract.")
      : plane.islandPolicy.requireSingleConnectedComponent && attribution.status === "verified" && net?.status === "connected" && net.everyEligiblePhysicalMemberReachable && allMembers.length > 0 && anchorIds.length > 0
        ? fact("verified", "Every eligible endpoint member shares a complete native PAD cluster with a direct eligible PAD anchor on the sole intended plane component.")
        : fact("unknown", "Complete all-member native reachability and a direct eligible PAD anchor are required; a via-only contact has no separately evidenced terminal-to-via anchor.");
    const intendedPlaneConnectivity = { ...connected,scope:"native-pad-reachability-to-stored-zone-component" as const,directEligiblePadAnchors: anchorIds, nativeDirectVias: nativeZone?.directVias.map(via => via.uuid) ?? [] };
    const nativeIsland = nativeZone?.layers.some(layer => layer.subpolygons.some(polygon => polygon.isIsland === true)) === true;
    const island = geometry.status !== "verified" ? fact("unknown", "Filled topology is unverified.") : (plane.islandPolicy.requireSingleConnectedComponent && geometry.components.length !== 1 || minimumArea.status === "failed" || nativeIsland)
      ? fact("failed", "Single-component or minimum-area island policy is violated.")
      : !plane.islandPolicy.requireSingleConnectedComponent ? fact("unknown", "Explicit supplemental-region contacts and retained-area lower bounds remain to be collected; full drilled-copper continuity remains separate.")
      : attribution.status === "verified" &&drillTopology.status==="verified"&&minimumArea.status==="verified"&&nativeZone!.layers[0]!.subpolygons.every(polygon => polygon.isIsland === false) && connected.status === "verified"
        ? fact("verified", "The zone retains one sufficiently large planar interior after supported drill subtraction, native non-island classification and a native endpoint anchor.")
        : fact("unknown", "Native retained-island classification and connected intended-component attribution are required.");
    const thermal = nativeChecks?.planeThermalPolicies.find(result => result.planeId === plane.id)?.finding;
    const thermalPolicy = thermal === undefined ? fact("unknown", "Effective native thermal policy evidence is unavailable.")
      : fact(thermal.status === "verified" ? "verified" : thermal.status === "failed" ? "failed" : "unknown", ...thermal.reasons);
    const actualMinimumCopperWidth = fact("unknown", "Configured native minimum thickness does not measure actual filled copper width.");
    const actualThermalWidth = plane.padConnection.mode === "solid" ? fact("verified", "Thermal spoke width is not applicable to the declared solid connection.")
      : fact("unknown", "Actual physical thermal spoke width has not been measured; native configuration and DRC do not measure this dimension.");
    planes.push({ planeId: plane.id, zoneUuid, configuration, geometry, nativeGeometry,drillTopology,componentCount: geometry.components.length,
      nativePolygonAttribution: attribution, minimumArea, intendedPlaneConnectivity, islandPolicy: island, actualMinimumCopperWidth, thermalPolicy, actualThermalWidth });
    setRow(`plane-config:${plane.id}`, configuration);
    setRow(`plane-net:${plane.net}`,connected.status==="failed"?connected:fact("unknown",...connected.reasons,
      "Native endpoint reachability and planar interior topology do not yet prove every terminal contact through drill-clipped pad, track and barrel copper."));
    setRow(`plane-fill:${plane.id}`, geometry.status !== "verified" ? fact("unknown", ...geometry.issues) : actualMinimumCopperWidth);
    setRow(`plane-policy:${plane.id}`, island.status === "failed" || thermalPolicy.status === "failed" ? fact("failed", ...island.reasons, ...thermalPolicy.reasons)
      : fact("unknown", ...island.reasons, ...thermalPolicy.reasons, ...actualThermalWidth.reasons, "The complete thermal or solid contact row remains unevaluated."));
    const drc = nativeChecks?.checks.drcClearanceShorts;
    setRow(`plane-clearance:${plane.id}`, drc?.status === "failed" ? fact("failed", ...drc.reasons)
      : fact("unknown", ...(drc?.reasons ?? []), "Effective zone and edge clearance rule interaction needs its complete plane-specific evaluator."));
  }
  // Additional observation only: preserve every original single-component,
  // area, thermal, reference and global continuity requirement unchanged.
  for (const observation of planeRegionBridges) {
    try {
      requireValue(authority.status === "verified" && sourceScope.status === "verified" && nativeInventory.status === "verified"
        && nativeChecks?.checks.drcClearanceShorts.status === "verified" && contacts !== undefined,
      "Current complete source/native inventory and clearance checks are required for region bridges.");
      const target = planes.find(p => p.planeId === observation.planeId)!, reference = planes.find(p => p.planeId === observation.referencePlaneId)!;
      const targetSpec = bundle.contract.planes.find(p => p.id === target.planeId)!, referenceSpec = bundle.contract.planes.find(p => p.id === reference.planeId)!;
      requireValue(targetSpec.net === referenceSpec.net && targetSpec.layer !== referenceSpec.layer
        && target.configuration.status === "verified" && reference.configuration.status === "verified"
        && reference.intendedPlaneConnectivity.status === "verified" && reference.geometry.components.length === 1,
      "The primary plane must have one attributed component anchored to complete native endpoint reachability.");
      const targetNative = contacts!.zones.find(z => z.uuid === target.zoneUuid)!, referenceNative = contacts!.zones.find(z => z.uuid === reference.zoneUuid)!;
      for (const [plane, nativeZone] of [[target, targetNative], [reference, referenceNative]] as const) {
        requireValue(plane.geometry.status === "verified" && plane.nativeGeometry?.status === "verified"
          && same(plane.geometry.components, plane.nativeGeometry.components) && nativeZone !== undefined
          && nativeZone.netName === targetSpec.net && nativeZone.isFilled && !nativeZone.needRefill && !nativeZone.isRuleArea
          && nativeZone.layers.length === 1 && nativeZone.layers[0]!.filledSubpolygonCount === plane.geometry.components.length
          && nativeZone.layers[0]!.subpolygons.length === plane.geometry.components.length
          && same(nativeZone.layers[0]!.subpolygons.map(p => p.index).sort((a,b)=>a-b), plane.geometry.components.map(p=>p.nativePolygonIndex).sort((a,b)=>a-b)),
        "Every source/staged/native region needs an exact unique subpolygon attribution.");
        requireValue(nativeZone.layers[0]!.subpolygons.every(p => p.isIsland === false), "A native island flag prevents a grounded-region witness claim.");
      }
      const physical = saved.stage.nativePads.inventory;
      requireValue(physical !== null, "Complete qualified PAD geometry is required for bore enclosures.");
      const geometry = collectPlaneBridgeSource(input.pcbSource, physical!);
      const direct = (zone: typeof targetNative) => new Set(zone.directVias.filter(v => v.netName === targetSpec.net).map(v => v.uuid));
      const mainVias = direct(referenceNative), targetVias = direct(targetNative);
      const vias = geometry.vias.filter(v => v.netName === targetSpec.net && mainVias.has(v.uuid) && targetVias.has(v.uuid));
      const calculation = findPlaneRegionAnnulusWitnesses({ components: target.geometry.components,
        reference: reference.geometry.components[0]!, vias, boreEnclosures: geometry.boreEnclosures });
      Object.assign(observation, { ...fact(calculation.allRegionsWitnessed ? "verified" : "unknown",
        calculation.allRegionsWitnessed
          ? "Each stored region has a strictly bore-clear copper disc shared with a direct-contact normal through-via and the endpoint-anchored primary plane. Global drill-clipped continuity, width and current suitability remain separate."
          : "At least one stored region lacks a supported positive-area through-via contact witness to the primary plane; absence of this witness is not proof of disconnection."), calculation });
      if (!targetSpec.islandPolicy.requireSingleConnectedComponent) {
        requireValue(targetSpec.islandPolicy.referencePlaneId === observation.referencePlaneId, "Regional policy reference differs from the qualified primary plane.");
        try {
          const areaBounds = boundRetainedPlaneRegionAreas(target.geometry.components, geometry.boreEnclosures);
          const threshold = scaledFraction(targetSpec.islandPolicy.minimumAreaMm2, 12);
          const areaProven = areaBounds.every(a => BigInt(a.conservativeRetainedAreaTwiceNm2) * threshold.denominator >= 2n * threshold.numerator);
          target.minimumArea = { ...target.minimumArea, ...(target.minimumArea.status === "failed" ? {} : fact(areaProven ? "verified" : "unknown",
            areaProven ? "Every stored component's complete bore-enclosure-subtracted retained-area lower bound meets the declared floor. This proves area, not post-drill connectivity."
              : "The conservative per-component area lower bound is insufficient; no actual area violation is inferred from over-subtraction.")), componentAreaLowerBounds: areaBounds };
        } catch (error) {
          if (target.minimumArea.status !== "failed") target.minimumArea = { ...target.minimumArea,
            ...fact("unknown", error instanceof Error ? error.message : "Regional area bounds are unavailable.") };
        }
      }
    } catch (error) {
      Object.assign(observation, { ...fact("unknown", error instanceof Error ? error.message : "Region-bridge prerequisites are unavailable."), calculation: null });
    }
  }
  for (const target of planes) {
    const spec = bundle.contract.planes.find(p => p.id === target.planeId)!;
    const policy = spec.islandPolicy;
    if (policy.requireSingleConnectedComponent) continue;
    const bridge = planeRegionBridges.find(p => p.planeId === target.planeId && p.referencePlaneId === policy.referencePlaneId);
    const conditions = allFacts([target.configuration, target.nativePolygonAttribution, target.minimumArea,
      bridge ?? fact("unknown", "A complete current regional via-contact observation is required.")]);
    target.regionalPolicyConditions = { ...conditions, referencePlaneId: policy.referencePlaneId, engineeringBasis: policy.engineeringBasis };
    if (target.intendedPlaneConnectivity.status !== "failed" && bridge?.status === "verified") target.intendedPlaneConnectivity = {
      ...target.intendedPlaneConnectivity, ...fact("verified", "Every stored supplemental region has a qualified native/source via contact to the endpoint-anchored primary plane; global drill-clipped continuity remains independent."),
      scope: "native-region-via-contacts-to-primary-plane" };
    target.islandPolicy = target.islandPolicy.status === "failed" ? target.islandPolicy : conditions.status === "failed" ? conditions
      : fact("unknown", ...conditions.reasons, "Complete drill-clipped region continuity is not established by local contact discs and retained-area bounds.");
    setRow(`plane-policy:${target.planeId}`, target.islandPolicy.status === "failed" || target.thermalPolicy.status === "failed"
      ? fact("failed", ...target.islandPolicy.reasons, ...target.thermalPolicy.reasons)
      : fact("unknown", ...target.islandPolicy.reasons, ...target.thermalPolicy.reasons, "Full contact and global continuity acceptance remain separate."));
  }
  for (const route of bundle.contract.routingConstraints.nets) {
    if (route.topology === "plane" || route.referencePath.mode !== "continuous_plane") continue;
    const ref = route.referencePath, plane = planes.find(plane => plane.planeId === ref.planeId)!;
    const marginBig = scaledInteger(ref.coverageMarginMm, 6); requireValue(marginBig <= 50_000_000n, "reference margin exceeds the contract bound");
    const marginNm = Number(marginBig), segments = source.segments.filter(segment => segment.netName === route.net);
    const net = endpoint.nets.find(net => net.net === route.net);
    const planeNet = bundle.contract.planes.find(p => p.id === ref.planeId)!.net, ground = endpoint.nets.find(net => net.net === planeNet);
    const terminalsOk = net?.status === "connected" && net.everyEligiblePhysicalMemberReachable && plane.intendedPlaneConnectivity.status === "verified"
      && ref.terminalReferences.every(terminal => net.endpoints.some(endpoint => endpoint.reference === terminal.signalEndpoint.reference && endpoint.pin === terminal.signalEndpoint.pin)
        && ground?.endpoints.some(endpoint => endpoint.reference === terminal.referenceEndpoint.reference && endpoint.pin === terminal.referenceEndpoint.pin && endpoint.eligiblePhysicalPadUuids.length === endpoint.physicalPadUuids.length));
    const referenceTerminals = terminalsOk ? fact("verified", "Each explicit signal and reference terminal is current and reaches its required native net or intended plane component.")
      : fact("unknown", "Every declared signal and reference physical terminal must be eligible, connected and bound to the intended plane.");
    let bodySegments = segments, launchPlanAvailable = ref.terminalLaunches === undefined;
    const launchResults: NonNullable<(typeof references)[number]["terminalLaunches"]>[number][] = (ref.terminalLaunches ?? []).map(launch => ({
      ...fact("unknown", "Current source/native terminal geometry and local return evidence are required."),
      requirementId: `reference-launch:${route.net}:${launch.signalEndpoint.reference}:${launch.signalEndpoint.pin}`, geometry: null, foreignBoreUuids: [] }));
    if (ref.terminalLaunches !== undefined && nativeInventory.status === "verified") {
      try {
        const plan = planReferenceTerminalLaunchStudy({ pcbSource: input.pcbSource, segments, referenceNet: planeNet,
          proposals: ref.terminalLaunches.map(p => ({ signalEndpoint: p.signalEndpoint, referenceEndpoint: p.referenceEndpoint,
            maximumLengthNm: Number(scaledInteger(p.maximumLengthMm, 6)), maximumReturnSpacingNm: Number(scaledInteger(p.maximumReturnSpacingMm, 6)), engineeringBasis: p.engineeringBasis })) });
        const physical = saved.stage.nativePads.inventory;
        requireValue(physical !== null, "Complete native pad geometry is required for terminal launches.");
        const nativeCoordinate = (v: unknown): number => {
          const text = v === undefined ? "0" : String(v);
          requireValue((v === undefined || typeof v === "number" || typeof v === "string") && /^-?(?:0|[1-9][0-9]{0,10})$/u.test(text), "Terminal position is not an exact native integer.");
          const result = Number(text); requireValue(Number.isSafeInteger(result) && Math.abs(result) <= 2_000_000_000, "Native terminal position exceeds its bound."); return result;
        };
        for (const launch of plan.launches) {
          for (const [uuid, center, endpoint, layer, netName] of [
            [launch.signalPadUuid, launch.signalCenterNm, launch.signalEndpoint, ref.signalLayer, route.net],
            [launch.referencePadUuid, launch.referenceCenterNm, launch.referenceEndpoint, bundle.contract.planes.find(p => p.id === ref.planeId)!.layer, planeNet],
          ] as const) {
            const pad = physical.physicalPads.find(p => p.uuid === uuid), raw = pad?.rawNative;
            requireValue(pad?.role === "numbered-copper" && pad.reference === endpoint.reference && pad.number === endpoint.pin
              && pad.netName === netName && pad.issues.length === 0 && pad.layerMembership.includes(nativeLayer(layer))
              && raw?.type === "PT_PTH", "Native launch terminal ownership, net, layer or pad type differs.");
            const position = raw.position;
            requireValue(position !== null && typeof position === "object" && !Array.isArray(position), "Native launch terminal position is missing.");
            const coordinates = position as Readonly<Record<string, unknown>>;
            requireValue(nativeCoordinate(coordinates.x_nm) === center.x && nativeCoordinate(coordinates.y_nm) === center.y, "Saved/native terminal centres differ.");
          }
        }
        bodySegments = plan.segments; launchPlanAvailable = true;
        let bores: ReturnType<typeof collectPlaneBridgeSource>["boreEnclosures"] | null = null;
        try { bores = collectPlaneBridgeSource(input.pcbSource, physical).boreEnclosures; } catch { /* Missing complete enclosures withhold local launch qualification. */ }
        for (const [index, launch] of plan.launches.entries()) {
          const segment = segments.find(s => s.uuid === launch.segmentId)!;
          const omitted = { startNm: launch.signalCenterNm, endNm: launch.cutNm, widthNm: segment.widthNm };
          const foreignBoreUuids = bores?.filter(b => b.uuid !== launch.signalPadUuid
            && boreRibbonRelation({ centerNm: b.centerNm, diameterNm: b.enclosingDiameterNm }, omitted, marginNm) !== "separate").map(b => b.uuid) ?? [];
          const exactForeignOverlaps = plane.drillTopology.inventory.complete ? plane.drillTopology.bores.filter(b => b.uuid !== launch.signalPadUuid
            && boreRibbonRelation(b, omitted, marginNm) === "overlap").map(b => b.uuid) : [];
          const anchor = referenceTerminals.status === "verified" && plane.intendedPlaneConnectivity.directEligiblePadAnchors.includes(launch.referencePadUuid)
            ? fact("verified", "The declared local return pad is a direct eligible native contact on the intended plane.")
            : fact("unknown", "A current direct eligible native return-pad anchor and complete terminal reachability are required.");
          const boreClearance = exactForeignOverlaps.length > 0 ? fact("failed", "A source-verified foreign round bore intersects the declared launch corridor.")
            : bores !== null && foreignBoreUuids.length === 0 ? fact("verified", "The omitted approach plus unchanged margin is strictly separate from all complete bore enclosures except its own signal-terminal bore.")
              : fact("unknown", "Foreign-bore separation is unproved; enclosure overlap or missing complete inventory cannot establish a pass.");
          const drc = nativeChecks?.checks.drcClearanceShorts.status === "verified"
            ? fact("verified", "Current authenticated native clearance/short checks and required rule categories are verified.")
            : fact("unknown", "Current authenticated native clearance/short checks are required for launch qualification.");
          launchResults[index] = { ...launchResults[index]!, ...allFacts([anchor, boreClearance, drc]), geometry: launch, foreignBoreUuids };
        }
      } catch (error) {
        const state = error instanceof ReferenceTerminalLaunchPlanningError && error.disposition === "constraint" ? "failed" : "unknown";
        for (const result of launchResults) Object.assign(result, fact(state, error instanceof Error ? error.message : "Terminal launch geometry is unavailable."));
      }
    }
    for (const launch of launchResults) setRow(launch.requirementId, launch);
    const launchConditions = launchResults.length === 0 ? fact("verified", "No terminal launch was declared.") : allFacts(launchResults);
    // A complete source/native bore inventory can prove a local missing-copper
    // counterexample even when global hole merging or retained area is unknown.
    // It cannot authorize a positive whole-route coverage claim.
    const boreInventoryComplete=plane.drillTopology.inventory.complete
      &&plane.drillTopology.bores.length===plane.drillTopology.inventory.boreCount;
    const intersectingBoreUuids=boreInventoryComplete?plane.drillTopology.bores.filter(bore=>bodySegments.some(segment=>boreRibbonRelation(bore,segment,marginNm)==="overlap")).map(bore=>bore.uuid):[];
    const tangentBoreUuids=boreInventoryComplete?plane.drillTopology.bores.filter(bore=>bodySegments.some(segment=>boreRibbonRelation(bore,segment,marginNm)==="tangent")).map(bore=>bore.uuid):[];
    let result: Fact = fact("unknown", "A host-bound reference coverage calculator is unavailable."), geometricStatus: "covered" | "uncovered" | "boundary_uncertain" | "not_assessed" = "not_assessed", calculation: unknown = null;
    if (segments.length === 0 || segments.some(segment => segment.layer !== ref.signalLayer) || board.vias.some(via => via.netName === route.net)) result = fact("failed", "The referenced net has missing segments, an unexpected signal layer or a forbidden transition or via; no primitive was filtered away.");
    else if (!launchPlanAvailable || launchConditions.status === "failed") result = launchConditions;
    else if(intersectingBoreUuids.length>0){result=fact("failed","The required reference ribbon intersects a source-verified round drill bore.");geometricStatus="uncovered";}
    else if(tangentBoreUuids.length>0){result=fact("unknown","The required reference ribbon is exactly tangent to a drill bore; boundary contact cannot establish a copper coverage certificate.");geometricStatus="boundary_uncertain";}
    // Missing copper in a current attributed fill is a counterexample even if
    // its global drilled topology or endpoint anchor is not yet proved. Those
    // prerequisites still gate positive coverage, not the geometric search.
    else if (plane.configuration.status !== "verified" || plane.nativePolygonAttribution.status !== "verified"
      || plane.geometry.status !== "verified" || plane.geometry.components.length !== 1) result = fact("unknown", "Reference copper lacks a current, source/native-matched single stored component for geometric assessment.");
    else if (input.referenceCoverage !== undefined) {
      requireValue(isReferenceCoverageCalculator(input.referenceCoverage), "reference coverage requires the authenticated host factory calculator");
      const component = plane.geometry.components[0]!;
      const request = freezePcbPlaneArtifact(referenceCoverageRequestSchema.parse({ groups: [{ rings: [component.outer, ...component.holes].map(ring => ring.map(point => [point.x, point.y])) }],
        routes: bodySegments.map(segment => ({ x1Nm: segment.startNm.x, y1Nm: segment.startNm.y, x2Nm: segment.endNm.x, y2Nm: segment.endNm.y, widthNm: segment.widthNm, marginNm })) }));
      const captured = await input.referenceCoverage.calculate(request);
      requireValue(captured.routes.length === segments.length && captured.coordinateUnit === "nm" && captured.dcConnectivityClaimed === false && captured.hfElectricalValidityClaimed === false, "reference helper omitted routes or changed evidence meaning");
      captured.routes.forEach((route, index) => requireValue(["covered", "uncovered", "boundary_uncertain"].includes(route.status)
        && route.routeIndex === index && route.certificate === (route.status === "covered" ? "exact_outer_envelope_containment" : route.status === "uncovered" ? "exact_inner_envelope_outside_witness" : "no_exact_certificate"), "reference helper supplied inconsistent geometric certificates"));
      geometricStatus = captured.routes.some(route => route.status === "uncovered") ? "uncovered" : captured.routes.some(route => route.status === "boundary_uncertain") ? "boundary_uncertain" : "covered";
      result = geometricStatus === "uncovered" ? fact("failed", "A complete selected signal ribbon has an exact witness outside the declared stored plane fill.") : geometricStatus === "boundary_uncertain" ? fact("unknown", "Geometric boundary uncertainty cannot pass reference coverage.")
        : launchConditions.status !== "verified" ? launchConditions
        : plane.intendedPlaneConnectivity.status !== "verified" || plane.islandPolicy.status !== "verified" || plane.drillTopology.status !== "verified"
          ? fact("unknown", "The stored-fill ribbons are geometrically covered, but complete drill-aware topology, island policy and intended-plane connectivity remain unverified.")
        : referenceTerminals.status !== "verified" ? referenceTerminals : fact("verified", "Every complete declared straight-route ribbon plus its exact contract margin is covered by eligible reference copper; all explicit reference terminals are connected.");
      calculation = { requestIdentity: canonicalIdentity(request, "evleda.plane-reference-request.v1"), implementationRevision: captured.implementationRevision,
        executableIdentity: captured.executableIdentity, artifacts: captured.artifacts,
        routes: captured.routes.map(route => ({ segmentId: segments[route.routeIndex]!.uuid, status: route.status, certificate: route.certificate })) };
    }
    references.push({ net: route.net, planeId: ref.planeId, ...result, segmentIds: segments.map(segment => segment.uuid), marginNm, geometricStatus, referenceTerminals,intersectingBoreUuids,tangentBoreUuids,calculation,
      ...(ref.terminalLaunches === undefined ? {} : { terminalLaunches: launchResults }) });
    setRow(`reference:${route.net}`,result.status==="verified"?fact("unknown",...result.reasons,
      "The geometric ribbon is covered, but complete drill-aware reference-terminal contact continuity remains unverified."):result);
  }
  return finish();
}
export type FreshPlaneAcceptanceAssessment = Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>;
