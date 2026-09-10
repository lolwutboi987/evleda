import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { FreshPlaneAcceptanceAssessment } from "../../src/harness/fresh-plane-acceptance.js";
import { captureToolboxPlaneAcceptance, summarizePlaneAcceptance } from "../../src/mcp/toolbox-plane-acceptance.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-plane-acceptance-")); roots.push(root); return root;
}
function assessment(changes: Record<string, unknown> = {}): FreshPlaneAcceptanceAssessment {
  const id = canonicalIdentity({ fixture: true }, "fixture.v1"), source = contentIdentity("saved source");
  const verified = { status: "verified", reasons: ["Source-bound fact."], privateRequest: { document: "C:/private/native-board" } };
  const unknown = { status: "unknown", reasons: ["Actual copper width remains unmeasured."] };
  const geometry = { status: "verified", issues: [], geometryEquivalent: true,
    sourceGeometryIdentity: id, nativeGeometryIdentity: id,
    components: [{ nativePolygonIndex: 0, areaTwiceNm2: "2000000000000000", topologyCertificate: "simple_outer_minus_strict_disjoint_holes",
      outer: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }],
      holes: [[{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 200 }]] }],
    bounds: { aggregateVertices: 6, predicateOperations: 20, limits: { aggregateVertices: 8192, predicateOperations: 4_000_000 } } };
  const body = {
    schemaVersion: "evleda.fresh-plane-acceptance.v1", family: "plane-v2", status: "failed",
    bundleIdentity: { ...id, privatePath: "C:/private/bundle" }, contractIdentity: id, verificationPlanIdentity: id,
    sourceIdentities: { pcb: { ...source, privatePath: "C:/private/board" }, project: source, rules: source },
    savedEvidenceIdentity: id, endpointConnectivityIdentity: id,
    endpointConnectivity: { status: "connected", nets: [{ net: "GND", status: "connected", everyEligiblePhysicalMemberReachable: true,
      rawCapture: { document: "C:/private/board" } }] },
    authority: verified, sourceScope: { status: "failed", reasons: ["Cannot inspect C:/private/board", "Missing source /private/source/board"] },
    nativeInventory: verified,
    planes: [{ planeId: "GND_PLANE", zoneUuid: "zone", configuration: verified, geometry, nativeGeometry: geometry,
      componentCount: 1, nativePolygonAttribution: verified,
      minimumArea: { ...verified, requiredAreaTwiceNm2: "1000000000000000", observedAreaTwiceNm2: ["2000000000000000"] },
      intendedPlaneConnectivity: { ...verified, directEligiblePadAnchors: ["pad"], nativeDirectVias: ["via"] },
      islandPolicy: verified, actualMinimumCopperWidth: unknown, thermalPolicy: unknown, actualThermalWidth: unknown }],
    references: [{ net: "VIN", planeId: "GND_PLANE", status: "unknown", reasons: ["Reference terminal evidence is incomplete."],
      segmentIds: ["track-1", "track-2"], marginNm: 100_000, geometricStatus: "boundary_uncertain", referenceTerminals: unknown,
      calculation: { artifacts: { path: "C:/private/calculation.json" }, request: { groups: [{ rings: [[1, 2, 3]] }] } } }],
    rows: [{ id: "contract:integrity", kind: "contract_integrity", status: "pass", reasons: ["Bound source agrees."] },
      { id: "plane-net:GND", kind: "plane_connectivity", status: "fail", reasons: ["Intended component is not connected."] },
      { id: "plane-fill:GND_PLANE", kind: "plane_fill", status: "unknown", reasons: ["No complete width evaluation."] }],
    verificationPlanRowsPassed: ["contract:integrity"], mandatoryRowsRemaining: ["plane-net:GND", "plane-fill:GND_PLANE"],
    acceptanceEvaluated: true, accepted: false, fabricationAuthorized: false,
    limitations: { overallAcceptance: "requires-every-mandatory-V2-row-and-independent-general-gates", physicalThermalWidth: "not-measured",
      actualMinimumCopperWidth: "not-measured", highFrequencyElectricalValidity: "not-established", impedance: "not-evaluated",
      currentSourceGuards: "required-of-owning-host-before-and-after-assessment", internalPath: "C:/private/policy" },
    evidence: { savedFill: { privateDocument: "C:/private/board", rawGeometry: geometry },
      endpointConnectivity: { rawRequests: [{ document: "C:/private/board" }] },
      nativeContacts: { contours: geometry.components }, nativeChecks: { reportPath: "C:/private/drc.json" } },
    ...changes,
  };
  return { ...body, identity: canonicalIdentity(body, "evleda.fresh-plane-acceptance.v1") } as unknown as FreshPlaneAcceptanceAssessment;
}

describe("public plane acceptance projection and private evidence", () => {
  it("keeps every row and actual fact while withholding nested paths, raw requests and contours", () => {
    const raw = assessment(), report = summarizePlaneAcceptance(raw), text = JSON.stringify(report);
    expect(report).toMatchObject({ schemaVersion: "evleda.toolbox-plane-acceptance.v1",
      assessmentSchemaVersion: "evleda.fresh-plane-acceptance.v1", assessmentIdentity: raw.identity,
      status: "failed", accepted: false, fabricationAuthorized: false, acceptanceEvaluated: true,
      planes: [{ componentCount: 1, geometry: { geometryEquivalent: true,
        components: [{ areaTwiceNm2: "2000000000000000", holeCount: 1 }] },
      intendedPlaneConnectivity: { status: "verified", directEligiblePadAnchors: ["pad"], nativeDirectVias: ["via"] },
      actualMinimumCopperWidth: { status: "unknown" } }],
      references: [{ segmentIds: ["track-1", "track-2"], geometricStatus: "boundary_uncertain", status: "unknown" }],
      rows: raw.rows, mandatoryRowsRemaining: ["plane-net:GND", "plane-fill:GND_PLANE"] });
    expect(report.rows).toHaveLength(raw.rows.length);
    expect(report.sourceScope.reasons).toHaveLength(2);
    for (const privateText of ["C:/private", "/private/source", "privatePath", "privateRequest", "rawCapture", '"evidence":', '"outer"', '"holes"', '"calculation"']) {
      expect(text).not.toContain(privateText);
    }
    expect(report).not.toHaveProperty("passed");
    expect(report).not.toHaveProperty("completed");
  });

  it("writes canonical complete evidence with exact readback and never replaces an earlier artifact", async () => {
    const root = await outputRoot(), raw = assessment(), first = await captureToolboxPlaneAcceptance(root, raw);
    expect(first.diagnostic.filename).toMatch(/^plane-acceptance-[a-f0-9-]+\.json$/u);
    expect(Object.keys(first.diagnostic).sort()).toEqual(["filename", "identity"]);
    const bytes = await readFile(path.join(root, first.diagnostic.filename));
    expect(bytes.toString("utf8")).toBe(`${canonicalJson(raw)}\n`);
    expect(contentIdentity(bytes)).toEqual(first.diagnostic.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(raw);
    expect(bytes.toString("utf8")).toContain("C:/private/calculation.json");
    expect(JSON.stringify(first)).not.toContain("C:/private");
    const second = await captureToolboxPlaneAcceptance(root, raw);
    expect(second.diagnostic.filename).not.toBe(first.diagnostic.filename);
    expect(second.diagnostic.identity).toEqual(first.diagnostic.identity);
    expect(await readFile(path.join(root, first.diagnostic.filename))).toEqual(bytes);
  });

  it("binds the public report to the detached artifact snapshot across asynchronous publication", async () => {
    const root = await outputRoot(), raw = assessment(), original = structuredClone(raw);
    const pending = captureToolboxPlaneAcceptance(root, raw);
    const mutable = raw as unknown as { rows: { status: string }[]; planes: { minimumArea: { observedAreaTwiceNm2: string[] } }[] };
    mutable.rows[1]!.status = "pass";
    mutable.planes[0]!.minimumArea.observedAreaTwiceNm2[0] = "1";
    const captured = await pending;
    expect(captured.report.rows[1]!.status).toBe("fail");
    expect(captured.report.planes[0]!.minimumArea.observedAreaTwiceNm2).toEqual(["2000000000000000"]);
    expect(JSON.parse(await readFile(path.join(root, captured.diagnostic.filename), "utf8"))).toEqual(original);
  });

  it.each(["Cannot inspect [/private/board]", "Native source:/private/board", "Cannot inspect C:private-board", "Native source C:\\private\\board"])("withholds embedded native paths: %s", reason => {
    const report=summarizePlaneAcceptance(assessment({sourceScope:{status:"failed",reasons:[reason]}}));
    expect(report.sourceScope.reasons).toEqual(["Private diagnostic detail retained in the complete assessment."]);
  });

  it("rejects stale identity before creating any file", async () => {
    const root = await outputRoot(), raw = assessment();
    await expect(captureToolboxPlaneAcceptance(root, { ...raw, status: "incomplete" })).rejects.toThrow(/identity/);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([{ schemaVersion: "foreign.v1" }, { family: "routed-v1" }, { accepted: true }, { fabricationAuthorized: true }])
    ("rejects unsupported schema or whole-design claims even with a new identity: %j", async changes => {
      const root = await outputRoot();
      await expect(captureToolboxPlaneAcceptance(root, assessment(changes))).rejects.toThrow(/schema|claims/);
      expect(await readdir(root)).toEqual([]);
    });

  it("rejects oversized complete evidence without truncating it into a report", async () => {
    const root = await outputRoot();
    const raw = assessment({ evidence: { rawNativeCaptures: Array.from({ length: 17 }, () => "x".repeat(1_048_576)) } });
    await expect(captureToolboxPlaneAcceptance(root, raw)).rejects.toThrow(/bound; no findings were truncated/);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not invoke accessors while taking its detached snapshot", async () => {
    const root = await outputRoot(), raw = assessment(); let called = false;
    Object.defineProperty(raw, "evidence", { enumerable: true, get: () => { called = true; return {}; } });
    await expect(captureToolboxPlaneAcceptance(root, raw)).rejects.toThrow(/invalid/);
    expect(called).toBe(false); expect(await readdir(root)).toEqual([]);
  });

  it("rejects relative, missing, non-directory and aliased output roots without leaking their paths", async () => {
    const root = await outputRoot(), real = path.join(root, "real"), alias = path.join(root, "alias"), file = path.join(root, "file");
    await mkdir(real); await writeFile(file, "retained");
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    for (const target of [path.relative(process.cwd(), real), path.join(root, "missing"), file, alias]) {
      const error = await captureToolboxPlaneAcceptance(target, assessment()).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Plane acceptance private evidence publication failed; the host must inspect retained state.");
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
    expect(await readdir(real)).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("retained");
  });
});
