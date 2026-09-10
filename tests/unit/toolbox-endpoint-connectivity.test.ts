import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { FreshPlaneConnectivityAssessment } from "../../src/harness/fresh-plane-connectivity.js";
import { captureToolboxEndpointConnectivity, summarizeEndpointConnectivity } from "../../src/mcp/toolbox-endpoint-connectivity.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), "evleda-endpoints-")); roots.push(value); return value; }
function assessment() {
  const id = canonicalIdentity({ fixture: true }, "fixture.v1"), source = contentIdentity("saved source");
  const body = {
    schemaVersion: "evleda.fresh-plane-connectivity.v1", family: "plane-v2", status: "partially-connected",
    bundleIdentity: id, contractIdentity: id, verificationPlanIdentity: id, savedSourceIdentity: source,
    nativeSourceIdentity: source, nativeObservationIdentity: source, physicalLibraryBindingIdentity: id,
    physicalLibraryBindings: [{ privateDocument: "C:/private/footprint-library" }],
    nets: [{ net: "GND", topology: "plane", status: "connected", reasons: [],
      endpoints: [{ reference: "R2", pin: "2", physicalPadUuids: ["pad"], eligiblePhysicalPadUuids: ["pad"],
        ineligiblePhysicalPadUuids: [], nativeCopperCommon: { status: "proven", privateDocument: "C:/private/board" },
        componentInternalConnectivity: "not-inferred" }],
      logicalEndpointReachability: { status: "reachable", commonComponents: [] },
      everyEligiblePhysicalMemberReachable: true, observedComponents: [["pad"]], invalidReturnedPhysicalPadUuids: [],
      nativeQueries: [{ rawCapture: { document: "C:/private/board", request: { items: ["pad"] } } }] }],
    limitations: { intendedPlaneContact: "not_evaluated", fillFreshness: "not_established", highFrequencyValidity: "not_established" },
    verificationPlanRowsPassed: [], acceptanceEvaluated: false, fabricationAuthorized: false,
  };
  return { ...body, identity: canonicalIdentity(body, body.schemaVersion) } as unknown as FreshPlaneConnectivityAssessment;
}

describe("public endpoint assessment projection", () => {
  it("retains actionable reachability and limits without exposing raw requests or document paths", () => {
    const raw = assessment(), summary = summarizeEndpointConnectivity(raw), text = JSON.stringify(summary);
    expect(summary).toMatchObject({ schemaVersion: "evleda.toolbox-endpoint-connectivity.v1",
      assessmentSchemaVersion: "evleda.fresh-plane-connectivity.v1", assessmentIdentity: raw.identity,
      status: "partially-connected", nets: [{ net: "GND", status: "connected", nativeQueryCount: 1,
        endpoints: [{ reference: "R2", pin: "2", physicalPadUuids: ["pad"], copperCommonStatus: "proven" }] }],
      acceptanceEvaluated: false, fabricationAuthorized: false, verificationPlanRowsPassed: [] });
    expect(text).not.toContain("C:/private"); expect(text).not.toContain("rawCapture"); expect(text).not.toContain("nativeQueries");
    expect(summary).not.toHaveProperty("passed");
  });
  it("retains the complete raw assessment in a separate exact immutable artifact", async () => {
    const output = await root(), raw = assessment(), captured = await captureToolboxEndpointConnectivity(output, raw);
    expect(captured.diagnostic.filename).toMatch(/^endpoint-connectivity-[a-f0-9-]+\.json$/u);
    const bytes = await readFile(path.join(output, captured.diagnostic.filename));
    expect(contentIdentity(bytes)).toEqual(captured.diagnostic.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(raw);
    expect(bytes.toString("utf8")).toContain("C:/private/board");
    expect(JSON.stringify(captured)).not.toContain("C:/private");
    const again = await captureToolboxEndpointConnectivity(output, raw);
    expect(again.diagnostic.filename).not.toBe(captured.diagnostic.filename);
    expect(await readFile(path.join(output, captured.diagnostic.filename))).toEqual(bytes);
  });
  it("does not publish modified evidence with an old identity", async () => {
    const output = await root(), raw = assessment();
    await expect(captureToolboxEndpointConnectivity(output, { ...raw, status: "connected" })).rejects.toThrow(/identity/);
    expect(await readdir(output)).toEqual([]);
  });
  it("requires the configured ordinary absolute output directory", async () => {
    const output = await root();
    await expect(captureToolboxEndpointConnectivity(path.relative(process.cwd(), output), assessment())).rejects.toThrow(/host-owned/);
    await expect(captureToolboxEndpointConnectivity(path.join(output, "missing"), assessment())).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  });
});
