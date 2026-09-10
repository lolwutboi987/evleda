import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { FreshPlaneAcceptanceAssessment } from "../harness/fresh-plane-acceptance.js";

const ASSESSMENT_VERSION = "evleda.fresh-plane-acceptance.v1";
const MAX_BYTES = 16 * 1024 * 1024;
const PRIVATE_PATH = /[\\/]|\b[A-Za-z]:/u;

// Reasons can include parser/native-check diagnostics. Preserve every finding,
// but leave path-bearing details in the hash-bound private assessment.
const reasons = (values: readonly string[]) => values.map(value => PRIVATE_PATH.test(value)
  ? "Private diagnostic detail retained in the complete assessment." : value);
const fact = (value: { readonly status: "verified" | "failed" | "unknown"; readonly reasons: readonly string[] }) => ({
  status: value.status, reasons: reasons(value.reasons),
});
const canonical = (value: CanonicalIdentity) => ({ algorithm: value.algorithm, digest: value.digest,
  schemaVersion: value.schemaVersion, canonicalizationVersion: value.canonicalizationVersion });
const content = (value: ContentIdentity) => ({ algorithm: value.algorithm, digest: value.digest, size: value.size });
const geometry = (value: FreshPlaneAcceptanceAssessment["planes"][number]["geometry"]) => ({
  status: value.status, issues: reasons(value.issues), geometryEquivalent: value.geometryEquivalent,
  sourceGeometryIdentity: value.sourceGeometryIdentity === null ? null : canonical(value.sourceGeometryIdentity),
  nativeGeometryIdentity: value.nativeGeometryIdentity === null ? null : canonical(value.nativeGeometryIdentity),
  components: value.components.map(component => ({ nativePolygonIndex: component.nativePolygonIndex,
    areaTwiceNm2: component.areaTwiceNm2, holeCount: component.holes.length,
    topologyCertificate: component.topologyCertificate })),
});

/** Closed public projection: raw captures, paths and contour arrays stay private. */
export function summarizePlaneAcceptance(assessment: FreshPlaneAcceptanceAssessment) {
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
    planes: assessment.planes.map(plane => ({ planeId: plane.planeId, zoneUuid: plane.zoneUuid,
      configuration: fact(plane.configuration), geometry: geometry(plane.geometry),
      nativeGeometry: plane.nativeGeometry === null ? null : geometry(plane.nativeGeometry), componentCount: plane.componentCount,
      nativePolygonAttribution: fact(plane.nativePolygonAttribution),
      minimumArea: { ...fact(plane.minimumArea), requiredAreaTwiceNm2: plane.minimumArea.requiredAreaTwiceNm2,
        observedAreaTwiceNm2: [...plane.minimumArea.observedAreaTwiceNm2] },
      intendedPlaneConnectivity: { ...fact(plane.intendedPlaneConnectivity),
        directEligiblePadAnchors: [...plane.intendedPlaneConnectivity.directEligiblePadAnchors],
        nativeDirectVias: [...plane.intendedPlaneConnectivity.nativeDirectVias] },
      islandPolicy: fact(plane.islandPolicy), actualMinimumCopperWidth: fact(plane.actualMinimumCopperWidth),
      thermalPolicy: fact(plane.thermalPolicy), actualThermalWidth: fact(plane.actualThermalWidth) })),
    references: assessment.references.map(reference => ({ net: reference.net, planeId: reference.planeId,
      ...fact(reference), segmentIds: [...reference.segmentIds], marginNm: reference.marginNm,
      geometricStatus: reference.geometricStatus, referenceTerminals: fact(reference.referenceTerminals) })),
    rows: assessment.rows.map(row => ({ id: row.id, kind: row.kind, status: row.status, reasons: reasons(row.reasons) })),
    verificationPlanRowsPassed: [...assessment.verificationPlanRowsPassed],
    mandatoryRowsRemaining: [...assessment.mandatoryRowsRemaining],
    acceptanceEvaluated: assessment.acceptanceEvaluated, accepted: assessment.accepted,
    fabricationAuthorized: assessment.fabricationAuthorized,
    limitations: { overallAcceptance: assessment.limitations.overallAcceptance,
      physicalThermalWidth: assessment.limitations.physicalThermalWidth,
      actualMinimumCopperWidth: assessment.limitations.actualMinimumCopperWidth,
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
