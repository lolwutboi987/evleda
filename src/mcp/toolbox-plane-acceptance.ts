import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { FreshPlaneAcceptanceAssessment } from "../harness/fresh-plane-acceptance.js";
import { sanitizePcbDiagnosticText, summarizeSavedInterface } from "./toolbox-interface-report.js";

const ASSESSMENT_VERSION = "evleda.fresh-plane-acceptance.v1";
const MAX_BYTES = 16 * 1024 * 1024;
// The MCP serializer permits 1 MiB; reserve space for its source fingerprints,
// recovery state and the private diagnostic's filename/content identity.
const MAX_PUBLIC_REPORT_BYTES = 1024 * 1024 - 4096;
// Reasons can include parser/native-check diagnostics. Preserve every finding,
// but leave path-bearing details in the hash-bound private assessment.
const reasons = (values: readonly string[]) => values.map(sanitizePcbDiagnosticText);
const fact = (value: { readonly status: "verified" | "failed" | "unknown"; readonly reasons: readonly string[] }) => ({
  status: value.status, reasons: reasons(value.reasons),
});
const canonical = (value: CanonicalIdentity) => ({ algorithm: value.algorithm, digest: value.digest,
  schemaVersion: value.schemaVersion, canonicalizationVersion: value.canonicalizationVersion });
const content = (value: ContentIdentity) => ({ algorithm: value.algorithm, digest: value.digest, size: value.size });
const geometry = (value: FreshPlaneAcceptanceAssessment["planes"][number]["geometry"]) => ({
  status: value.status, issues: reasons(value.issues), geometryEquivalent: value.geometryEquivalent,
  areaMeaning: "stored-zone-fill-geometry" as const,
  sourceGeometryIdentity: value.sourceGeometryIdentity === null ? null : canonical(value.sourceGeometryIdentity),
  nativeGeometryIdentity: value.nativeGeometryIdentity === null ? null : canonical(value.nativeGeometryIdentity),
  components: value.components.map(component => ({ nativePolygonIndex: component.nativePolygonIndex,
    areaTwiceNm2: component.areaTwiceNm2, holeCount: component.holes.length,
    topologyCertificate: component.topologyCertificate })),
});

type NativeChecks = NonNullable<FreshPlaneAcceptanceAssessment["evidence"]["nativeChecks"]>;
type NativeItemOwner = { kind: "pad" | "footprint"; reference: string; padNumber: string | null; footprintUuid: string };
const nativeRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Native finding projection requires complete object records.");
  return value as Record<string, unknown>;
};
const nativeList = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error("Native finding projection requires complete finding arrays.");
  return value;
};
const nativeText = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Native finding projection requires explicit text fields.");
  return value;
};
const publicText = (value: unknown): string => reasons([nativeText(value)])[0]!;
const publicNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Common source observations require finite numeric fields.");
  return value;
};
const publicBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Common source observations require explicit boolean fields.");
  return value;
};

type CommonChecks = NonNullable<FreshPlaneAcceptanceAssessment["evidence"]["commonChecks"]>;
function commonObservations(row: CommonChecks["rows"][number]): Record<string, unknown> {
  const value = nativeRecord(row.observations);
  if (Object.keys(value).length === 0) return {};
  if (row.kind === "outline") return {
    completeAnalyzedOutline: publicBoolean(value.completeAnalyzedOutline), primitiveCount: publicNumber(value.primitiveCount),
    sourcePrimitiveKinds: nativeList(value.sourcePrimitiveKinds).map(publicText),
    footprintLocalOutlineContributors: publicBoolean(value.footprintLocalOutlineContributors),
    widthNm: publicNumber(value.widthNm), heightNm: publicNumber(value.heightNm),
    ...(value.edgeKeysNm === undefined ? {} : { edgeKeysNm: nativeList(value.edgeKeysNm).map(publicText) }),
  };
  if (row.kind === "via_policy") return {
    net: publicText(value.net), viaCount: publicNumber(value.viaCount), globalViaCount: publicNumber(value.globalViaCount),
    perNetMaximum: publicNumber(value.perNetMaximum), globalMaximum: publicNumber(value.globalMaximum),
    footprintDrillsAreNotRoutedVias: publicBoolean(value.footprintDrillsAreNotRoutedVias),
    dimensions: nativeList(value.dimensions).map(item => {
      const via = nativeRecord(item);
      return { uuid: via.uuid === null ? null : publicText(via.uuid), diameterNm: publicNumber(via.diameterNm), drillNm: publicNumber(via.drillNm),
        annularRingTwiceNm: publicNumber(via.annularRingTwiceNm), xNm: publicNumber(via.xNm), yNm: publicNumber(via.yNm), layers: nativeList(via.layers).map(publicText) };
    }),
  };
  if (row.kind !== "trace_geometry") throw new Error("Common source observations name an unsupported row kind.");
  return { net: publicText(value.net), trackUuids: nativeList(value.trackUuids).map(publicText),
    fullRouteInventorySupplied: publicBoolean(value.fullRouteInventorySupplied), padExemptionsSource: publicText(value.padExemptionsSource),
    numericalToleranceMm: publicNumber(value.numericalToleranceMm) };
}
/** Compact common metadata plus a complete observation projection for every
 * evaluated original row. The full profile/analyzer capture stays private. */
function commonSourceChecks(assessment: FreshPlaneAcceptanceAssessment) {
  const common = assessment.evidence.commonChecks;
  if (assessment.savedEvidenceIdentity === null || common === null || common === undefined) return null;
  const { identity, ...payload } = common;
  if (common.schemaVersion !== "evleda.fresh-plane-common-checks.v1" || common.accepted !== false
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, common.schemaVersion))
      || canonicalJson(common.bundleIdentity) !== canonicalJson(assessment.bundleIdentity)
      || canonicalJson(common.contractIdentity) !== canonicalJson(assessment.contractIdentity)
      || canonicalJson(common.verificationPlanIdentity) !== canonicalJson(assessment.verificationPlanIdentity)
      || canonicalJson(common.savedEvidenceIdentity) !== canonicalJson(assessment.savedEvidenceIdentity)
      || canonicalJson(common.endpointConnectivityIdentity) !== canonicalJson(assessment.endpointConnectivityIdentity)
      || canonicalJson(common.pcbSourceIdentity) !== canonicalJson(assessment.sourceIdentities.pcb)) {
    throw new Error("Common source evidence identity or source binding differs from the complete plane assessment.");
  }
  const observations = new Map<string, Record<string, unknown>>();
  for (const row of common.rows) {
    const originals = assessment.rows.filter(original => original.id === row.id);
    if (observations.has(row.id) || originals.length !== 1 || originals[0]!.kind !== row.kind || originals[0]!.status !== row.status
        || canonicalJson(originals[0]!.reasons) !== canonicalJson(row.reasons)) throw new Error("Common source row differs from its original V2 verification row.");
    observations.set(row.id, commonObservations(row));
  }
  return { observations, summary: {
    assessmentIdentity: canonical(common.identity), schemaVersion: common.schemaVersion, scope: publicText(common.scope),
    pcbSourceIdentity: content(common.pcbSourceIdentity), savedEvidenceIdentity: canonical(common.savedEvidenceIdentity),
    sourceInventory: { complete: common.sourceInventory.complete, footprintCount: common.sourceInventory.footprintCount,
      physicalPadCount: common.sourceInventory.physicalPadCount, trackCount: common.sourceInventory.trackCount,
      viaCount: common.sourceInventory.viaCount, zoneCount: common.sourceInventory.zoneCount },
    numericalPolicy: { outlineAndViaDimensions: common.numericalPolicy.outlineAndViaDimensions,
      traceValidatorToleranceMm: common.numericalPolicy.traceValidatorToleranceMm },
    evaluatedRowIds: common.rows.map(row => row.id), notEvaluated: common.notEvaluated.map(publicText), accepted: common.accepted,
  } };
}

function nativeItemOwners(assessment: FreshPlaneAcceptanceAssessment) {
  const owners = new Map<string, NativeItemOwner[]>(), contacts = assessment.evidence.nativeContacts;
  if (contacts === null || contacts === undefined || assessment.nativeInventory.status !== "verified"
      || canonicalJson(contacts.sourceBefore) !== canonicalJson(assessment.sourceIdentities.pcb)
      || canonicalJson(contacts.sourceAfter) !== canonicalJson(assessment.sourceIdentities.pcb)) return owners;
  const add = (uuid: string, owner: NativeItemOwner) => owners.set(uuid, [...(owners.get(uuid) ?? []), owner]);
  for (const footprint of contacts.report.allFootprints) add(footprint.uuid, {
    kind: "footprint", reference: publicText(footprint.reference), padNumber: null, footprintUuid: publicText(footprint.uuid),
  });
  for (const pad of contacts.report.allPads) add(pad.uuid, {
    kind: "pad", reference: publicText(pad.reference), padNumber: publicText(pad.number), footprintUuid: publicText(pad.footprintUuid),
  });
  return owners;
}

function nativeFinding(value: unknown, owners: ReadonlyMap<string, readonly NativeItemOwner[]>) {
  const finding = nativeRecord(value);
  return {
    type: publicText(finding.type), severity: publicText(finding.severity), description: publicText(finding.description),
    items: finding.items === undefined ? [] : nativeList(finding.items).map(value => {
      const item = nativeRecord(value), uuid = nativeText(item.uuid), pos = nativeRecord(item.pos);
      if (typeof pos.x !== "number" || !Number.isFinite(pos.x) || typeof pos.y !== "number" || !Number.isFinite(pos.y)) {
        throw new Error("Native finding projection requires finite item positions.");
      }
      const matches = owners.get(uuid) ?? [];
      return { uuid: publicText(uuid), description: publicText(item.description), position: { x: pos.x, y: pos.y },
        sourceBinding: matches.length === 1 ? "matched" as const : matches.length === 0 ? "unavailable" as const : "ambiguous" as const,
        owner: matches.length === 1 ? { ...matches[0]! } : null };
    }),
  };
}

/** Preserve every native finding; raw invocations and report paths remain private. */
function nativeChecks(assessment: FreshPlaneAcceptanceAssessment) {
  const checks: NativeChecks | null = assessment.evidence.nativeChecks;
  if (assessment.savedEvidenceIdentity === null || checks === null || checks === undefined || checks.nativeInput === undefined) return null;
  const drc = checks.nativeInput.drc, report = nativeRecord(drc.report), owners = nativeItemOwners(assessment);
  const violations = nativeList(report.violations).map(value => nativeFinding(value, owners));
  const unconnectedItems = nativeList(report.unconnected_items).map(value => nativeFinding(value, owners));
  const schematicParity = nativeList(report.schematic_parity).map(value => nativeFinding(value, owners));
  if (drc.violationCount !== violations.length + unconnectedItems.length + schematicParity.length
      || drc.schematicParityCount !== schematicParity.length) throw new Error("Native finding counts differ from complete retained collections.");
  const nativeFact = (value: NativeChecks["checks"]["thermalPolicy"]) => ({ status: value.status, reasons: reasons(value.reasons) });
  return {
    assessmentIdentity: canonical(checks.identity), status: checks.status, nativeDrcIdentity: canonical(checks.nativeDrcIdentity),
    checks: { erc: checks.checks.erc === undefined ? null : nativeFact(checks.checks.erc),
      drcClearanceShorts: nativeFact(checks.checks.drcClearanceShorts), thermalPolicy: nativeFact(checks.checks.thermalPolicy) },
    nativeErcIdentity: checks.nativeErcIdentity === null || checks.nativeErcIdentity === undefined ? null : canonical(checks.nativeErcIdentity),
    ercSourceSetIdentity: checks.ercSourceScope === undefined ? null : canonical(checks.ercSourceScope.sourceSetIdentity),
    ercCoverage: checks.ercCoverage === undefined ? null : {
      ignoredChecks: checks.ercCoverage.ignoredChecks.map(check => ({ key: publicText(check.key), description: publicText(check.description) })),
      projectIgnoredCheckKeys: checks.ercCoverage.projectIgnoredCheckKeys.map(publicText),
      projectExclusionCount: checks.ercCoverage.projectExclusionCount, reportExcludedViolationCount: checks.ercCoverage.reportExcludedViolationCount,
      unexcludedViolationCount: checks.ercCoverage.unexcludedViolationCount, sheetCount: checks.ercCoverage.sheetCount,
      pinMapApplicability: checks.ercCoverage.pinMapApplicability,
      pinMapIdentity: checks.ercCoverage.pinMapIdentity === null ? null : canonical(checks.ercCoverage.pinMapIdentity),
    },
    drc: { status: drc.status, violationCount: drc.violationCount, schematicParityCount: drc.schematicParityCount,
      coordinateUnits: publicText(report.coordinate_units), includedSeverities: nativeList(report.included_severities).map(publicText),
      ignoredChecks: nativeList(report.ignored_checks).map(value => {
        const ignored = nativeRecord(value);
        return { key: publicText(ignored.key), description: publicText(ignored.description),
          severity: ignored.severity === undefined ? null : publicText(ignored.severity) };
      }), violations, unconnectedItems, schematicParity },
    thermalPads: checks.thermalPads.map(pad => ({ physicalPadUuid: publicText(pad.physicalPadUuid), footprintUuid: publicText(pad.footprintUuid),
      reference: publicText(pad.reference), number: publicText(pad.number), layer: publicText(pad.layer), zoneUuid: publicText(pad.zoneUuid),
      applicability: pad.applicability, minimumResolvedSpokes: pad.minimumResolvedSpokes, proof: pad.proof })),
    minimumResolvedSpokesMeaning: "declared-lower-bound-requires-qualified-proof" as const,
    ruleApplicability: checks.ruleApplicability, drcScope: checks.drcScope, nativeProviderCompletion: checks.nativeProviderCompletion,
    physicalSpokeCount: checks.physicalSpokeCount, physicalThermalWidth: checks.physicalThermalWidth,
    actualMinimumPlaneCopperWidth: checks.actualMinimumPlaneCopperWidth,
  };
}

const drillTopology = (value: FreshPlaneAcceptanceAssessment["planes"][number]["drillTopology"]) => ({
  schemaVersion: value.schemaVersion, identity: canonical(value.identity), status: value.status, issues: reasons(value.issues),
  savedEvidenceIdentity: value.savedEvidenceIdentity === null ? null : canonical(value.savedEvidenceIdentity),
  savedPcbIdentity: value.savedPcbIdentity === null ? null : content(value.savedPcbIdentity),
  cachedGeometryIdentity: value.cachedGeometryIdentity === null ? null : canonical(value.cachedGeometryIdentity),
  zoneUuid: value.zoneUuid === null ? null : publicText(value.zoneUuid), layer: value.layer,
  planarInteriorConnected: value.planarInteriorConnected,
  classificationComplete: value.classificationComplete,
  cachedAreaTwiceNm2: value.cachedAreaTwiceNm2, conservativeAreaLowerBoundTwiceNm2: value.conservativeAreaLowerBoundTwiceNm2,
  areaMeaning: value.areaMeaning,
  bores: value.bores.map(bore => ({ uuid: publicText(bore.uuid), kind: bore.kind,
    netName: bore.netName === null ? null : publicText(bore.netName),
    centerNm: { x: bore.centerNm.x, y: bore.centerNm.y }, diameterNm: bore.diameterNm,
    enclosureNm: bore.enclosureNm === null ? null : { minX: bore.enclosureNm.minX, minY: bore.enclosureNm.minY,
      maxX: bore.enclosureNm.maxX, maxY: bore.enclosureNm.maxY },
    classification: bore.classification, classificationBasis: bore.classificationBasis, issues: reasons(bore.issues), geometrySource: bore.geometrySource })),
  inventory: { sourcePadCount: value.inventory.sourcePadCount, nativePadCount: value.inventory.nativePadCount,
    sourceViaCount: value.inventory.sourceViaCount, boreCount: value.inventory.boreCount, complete: value.inventory.complete },
  physicalConnectivity: value.physicalConnectivity, actualMinimumCopperWidth: value.actualMinimumCopperWidth,
  terminalContactContinuity: value.terminalContactContinuity,
  bounds: { predicateOperations: value.bounds.predicateOperations, maximumBores: value.bounds.maximumBores,
    maximumPredicateOperations: value.bounds.maximumPredicateOperations },
});

/** Interface source evidence remains useful without a current native fill.
 * Its separate coverage fact records whether a current fill was available. */
function interfaceReports(assessment: FreshPlaneAcceptanceAssessment) {
  const checks = assessment.interfaces, evidence = assessment.evidence.interfaces;
  if (checks === undefined && evidence === undefined) return undefined;
  if (checks === undefined || evidence === undefined || checks.length !== evidence.length
      || new Set(checks.map(check => check.interfaceId)).size !== checks.length
      || new Set(evidence.map(item => item.interfaceId)).size !== evidence.length) {
    throw new Error("Interface evidence requires complete matching assessment collections.");
  }
  const constructionRows = assessment.rows.filter(row => row.kind === "interface_construction");
  if (constructionRows.length > 0) {
    const status = checks.some(check => check.construction.status === "failed") ? "fail"
      : checks.length > 0 && checks.every(check => check.construction.status === "verified") ? "pass" : "unknown";
    if (constructionRows.length !== 1 || constructionRows[0]!.id !== "interface-construction"
        || constructionRows[0]!.status !== status
        || canonicalJson(constructionRows[0]!.reasons) !== canonicalJson(checks.flatMap(check => check.construction.reasons))) {
      throw new Error("Interface construction row differs from its original V2 verification row.");
    }
  }
  return checks.map(check => {
    const saved = evidence.find(item => item.interfaceId === check.interfaceId);
    if (saved === undefined || canonicalJson(saved.identity) !== canonicalJson(check.assessmentIdentity)
        || canonicalJson(saved.sourceIdentity) !== canonicalJson(assessment.sourceIdentities.pcb)
        || canonicalJson(saved.bundleIdentity) !== canonicalJson(assessment.bundleIdentity)
        || canonicalJson(saved.contractIdentity) !== canonicalJson(assessment.contractIdentity)
        || canonicalJson(saved.verificationPlanIdentity) !== canonicalJson(assessment.verificationPlanIdentity)) {
      throw new Error("Interface evidence identity or source binding differs from the complete plane assessment.");
    }
    const reference = check.referenceCoverage, requirements = saved.referenceRequirements;
    const currentReferences = requirements.memberNets.map(net => assessment.references.filter(item => item.net === net && item.planeId === requirements.planeId));
    const referenceStatus = currentReferences.some(items => items.length === 1 && (items[0]!.status === "failed" || items[0]!.geometricStatus === "uncovered")) ? "failed"
      : assessment.savedEvidenceIdentity !== null && assessment.authority.status === "verified" && currentReferences.length > 0
        && currentReferences.every(items => items.length === 1 && items[0]!.status === "verified" && items[0]!.geometricStatus === "covered") ? "verified" : "unknown";
    if (reference.planeId !== requirements.planeId || canonicalJson(reference.memberNets) !== canonicalJson(requirements.memberNets)
        || reference.status !== referenceStatus || canonicalJson(reference.referenceRowIds)
          !== canonicalJson(currentReferences.flatMap(items => items.length === 1 ? [`reference:${items[0]!.net}`] : []))) {
      throw new Error("Interface reference coverage differs from the current plane assessment.");
    }
    const expectedRows: Array<readonly [string, string, typeof check.topology]> = [
      ["interface-topology", "interface_topology", check.topology],
      ["interface-geometry", "interface_pair_geometry", check.pairGeometry],
      ["interface-termination", "interface_termination", check.termination],
    ];
    if (saved.impedance.status !== "not_requested") expectedRows.push(["interface-impedance", "interface_impedance", check.impedance]);
    for (const [prefix, kind, value] of expectedRows) {
      const id = `${prefix}:${check.interfaceId}`, originals = assessment.rows.filter(row => row.id === id);
      if (originals.length !== 1 || originals[0]!.kind !== kind
          || originals[0]!.status !== (value.status === "verified" ? "pass" : value.status === "failed" ? "fail" : "unknown")
          || canonicalJson(originals[0]!.reasons) !== canonicalJson(value.reasons)) {
        throw new Error("Interface source row differs from its original V2 verification row.");
      }
    }
    return { ...summarizeSavedInterface(saved), acceptance: {
      construction: fact(check.construction), topology: fact(check.topology), pairGeometry: fact(check.pairGeometry),
      termination: fact(check.termination), impedance: fact(check.impedance), referenceCoverage: {
        ...fact(check.referenceCoverage), planeId: publicText(check.referenceCoverage.planeId),
        memberNets: check.referenceCoverage.memberNets.map(publicText), referenceRowIds: check.referenceCoverage.referenceRowIds.map(publicText),
      },
    } };
  });
}

function regionBridgeReports(assessment: FreshPlaneAcceptanceAssessment) {
  // Historical reports predate this additional observation.
  if (assessment.planeRegionBridges === undefined) return undefined;
  return assessment.planeRegionBridges.map(observation => {
    const c = observation.calculation, target = assessment.planes.find(p => p.planeId === observation.planeId);
    if (c !== null) {
      if (target === undefined || c.globalDrillClippedContinuityClaimed !== false || c.currentCapacityClaimed !== false || c.fabricationAuthorized !== false
        || c.allRegionsWitnessed !== c.regions.every(r => r.status === "witnessed")
        || canonicalJson(c.regions.map(r => r.nativePolygonIndex).sort((a,b)=>a-b))
          !== canonicalJson(target.geometry.components.map(r => r.nativePolygonIndex).sort((a,b)=>a-b)))
        throw new Error("Plane region witnesses are incomplete or claim unsupported authority.");
      for (const r of c.regions) {
        if (r.status === "witnessed" ? r.viaUuid === null || r.centerNm === null || !Number.isSafeInteger(r.contactDiscRadiusNm) || r.contactDiscRadiusNm! <= 0
          : r.status !== "unproven" || r.viaUuid !== null || r.centerNm !== null || r.contactDiscRadiusNm !== null)
          throw new Error("Plane region witness fields contradict their status.");
      }
    }
    if (observation.status === "verified" && (c === null || !c.allRegionsWitnessed)) throw new Error("Verified region bridges require every regional witness.");
    return { planeId: publicText(observation.planeId), referencePlaneId: publicText(observation.referencePlaneId),
      ...fact(observation), scope: observation.scope, calculation: c === null ? null : {
        scope: c.scope, allRegionsWitnessed: c.allRegionsWitnessed,
        regions: c.regions.map(r => ({ nativePolygonIndex: publicNumber(r.nativePolygonIndex), status: r.status,
          viaUuid: r.viaUuid === null ? null : publicText(r.viaUuid), centerNm: r.centerNm === null ? null
            : { x: publicNumber(r.centerNm.x), y: publicNumber(r.centerNm.y) }, contactDiscRadiusNm: r.contactDiscRadiusNm === null ? null : publicNumber(r.contactDiscRadiusNm) })),
        referenceNativePolygonIndex: publicNumber(c.referenceNativePolygonIndex), boreEnclosures: publicNumber(c.boreEnclosures),
        predicateOperations: publicNumber(c.predicateOperations), maximumPredicateOperations: publicNumber(c.maximumPredicateOperations),
        globalDrillClippedContinuityClaimed: false, currentCapacityClaimed: false, fabricationAuthorized: false,
      } };
  });
}

/** Closed public projection: raw captures, paths and contour arrays stay private. */
export function summarizePlaneAcceptance(assessment: FreshPlaneAcceptanceAssessment) {
  const common = commonSourceChecks(assessment);
  const interfaces = interfaceReports(assessment);
  const bridges = regionBridgeReports(assessment);
  return {
    schemaVersion: "evleda.toolbox-plane-acceptance.v1" as const,
    assessmentSchemaVersion: assessment.schemaVersion, assessmentIdentity: canonical(assessment.identity),
    family: assessment.family, status: assessment.status,
    bundleIdentity: canonical(assessment.bundleIdentity), contractIdentity: canonical(assessment.contractIdentity),
    verificationPlanIdentity: canonical(assessment.verificationPlanIdentity),
    sourceIdentities: { pcb: content(assessment.sourceIdentities.pcb), project: content(assessment.sourceIdentities.project),
      rules: content(assessment.sourceIdentities.rules) },
    savedEvidenceIdentity: assessment.savedEvidenceIdentity === null ? null : canonical(assessment.savedEvidenceIdentity),
    endpointConnectivityIdentity: canonical(assessment.endpointConnectivityIdentity),
    endpointConnectivity: { status: assessment.endpointConnectivity.status,
      nets: assessment.endpointConnectivity.nets.map(net => ({ net: net.net, status: net.status,
        everyEligiblePhysicalMemberReachable: net.everyEligiblePhysicalMemberReachable })) },
    authority: fact(assessment.authority), sourceScope: fact(assessment.sourceScope), nativeInventory: fact(assessment.nativeInventory),
    nativeChecks: nativeChecks(assessment),
    commonChecks: common?.summary ?? null,
    ...(interfaces === undefined ? {} : { interfaces }),
    planes: assessment.planes.map(plane => ({ planeId: plane.planeId, zoneUuid: plane.zoneUuid,
      configuration: fact(plane.configuration), geometry: geometry(plane.geometry),
      nativeGeometry: plane.nativeGeometry === null ? null : geometry(plane.nativeGeometry), componentCount: plane.componentCount,
      drillTopology: drillTopology(plane.drillTopology),
      nativePolygonAttribution: fact(plane.nativePolygonAttribution),
      minimumArea: { ...fact(plane.minimumArea), requiredAreaTwiceNm2: plane.minimumArea.requiredAreaTwiceNm2,
        observedAreaTwiceNm2: [...plane.minimumArea.observedAreaTwiceNm2], observedAreaMeaning: "stored-zone-fill-components" as const,
        conservativeAreaLowerBoundTwiceNm2: plane.minimumArea.conservativeAreaLowerBoundTwiceNm2 },
      intendedPlaneConnectivity: { ...fact(plane.intendedPlaneConnectivity), scope: plane.intendedPlaneConnectivity.scope,
        directEligiblePadAnchors: [...plane.intendedPlaneConnectivity.directEligiblePadAnchors],
        nativeDirectVias: [...plane.intendedPlaneConnectivity.nativeDirectVias] },
      islandPolicy: fact(plane.islandPolicy), actualMinimumCopperWidth: fact(plane.actualMinimumCopperWidth),
      thermalPolicy: fact(plane.thermalPolicy), actualThermalWidth: fact(plane.actualThermalWidth) })),
    ...(bridges === undefined ? {} : { planeRegionBridges: bridges }),
    references: assessment.references.map(reference => ({ net: reference.net, planeId: reference.planeId,
      ...fact(reference), segmentIds: [...reference.segmentIds], marginNm: reference.marginNm,
      geometricStatus: reference.geometricStatus, referenceTerminals: fact(reference.referenceTerminals),
      intersectingBoreUuids: reference.intersectingBoreUuids.map(publicText),tangentBoreUuids:reference.tangentBoreUuids.map(publicText) })),
    rows: assessment.rows.map(row => ({ id: row.id, kind: row.kind, status: row.status, reasons: reasons(row.reasons),
      ...(common?.observations.has(row.id) ? { observations: common.observations.get(row.id)! } : {}) })),
    verificationPlanRowsPassed: [...assessment.verificationPlanRowsPassed],
    mandatoryRowsRemaining: [...assessment.mandatoryRowsRemaining],
    acceptanceEvaluated: assessment.acceptanceEvaluated, accepted: assessment.accepted,
    fabricationAuthorized: assessment.fabricationAuthorized,
    limitations: { overallAcceptance: assessment.limitations.overallAcceptance,
      physicalThermalWidth: assessment.limitations.physicalThermalWidth,
      actualMinimumCopperWidth: assessment.limitations.actualMinimumCopperWidth,
      terminalContactContinuity: assessment.limitations.terminalContactContinuity,
      highFrequencyElectricalValidity: assessment.limitations.highFrequencyElectricalValidity,
      impedance: assessment.limitations.impedance, currentSourceGuards: assessment.limitations.currentSourceGuards },
  };
}

/** Full immutable evidence under host authority; no model chooses this directory. */
export async function captureToolboxPlaneAcceptance(outputRoot: string, assessment: FreshPlaneAcceptanceAssessment) {
  let captured: FreshPlaneAcceptanceAssessment;
  try {
    captured = hardenPortableValue(assessment, { maxBytes: MAX_BYTES, maxStringBytes: 1_048_576,
      maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 4096, maxKeyBytes: 512 }) as FreshPlaneAcceptanceAssessment;
  } catch (cause) {
    throw new Error("Complete plane acceptance evidence is invalid or exceeds its private artifact bound; no findings were truncated.", { cause });
  }
  const { identity, ...payload } = captured;
  if (captured.schemaVersion !== ASSESSMENT_VERSION || captured.family !== "plane-v2"
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, ASSESSMENT_VERSION))) {
    throw new Error("Plane acceptance identity or schema does not reproduce from its complete evidence.");
  }
  // This bounded evaluator cannot authorize overall acceptance. Reject even a
  // self-consistent forged success before reserving a private artifact.
  if (captured.accepted !== false || captured.fabricationAuthorized !== false || captured.acceptanceEvaluated !== true) {
    throw new Error("Plane acceptance evidence has unsupported overall acceptance claims.");
  }
  const bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
  if (bytes.length > MAX_BYTES) throw new Error("Complete plane acceptance evidence exceeds its private artifact bound; no findings were truncated.");
  const report = summarizePlaneAcceptance(captured);
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_PUBLIC_REPORT_BYTES) {
    throw new Error("Complete plane acceptance findings exceed the public response limit; no findings were truncated. The host must inspect the complete assessment.");
  }
  try {
    const root = path.resolve(outputRoot);
    if (!path.isAbsolute(outputRoot)) throw new Error("Plane acceptance output requires the exact host-owned directory.");
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("Plane acceptance output requires an ordinary unaliased directory.");
    }
    const assertRoot = async () => {
      const current = await lstat(root, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
          || await realpath(root) !== root) throw new Error("Plane acceptance evidence directory changed during publication.");
    };
    const filename = `plane-acceptance-${randomUUID()}.json`, target = path.join(root, filename);
    const handle = await open(target, "wx+", 0o600);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Plane acceptance reservation is not exclusive.");
      await assertRoot(); await handle.writeFile(bytes); await handle.sync();
      const written = await handle.stat({ bigint: true });
      const physical = await lstat(target, { bigint: true });
      if (!written.isFile() || written.dev !== opened.dev || written.ino !== opened.ino || written.nlink !== 1n
          || written.size !== BigInt(bytes.length) || !physical.isFile() || physical.isSymbolicLink()
          || physical.dev !== written.dev || physical.ino !== written.ino || physical.nlink !== 1n
          || physical.size !== written.size || await realpath(target) !== target) throw new Error("Plane acceptance artifact identity changed.");
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
        throw new Error("Plane acceptance readback differs from the complete evidence.");
      }
      await assertRoot();
      return { report, diagnostic: { filename, identity: contentIdentity(bytes) } };
    } finally { await handle.close(); }
  } catch (cause) {
    // The MCP error surface must not echo OS exceptions containing host paths.
    // Preserve the cause for the host; failed reservations are never erased.
    throw new Error("Plane acceptance private evidence publication failed; the host must inspect retained state.", { cause });
  }
}

export type ToolboxPlaneAcceptanceResult = Awaited<ReturnType<typeof captureToolboxPlaneAcceptance>>;
