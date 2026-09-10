import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createToolboxReferenceCoverage, toolboxReferenceCoverageQuerySchema } from "../../src/mcp/toolbox-reference-coverage.js";
import { referenceCoverageRequestSchema, type ReferenceCoverageRequest, type ReferenceCoverageResult } from "../../src/integrations/kicad-reference-coverage.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const S1 = id(1), S2 = id(2), S3 = id(3), Z1 = id(101), Z2 = id(102);
const board = (body: string) => `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) ${body})`;
const segment = (uuid = S1, net = "SIG", layer = "F.Cu") => `(segment (start 1.000001 2) (end 8 2) (width 0.250001) (layer "${layer}") (net "${net}") (uuid "${uuid}"))`;
const ring = "(xy 0 0) (xy 20 0) (xy 20 20) (xy 0 20)";
const fill = (points = ring, layer = "B.Cu", extra = "") => `(filled_polygon (layer "${layer}") ${extra} (pts ${points}))`;
const zone = (uuid = Z1, net = "GND", layer = "B.Cu", fills = fill(undefined, layer), extra = "") => `(zone (net "${net}") (layer "${layer}") (uuid "${uuid}")
  (connect_pads yes (clearance 0.3)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
  (polygon (pts ${ring})) ${fills} ${extra})`;
const query = (extra: Record<string, unknown> = {}) => ({ signalNets: ["SIG"], signalLayer: "F.Cu", referenceNet: "GND", referenceLayer: "B.Cu",
  marginNm: 100000, marginBasis: "Explicit fixture geometry margin; not an electrical limit", ...extra });

/** Injected adapter result only; the actual clipping engine is tested in its own suite. */
function response(request: ReferenceCoverageRequest, statuses: readonly ReferenceCoverageResult["routes"][number]["status"][] = []): ReferenceCoverageResult {
  const envelope: [number, number][][] = [[[0, 0], [20000000, 0], [20000000, 20000000], [0, 20000000]]];
  return { schemaVersion: 1, implementationRevision: "evleda-reference-coverage-v1", sourceCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", clipperVersion: "1.3.0",
    coordinateUnit: "nm", normalizedCopper: request.groups.flatMap(group => group.rings),
    routes: request.routes.map((_route, routeIndex): ReferenceCoverageResult["routes"][number] => {
      const status = statuses[routeIndex] ?? "covered";
      return { routeIndex, status, certificate: status === "covered" ? "exact_outer_envelope_containment" : status === "uncovered" ? "exact_inner_envelope_outside_witness" : "no_exact_certificate",
        innerEnvelope: envelope, outerEnvelope: envelope, uncoveredOuterEnvelope: status === "covered" ? [] : envelope,
        ...(status === "uncovered" ? { outsideWitnessDoubledNm: [0, 0] as [number, number] } : {}) };
    }),
    diagnosticGeometry: "clipper_integer_quantized_not_a_continuous_geometry_proof", envelopeModel: "inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius",
    coverageMeaning: "closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin", dcConnectivityClaimed: false, hfElectricalValidityClaimed: false,
    executableIdentity: { sha256: "a".repeat(64), sizeBytes: 123 },
    artifacts: { input: { path: "fixture-input.txt", identity: contentIdentity(Buffer.from(JSON.stringify(request))) },
      rawOutput: { path: "fixture-output.json", identity: contentIdentity(Buffer.from("injected result, not a native execution")) } } };
}
async function fixture(source = board(segment() + zone())) {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-reference-")); roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb"); await writeFile(pcbPath, source);
  const calculate = vi.fn(async (input: unknown) => response(referenceCoverageRequestSchema.parse(input)));
  return { source, pcbPath, calculate, run: await createToolboxReferenceCoverage({ pcbPath, calculator: { calculate } }) };
}

describe("toolbox saved-source reference coverage", () => {
  it("supports the full explicit 0–50 mm plane-contract margin range without silently narrowing it", () => {
    expect(toolboxReferenceCoverageQuerySchema.parse(query({ marginNm: 50_000_000 })).marginNm).toBe(50_000_000);
    expect(() => toolboxReferenceCoverageQuerySchema.parse(query({ marginNm: 50_000_001 }))).toThrow();
  });

  it("selects exact nets, layers and UUIDs and forwards integer-nm saved geometry with explicit margin", async () => {
    const f = await fixture(board(segment() + segment(S2) + segment(S3, "OTHER") + segment(id(4), "SIG", "B.Cu")
      + zone() + zone(Z2, "OTHER") + zone(id(103), "GND", "F.Cu")));
    const result = await f.run(query({ segmentIds: [S2], zoneIds: [Z1], expectedSourceSha256: contentIdentity(Buffer.from(f.source)).digest }));
    expect(result.status).toBe("computed"); if (result.status !== "computed") throw new Error("Expected computed fixture result");
    expect(result.selectedSegments.map(entry => entry.uuid)).toEqual([S2]);
    expect(result.selectedZones.map(entry => entry.uuid)).toEqual([Z1]);
    expect(f.calculate).toHaveBeenCalledExactlyOnceWith({ groups: [{ rings: [[[0, 0], [20000000, 0], [20000000, 20000000], [0, 20000000]]] }],
      routes: [{ x1Nm: 1000001, y1Nm: 2000000, x2Nm: 8000000, y2Nm: 2000000, widthNm: 250001, marginNm: 100000 }] });
    expect(result.sourceIdentity).toEqual(contentIdentity(Buffer.from(f.source)));
    expect(result.selectedSegments[0]!.sourceIdentity).toEqual(contentIdentity(Buffer.from(segment(S2))));
    expect(result.routeResults[0]).toMatchObject({ segmentId: S2, netName: "SIG", routeIndex: 0, certificate: "exact_outer_envelope_containment" });
    expect(result.calculation.artifacts.rawOutput).toEqual((await f.calculate.mock.results[0]!.value).artifacts.rawOutput);
    expect(result.selectionCoverage).toMatchObject({ allMatchingStraightSegmentsSelected: false, omittedMatchingSegmentIds: [S1], fullBoardGeometry: false });
  });

  it("labels partial zone selection and preserves unsupported/unselected source observations", async () => {
    const f = await fixture(board(segment() + zone() + zone(Z2) + '(arc (uuid "00000000-0000-4000-8000-000000000030")) (future_copper (layer "B.Cu"))'));
    const result = await f.run(query({ zoneIds: [Z1] }));
    expect(result.status).toBe("computed");
    expect(result.selectionCoverage).toMatchObject({ allMatchingZonesSelected: false, omittedMatchingZoneIds: [Z2], inventory: "supported_saved_straight_segments_and_declared_copper_zones", fullBoardGeometry: false });
    expect(result.unmodeledSource.routeItems[0]!.kind).toBe("arc");
    expect(result.unmodeledSource.otherItems[0]!.kind).toBe("future_copper");
    expect(result.evidenceStatus).toMatchObject({ fillFreshness: "unverified_saved_cache", dcConnectivity: "not_evaluated", impedance: "not_evaluated", highFrequencyValidity: "not_established", marginBasis: "caller_stated_not_approved" });
    expect(result).not.toHaveProperty("passed");
  });

  it.each([
    { segmentIds: [id(999)] }, { zoneIds: [id(999)] }, { signalNets: ["sig"] }, { referenceNet: "gnd" },
    { signalNets: ["SIG", "ABSENT"] }, { segmentIds: [S3] }, { zoneIds: [Z2] },
  ])("does not calculate a missing or mismatched exact selection %j", async selection => {
    const f = await fixture(board(segment() + segment(S3, "OTHER") + zone() + zone(Z2, "OTHER")));
    const result = await f.run(query(selection));
    expect(result.status).toBe("not_assessed"); expect(result.geometricStatus).toBe("not_assessed");
    expect(f.calculate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing zone", source: board(segment()) },
    { name: "empty fill cache", source: board(segment() + zone(Z1, "GND", "B.Cu", "")) },
    { name: "wrong fill layer", source: board(segment() + zone(Z1, "GND", "B.Cu", fill(undefined, "F.Cu"))) },
    { name: "unknown fill geometry", source: board(segment() + zone(Z1, "GND", "B.Cu", fill(undefined, "B.Cu", "(future_hole 1)"))) },
    { name: "duplicate zone identity", source: board(segment() + zone() + zone()) },
    { name: "rule area", source: board(segment() + zone(Z1, "GND", "B.Cu", fill(), "(keepout (tracks not_allowed))")) },
    { name: "sub-nm contour", source: board(segment() + zone(Z1, "GND", "B.Cu", fill("(xy 0.0000001 0) (xy 20 0) (xy 20 20)"))) },
    { name: "degenerate calculator ring", source: board(segment() + zone(Z1, "GND", "B.Cu", fill("(xy 0 0) (xy 1 1) (xy 2 2)"))) },
  ])("keeps $name not assessed without inventing empty-cache coverage", async ({ source }) => {
    const f = await fixture(source); const result = await f.run(query());
    expect(result.status).toBe("not_assessed"); expect(result.geometricStatus).toBe("not_assessed");
    expect(f.calculate).not.toHaveBeenCalled();
  });

  it("forwards a compact fractured contour intact and preserves separate fill groups", async () => {
    // Same saved fractured-chain representation exercised by kicad-reference-source.test.ts.
    const fractured = "(xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10) (xy 0 5) (xy 4 5) (xy 4 6) (xy 6 6) (xy 6 4) (xy 4 4) (xy 4 5) (xy 0 5)";
    const f = await fixture(board(segment() + zone(Z1, "GND", "B.Cu", fill(fractured) + fill("(xy 12 0) (xy 20 0) (xy 20 10) (xy 12 10)"))));
    const result = await f.run(query()); expect(result.status).toBe("computed");
    const request = referenceCoverageRequestSchema.parse(f.calculate.mock.calls[0]![0]);
    expect(request.groups).toHaveLength(2); expect(request.groups[0]!.rings).toHaveLength(1);
    expect(request.groups[0]!.rings[0]).toHaveLength(12);
    expect(request.groups[0]!.rings[0]!.filter(([x, y]) => x === 4000000 && y === 5000000)).toHaveLength(2);
  });

  it.each([
    { statuses: ["covered", "covered"] as const, expected: "covered" },
    { statuses: ["covered", "boundary_uncertain"] as const, expected: "boundary_uncertain" },
    { statuses: ["boundary_uncertain", "uncovered"] as const, expected: "uncovered" },
  ])("preserves per-route certificates and reports $expected only for the selected projection", async ({ statuses, expected }) => {
    const f = await fixture(board(segment() + segment(S2) + zone()));
    f.calculate.mockImplementationOnce(async input => response(referenceCoverageRequestSchema.parse(input), statuses));
    const result = await f.run(query()); if (result.status !== "computed") throw new Error("Expected computed fixture result");
    expect(result.geometricStatus).toBe(expected);
    expect(result.routeResults.map(route => route.segmentId)).toEqual([S1, S2]);
    expect(result.routeResults.map(route => route.status)).toEqual(statuses);
    if (expected === "uncovered") expect(result.routeResults[1]!.outsideWitnessDoubledNm).toEqual([0, 0]);
    expect(result.evidenceStatus.stackupAndLayerAdjacency).toBe("not_evaluated");
  });

  it("rejects a stale selected source and changes during the awaited calculation", async () => {
    const f = await fixture();
    await expect(f.run(query({ expectedSourceSha256: "0".repeat(64) }))).rejects.toThrow("selected source revision");
    expect(f.calculate).not.toHaveBeenCalled();
    f.calculate.mockImplementationOnce(async input => {
      await writeFile(f.pcbPath, f.source + "\n");
      return response(referenceCoverageRequestSchema.parse(input));
    });
    await expect(f.run(query())).rejects.toThrow("changed during reference coverage");
  });

  it("keeps caller mutation and BOM/CRLF outside any silently normalized source authority", async () => {
    const f = await fixture("\uFEFF" + board(segment() + zone()).replaceAll(" ", "\r\n "));
    const argument = query();
    f.calculate.mockImplementationOnce(async input => {
      argument.marginNm = 0; argument.signalNets[0] = "OTHER";
      return response(referenceCoverageRequestSchema.parse(input));
    });
    const result = await f.run(argument); expect(result.status).toBe("computed");
    expect(result.sourceIdentity).toEqual(contentIdentity(Buffer.from(f.source)));
    expect(result.request).toMatchObject({ marginNm: 100000, signalNets: ["SIG"] });
  });

  it.each(["empty", "count", "index", "certificate", "electrical"])("rejects %s calculator output instead of deriving a covered result", async kind => {
    const f = await fixture();
    f.calculate.mockImplementationOnce(async input => {
      const value = response(referenceCoverageRequestSchema.parse(input));
      if (kind === "empty") value.routes = [];
      if (kind === "count") value.routes.push({ ...value.routes[0]! });
      if (kind === "index") value.routes[0]!.routeIndex = 1;
      if (kind === "certificate") value.routes[0]!.certificate = "no_exact_certificate";
      if (kind === "electrical") (value as unknown as { dcConnectivityClaimed: boolean }).dcConnectivityClaimed = true;
      return value;
    });
    await expect(f.run(query())).rejects.toThrow("calculator");
  });

  it("requires explicit subset selection above limits without truncating source geometry", async () => {
    const manySegments = await fixture(board(Array.from({ length: 65 }, (_, i) => segment(id(i + 1))).join("") + zone()));
    expect((await manySegments.run(query())).status).toBe("selection_required"); expect(manySegments.calculate).not.toHaveBeenCalled();
    const manyZones = await fixture(board(segment() + Array.from({ length: 33 }, (_, i) => zone(id(i + 101))).join("")));
    expect((await manyZones.run(query())).status).toBe("selection_required"); expect(manyZones.calculate).not.toHaveBeenCalled();
    expect((await manyZones.run(query({ zoneIds: [Z1] }))).selectionCoverage.omittedMatchingZoneIds).toHaveLength(32);
  });

  it("rejects missing/fractional margins, duplicate selections, coplanar requests and model paths", async () => {
    const f = await fixture();
    const missing = query(); delete (missing as Partial<typeof missing>).marginNm;
    for (const value of [missing, query({ marginNm: 0.5 }), query({ marginBasis: " " }), query({ signalNets: ["SIG", "SIG"] }),
      query({ referenceLayer: "F.Cu" }), query({ pcbPath: "other.kicad_pcb" })]) await expect(f.run(value)).rejects.toThrow();
    expect(f.calculate).not.toHaveBeenCalled();
  });
});
