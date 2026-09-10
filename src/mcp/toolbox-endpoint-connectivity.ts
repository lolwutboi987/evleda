import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { FreshPlaneConnectivityAssessment } from "../harness/fresh-plane-connectivity.js";

/** Keep raw native requests and document paths out of the public result. */
export function summarizeEndpointConnectivity(assessment: FreshPlaneConnectivityAssessment) {
  return {
    schemaVersion: "evleda.toolbox-endpoint-connectivity.v1" as const,
    assessmentSchemaVersion: assessment.schemaVersion, assessmentIdentity: assessment.identity,
    family: assessment.family, status: assessment.status,
    bundleIdentity: assessment.bundleIdentity, contractIdentity: assessment.contractIdentity,
    verificationPlanIdentity: assessment.verificationPlanIdentity,
    savedSourceIdentity: assessment.savedSourceIdentity, nativeSourceIdentity: assessment.nativeSourceIdentity,
    nativeObservationIdentity: assessment.nativeObservationIdentity,
    physicalLibraryBindingIdentity: assessment.physicalLibraryBindingIdentity,
    nets: assessment.nets.map(net => ({
      net: net.net, topology: net.topology, status: net.status, reasons: net.reasons,
      endpoints: net.endpoints.map(endpoint => ({ reference: endpoint.reference, pin: endpoint.pin,
        physicalPadUuids: endpoint.physicalPadUuids, eligiblePhysicalPadUuids: endpoint.eligiblePhysicalPadUuids,
        ineligiblePhysicalPadUuids: endpoint.ineligiblePhysicalPadUuids,
        copperCommonStatus: endpoint.nativeCopperCommon?.status ?? "not-assessed",
        componentInternalConnectivity: endpoint.componentInternalConnectivity })),
      logicalEndpointReachability: net.logicalEndpointReachability,
      everyEligiblePhysicalMemberReachable: net.everyEligiblePhysicalMemberReachable,
      observedComponents: net.observedComponents, invalidReturnedPhysicalPadUuids: net.invalidReturnedPhysicalPadUuids,
      nativeQueryCount: net.nativeQueries.length,
    })),
    limitations: assessment.limitations, verificationPlanRowsPassed: assessment.verificationPlanRowsPassed,
    acceptanceEvaluated: assessment.acceptanceEvaluated, fabricationAuthorized: assessment.fabricationAuthorized,
  };
}

/** Host-bound immutable full evidence, separate from the compact MCP projection. */
export async function captureToolboxEndpointConnectivity(outputRoot: string, assessment: FreshPlaneConnectivityAssessment) {
  const { identity, ...payload } = assessment;
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, "evleda.fresh-plane-connectivity.v1"))) {
    throw new Error("Endpoint assessment identity does not reproduce from its full evidence.");
  }
  const bytes = Buffer.from(`${canonicalJson(assessment)}\n`, "utf8");
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Complete endpoint evidence exceeds its private artifact bound; no findings were truncated.");
  const root = path.resolve(outputRoot), before = await lstat(root, { bigint: true });
  if (!path.isAbsolute(outputRoot) || !before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Endpoint evidence output is not the exact host-owned directory.");
  }
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || await realpath(root) !== root) throw new Error("Endpoint evidence directory changed during capture.");
  };
  const filename = `endpoint-connectivity-${randomUUID()}.json`, target = path.join(root, filename);
  const handle = await open(target, "wx+", 0o600);
  try {
    await assertRoot(); await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(bytes.length)) throw new Error("Endpoint evidence is not an exclusive complete artifact.");
    const readback = Buffer.alloc(bytes.length + 1); let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || !settled.isFile() || settled.isSymbolicLink() || settled.nlink !== 1n
        || settled.dev !== written.dev || settled.ino !== written.ino || settled.size !== written.size
        || await realpath(target) !== target) throw new Error("Endpoint evidence changed during exact readback.");
    await assertRoot();
    return { report: summarizeEndpointConnectivity(assessment), diagnostic: { filename, identity: contentIdentity(bytes) } };
  } finally { await handle.close(); }
}

export type ToolboxEndpointConnectivityResult = Awaited<ReturnType<typeof captureToolboxEndpointConnectivity>>;
