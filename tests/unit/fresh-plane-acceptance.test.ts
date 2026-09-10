import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { assessFreshPlaneAcceptance as runPlaneAcceptance, type FreshPlaneAcceptanceInput } from "../../src/harness/fresh-plane-acceptance.js";
import { prepareFreshPlaneConnectivity, assessFreshPlaneConnectivity } from "../../src/harness/fresh-plane-connectivity.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { collectKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";
import { isKicadPlaneContactsObservation, type KicadPlaneContactsObservation } from "../../src/integrations/kicad-plane-contacts.js";
import { createReferenceCoverageCalculator, type ReferenceCoverageCalculator, type ReferenceCoverageRequest } from "../../src/integrations/kicad-reference-coverage.js";
import { parseFreshPcbSource, parseFreshPcbReferenceGeometry } from "../../src/harness/fresh-kicad-parser.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { createPlaneContactsFixture } from "../helpers/kicad-plane-contacts-fixture.js";

// Synthetic bounded-process ports run through the real pinned reader/factory.
// No authenticity predicate is mocked, and no native executable is launched.
const collectors = new WeakMap<object, () => Promise<KicadPlaneContactsObservation>>();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function assessFreshPlaneAcceptance(input: FreshPlaneAcceptanceInput) {
  const collect = input.nativeContacts && collectors.get(input.nativeContacts);
  return runPlaneAcceptance(collect ? { ...input, nativeContacts: await collect() } : input);
}
type Raw = Record<string, any>;
const U = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
function board(options: { viaNet?: string; copperGraphic?: boolean } = {}) {
  const draft = planeDividerDraft();
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
    (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
    ${draft.components.map((component, i) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${U(10 + i)}") (layer "F.Cu") (at ${3 + 5 * i} 3)
      (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
      ${options.copperGraphic && i === 0 ? `(fp_line (start 0 0) (end 1 1) (stroke (width 0.2) (type default)) (layer "F.Cu"))` : ""}
      ${component.pins.map((pin, j) => { const net = pin.assignment.kind === "net" ? pin.assignment.net : "";
        return `(pad ${JSON.stringify(pin.pin)} thru_hole circle (uuid "${U(100 + i * 10 + j)}") (at 0 ${2 * j}) (size 1 1)
          (drill 0.4) (layers "*.Cu" "F.Mask" "B.Mask") (net ${JSON.stringify(net)}))`; }).join("\n")})`).join("\n")}
    (segment (start 3 3) (end 8 3) (width 0.5) (layer "F.Cu") (net "VIN") (uuid "${U(1)}"))
    ${options.viaNet ? `(via (at 13 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${options.viaNet}") (uuid "${U(2)}"))` : ""})\n`;
}
function bundle(minimumAreaMm2 = 0) {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const draft = planeDividerDraft(); draft.planes[0]!.islandPolicy.minimumAreaMm2 = minimumAreaMm2;
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Offline pure acceptance test fixture." }, dependencies);
}
async function fixture(options: Parameters<typeof board>[0] & { minimumAreaMm2?: number; disconnectedGround?: boolean; filledWidthMm?: number } = {}) {
  const compilationBundle = bundle(options.minimumAreaMm2), before = board(options);
  const prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: before, operation: "create" });
  const stageFixture = await planeStageObservationFixture({ beforePcbSource: before, mutation: prepared.mutation });
  if (options.filledWidthMm !== undefined) {
    // Change only the synthetic native fill result. Zone settings/outline and
    // pre-refill state stay exact; the production transcript validator rechecks it.
    const oldSource = stageFixture.stagedSource, fill = parseFreshPcbReferenceGeometry(oldSource).zones[0]!.filledPolygons[0]!;
    const x = options.filledWidthMm + 0.5, points = [[0.5, 0.5], [x, 0.5], [x, 19.5], [0.5, 19.5]];
    const changed = oldSource.replace(fill.source, `(filled_polygon (layer "B.Cu") (pts ${points.map(([a, b]) => `(xy ${a} ${b})`).join(" ")}))`);
    const receipt = stageFixture.receipt as Raw;
    stageFixture.stagedSource = changed; receipt.nativeSourceStaged = changed;
    receipt.identities.nativeSourceStaged = contentIdentity(changed);
    receipt.padSnapshot.boardSourceBefore = changed; receipt.padSnapshot.boardSourceAfter = changed;
    for (const call of receipt.rpc) if (call.response?.contents === oldSource) call.response.contents = changed;
    (stageFixture.stagedZoneProto as Raw).filled_polygons[0].shapes.polygons[0].outline.nodes = points.map(([a, b]) => ({ point: { x_nm: String(a! * 1e6), y_nm: String(b! * 1e6) } }));
  }
  const stage = validateFreshPlaneStageObservation(stageFixture.receipt, { ...stageFixture, prepared });
  const pcbSource = stageFixture.stagedSource, native = await nativePadObservationFixture(pcbSource);
  const scope = canonicalIdentity({ current: "synthetic-owned-scope" }, "evleda.synthetic-plane-test-scope.v1");
  const endpointInput = { compilationBundle, pcbPath: native.expected.pcbPath, pcbSource, scopeIdentity: scope,
    physicalFootprints: native.expected.physicalFootprints!, physicalFootprintResolver: native.expected.physicalFootprintResolver! };
  const endpointRequest = prepareFreshPlaneConnectivity(endpointInput), payload: Raw = structuredClone(native.observation.rawSnapshot);
  payload.connectivity = endpointRequest.nativePadExpected.requestedPrimitiveIds.map(id => payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === id));
  if (options.disconnectedGround) for (const query of payload.connectivity) {
    const source = payload.padRecords.find((pad: Raw) => pad.id.value === query.sourcePrimitiveId);
    if (source.net.name === "GND") query.padRecordIndexes = [payload.padRecords.indexOf(source)];
  }
  const captured = await collectKicadNativePadObservation({ async readLivePcbPadSnapshot() {
    return { isError: false, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
  } }, endpointRequest.nativePadExpected);
  const endpointConnectivity = assessFreshPlaneConnectivity({ ...endpointInput, nativePads: captured });
  const projectSettingsSource = "{}\n";
  // Rules are derived by the actual V2 preparation and remain exact bytes.
  const { createFreshPlaneRules } = await import("../../src/harness/fresh-plane-rules.js");
  const canonicalRules = createFreshPlaneRules(compilationBundle).source;
  const savedEvidence = createSavedFreshPlaneEvidence({ compilationBundle, stage, savedPcbSource: pcbSource,
    projectBindingIdentity: canonicalIdentity({ current: "project" }, "evleda.synthetic-project-binding.v1"), sourceScopeIdentity: scope,
    projectSettingsIdentity: contentIdentity(projectSettingsSource), rulesIdentity: contentIdentity(canonicalRules) });
  const parsed = parseFreshPcbSource(pcbSource), allPads = parsed.footprints.flatMap(fp => fp.pads.map(pad => ({ uuid: pad.physical.id!, nativeClass: "PAD", nativeType: 1,
    netCode: 1, netName: pad.netName!, footprintUuid: fp.id!, reference: fp.reference, number: pad.number,
    attribute: 0, localZoneConnection: -1, resolvedZoneConnectionOverride: -1, localThermalGapOverride: null,
    localThermalSpokeWidthOverride: null, padstackMode: 0, padstackUniqueLayers: [0],
    layers: stage.nativePads.inventory!.physicalPads.find(p => p.uuid === pad.physical.id)!.layerMembership.map((name, id) => ({ id, name: name.slice(3).replaceAll("_", "."),
      zoneLayerOverride: 0, effectivePadstackLayer: 0, hasExplicitPadstackDefinition: false })) })));
  const polygon = (stageFixture.stagedZoneProto as Raw).filled_polygons[0].shapes.polygons[0];
  const points = (raw: Raw) => raw.nodes.map((node: Raw) => [Number(node.point.x_nm ?? 0), Number(node.point.y_nm ?? 0)]);
  const contact = ({ uuid, nativeClass, nativeType, netCode, netName }: { uuid: string; nativeClass: string; nativeType: number; netCode: number; netName: string }) => ({ uuid, nativeClass, nativeType, netCode, netName, proxyType: nativeClass === "PCB_VIA" ? "PCB_TRACK" : nativeClass });
  const report: Raw = {
    zones: [{ uuid: stage.targetZoneUuid, nativeClass: "ZONE", nativeType: 18, netCode: 1, netName: "GND", isRuleArea: false, isFilled: true, needRefill: false,
      padConnection: 1, minimumThicknessNm: 500000,
      layers: [{ id: 2, name: "B.Cu", hasFilledPolys: true, fillFlag: 1, filledGeometrySha256: "0".repeat(64), filledSubpolygonCount: 1,
        subpolygons: [{ index: 0, sha256: "0".repeat(64), isIsland: false, outline: points(polygon.outline), holes: [] }] }],
      directPads: allPads.filter(pad => pad.netName === "GND").map(contact), directTracks: [], directVias: [] }], allPads,
    allFootprints: parsed.footprints.map(fp => ({ uuid: fp.id!, reference: fp.reference, localZoneConnection: -1, resolvedZoneConnectionOverride: -1 })),
    allTracks: [...parsed.segments.map(track => ({ uuid: track.id, nativeClass: "PCB_TRACK", nativeType: 13, netCode: 1, netName: track.netName, layers: [{ id: 0, name: track.layer }] })),
      ...parsed.vias.map(via => ({ uuid: via.id, nativeClass: "PCB_VIA", nativeType: 14, netCode: 1, netName: via.netName, layers: via.layers.map((name, id) => ({ id, name })) }))],
    inventory: { zoneCount: 1, padCount: allPads.length, footprintCount: parsed.footprints.length, trackCount: parsed.segments.length + parsed.vias.length } };
  const processFixture = await createPlaneContactsFixture({ pcbSource, report }); cleanups.push(processFixture.cleanup);
  const observation = {} as KicadPlaneContactsObservation;
  collectors.set(observation, async () => {
    for (const zone of report.zones) for (const layer of zone.layers) {
      const geometries = layer.subpolygons.map((polygon: Raw) => {
        const geometry = { outline: polygon.outline, holes: polygon.holes }; polygon.sha256 = contentIdentity(canonicalJson(geometry)).digest; return geometry;
      });
      layer.filledGeometrySha256 = contentIdentity(canonicalJson(geometries)).digest;
    }
    Object.assign(processFixture.report, report); return processFixture.reader.read();
  });
  const input: FreshPlaneAcceptanceInput = { compilationBundle, pcbSource, projectSettingsSource, rulesSource: canonicalRules, savedEvidence, endpointConnectivity, nativeContacts: observation };
  return { input, report, stageFixture, endpointInput, collect: collectors.get(observation)! };
}
function row(result: Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>, id: string) { return result.rows.find(row => row.id === id)!; }
async function calculator(status: "covered" | "uncovered" | "boundary_uncertain", requests: ReferenceCoverageRequest[] = []): Promise<ReferenceCoverageCalculator> {
  const temporary = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(temporary, "evleda-plane-reference-test-")));
  cleanups.push(async () => { const info = await lstat(root); if (path.dirname(root) !== temporary || await realpath(root) !== root || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe fixture cleanup"); await rm(root, { recursive: true, force: true }); });
  const executablePath = path.join(root, "synthetic.exe"), bytes = Buffer.from("Synthetic helper file; never executed."); await writeFile(executablePath, bytes);
  return createReferenceCoverageCalculator({ executablePath, expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length }, cwd: root, outputRoot: root, environment: {},
    runner: async options => {
      const input = await readFile(options.args[1]!), lines = input.toString("ascii").split("\n");
      const routes = lines.filter(line => line.startsWith("ROUTE ")).map(line => {
        const [x1Nm, y1Nm, x2Nm, y2Nm, widthNm, marginNm] = line.slice(6).split(" ").map(Number);
        return { x1Nm: x1Nm!, y1Nm: y1Nm!, x2Nm: x2Nm!, y2Nm: y2Nm!, widthNm: widthNm!, marginNm: marginNm! };
      });
      requests.push({ groups: [], routes });
      const envelope = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
      const output = { schemaVersion: 1, coordinateUnit: "nm", dcConnectivityClaimed: false, hfElectricalValidityClaimed: false,
        inputBase64: input.toString("base64"), implementationRevision: "evleda-reference-coverage-v1", sourceCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", clipperVersion: "1.3.0",
        normalizedCopper: envelope, diagnosticGeometry: "clipper_integer_quantized_not_a_continuous_geometry_proof", envelopeModel: "inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius",
        coverageMeaning: "closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin", routes: routes.map((_, routeIndex) => ({ routeIndex, status,
          certificate: status === "covered" ? "exact_outer_envelope_containment" : status === "uncovered" ? "exact_inner_envelope_outside_witness" : "no_exact_certificate",
          innerEnvelope: envelope, outerEnvelope: envelope, uncoveredOuterEnvelope: [], ...(status === "uncovered" ? { outsideWitnessDoubledNm: [0, 0] } : {}) })) };
      return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 0, stdout: JSON.stringify(output), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z" };
    } });
}

describe("pure current-source V2 plane acceptance", () => {
  it("assesses exact intended-plane contact and complete reference ribbons without promoting unmeasured requirements", async () => {
    const f = await fixture(), requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.authority.status).toBe("verified"); expect(result.nativeInventory.status).toBe("verified");
    expect(row(result, "plane-config:GND_PLANE").status).toBe("pass"); expect(row(result, "plane-net:GND").status).toBe("pass");
    expect(row(result, "reference:VIN").status).toBe("pass");
    expect(result.planes[0]!.componentCount).toBe(1); expect(result.planes[0]!.minimumArea.status).toBe("verified");
    expect(requests[0]!.routes).toEqual([{ x1Nm: 3_000_000, y1Nm: 3_000_000, x2Nm: 8_000_000, y2Nm: 3_000_000, widthNm: 500_000, marginNm: 500_000 }]);
    expect(row(result, "plane-fill:GND_PLANE").status).toBe("unknown"); expect(row(result, "plane-policy:GND_PLANE").status).toBe("unknown");
    expect(result.accepted).toBe(false); expect(result.status).toBe("incomplete"); expect(result.mandatoryRowsRemaining).toContain("visual");
    expect(result.rows).toHaveLength(f.input.compilationBundle.verificationPlan.requirements.length);
    expect(result.evidence.savedFill).toBe(f.input.savedEvidence); expect(isKicadPlaneContactsObservation(result.evidence.nativeContacts)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("requires current-session fill authority after resume and rejects copied branded evidence", async () => {
    const f = await fixture(); const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(result.verificationPlanRowsPassed).toEqual([]); expect(result.authority.reasons.join(" ")).toMatch(/reapply/i);
    await expect(assessFreshPlaneAcceptance({ ...f.input, savedEvidence: structuredClone(f.input.savedEvidence) })).rejects.toThrow(/current-session authority/);
    await expect(assessFreshPlaneAcceptance({ ...f.input, nativeContacts: structuredClone(await f.collect()) })).rejects.toThrow(/unbranded/);
    await expect(assessFreshPlaneAcceptance({ ...f.input, compilationBundle: structuredClone(f.input.compilationBundle) })).rejects.toThrow(/authenticated actual V2/);
  });

  it("rejects stale saved source, rules, project and endpoint identity", async () => {
    const f = await fixture();
    await expect(assessFreshPlaneAcceptance({ ...f.input, pcbSource: `${f.input.pcbSource}\n` })).rejects.toThrow(/different source/);
    await expect(assessFreshPlaneAcceptance({ ...f.input, rulesSource: `${f.input.rulesSource}\n` })).rejects.toThrow(/stale/);
    await expect(assessFreshPlaneAcceptance({ ...f.input, projectSettingsSource: "{\"changed\":true}" })).rejects.toThrow(/stale/);
    const copied = structuredClone(f.input.endpointConnectivity) as Raw; copied.nets[0].status = "disconnected";
    await expect(assessFreshPlaneAcceptance({ ...f.input, endpointConnectivity: copied as typeof f.input.endpointConnectivity })).rejects.toThrow(/unbranded endpoint/);
  });

  it("rejects recanonicalized reduced endpoint inventories and substituted native source hashes", async () => {
    const f = await fixture();
    for (const change of ["inventory", "native-source"] as const) {
      const copied = structuredClone(f.input.endpointConnectivity) as Raw;
      if (change === "inventory") copied.nets.find((net: Raw) => net.net === "GND").endpoints.splice(1);
      else copied.nativeSourceIdentity = contentIdentity("a different native board");
      const { identity: _identity, ...payload } = copied; copied.identity = canonicalIdentity(payload, copied.schemaVersion);
      await expect(assessFreshPlaneAcceptance({ ...f.input, endpointConnectivity: copied as typeof f.input.endpointConnectivity })).rejects.toThrow(/unbranded endpoint/);
    }
  });

  it("rejects a callable reference calculator that has not passed the host factory pin checks", async () => {
    const f = await fixture(); let called = false;
    const untrusted: ReferenceCoverageCalculator = { async calculate() { called = true; throw new Error("Must not run"); } };
    await expect(assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: untrusted })).rejects.toThrow(/authenticated host factory/);
    expect(called).toBe(false);
  });

  it("does not infer intended-plane contact from endpoint PAD reachability or direct vias alone", async () => {
    const f = await fixture({ viaNet: "GND" }); f.report.zones[0].directPads = [];
    f.report.zones[0].directVias = [{ uuid: U(2), nativeClass: "PCB_VIA", nativeType: 14, netCode: 1, proxyType: "PCB_TRACK", netName: "GND" }];
    const result = await assessFreshPlaneAcceptance(f.input);
    expect(result.endpointConnectivity.status).toBe("connected"); expect(result.sourceScope.status).toBe("verified");
    expect(row(result, "plane-net:GND").status).toBe("unknown"); expect(result.planes[0]!.intendedPlaneConnectivity.reasons.join(" ")).toMatch(/via-only/);
  });

  it("allows one direct physical PAD anchor only when every endpoint physical member shares its complete native cluster", async () => {
    const f = await fixture({ viaNet: "GND" }); f.report.zones[0].directPads = f.report.zones[0].directPads.slice(0, 1);
    const result = await assessFreshPlaneAcceptance(f.input); expect(row(result, "plane-net:GND").status).toBe("pass");
    const disconnected = await fixture({ disconnectedGround: true }); expect(row(await assessFreshPlaneAcceptance(disconnected.input), "plane-net:GND").status).toBe("fail");
  });

  it.each(["extra-pad", "wrong-net", "wrong-route-class", "missing-zone"])("rejects complete native inventory mismatch: %s", async change => {
    const f = await fixture();
    if (change === "extra-pad") { f.report.allPads.push({ ...f.report.allPads[0], uuid: U(99) }); f.report.inventory.padCount++; }
    if (change === "wrong-net") f.report.allPads[0].netName = "OTHER";
    if (change === "wrong-route-class") f.report.allTracks[0].nativeClass = "PCB_ARC";
    if (change === "missing-zone") { f.report.zones = []; f.report.inventory.zoneCount = 0; }
    const result = await assessFreshPlaneAcceptance(f.input); expect(result.nativeInventory.status).toBe("failed"); expect(row(result, "plane-net:GND").status).toBe("fail");
  });

  it.each(["split", "shifted", "island", "wrong-layer", "wrong-net"])("does not accept unqualified component attribution: %s", async change => {
    const f = await fixture(), zone = f.report.zones[0];
    if (change === "split") { zone.layers[0].subpolygons.push({ ...structuredClone(zone.layers[0].subpolygons[0]), index: 1 }); zone.layers[0].filledSubpolygonCount = 2; }
    if (change === "shifted") zone.layers[0].subpolygons[0].outline[0][0] += 1;
    if (change === "island") zone.layers[0].subpolygons[0].isIsland = true;
    if (change === "wrong-layer") zone.layers[0].name = "F.Cu";
    if (change === "wrong-net") { zone.netName = "OTHER"; zone.directPads = []; }
    const result = await assessFreshPlaneAcceptance(f.input);
    expect(result.planes[0]!.islandPolicy.status).not.toBe("verified"); expect(row(result, "reference:VIN").status).not.toBe("pass");
  });

  it.each(["uncovered", "boundary_uncertain"] as const)("keeps %s reference calculation non-passing", async status => {
    const f = await fixture(); const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator(status) });
    expect(row(result, "reference:VIN").status).toBe(status === "uncovered" ? "fail" : "unknown");
  });

  it("retains legitimate plane-access vias but rejects forbidden referenced-signal vias", async () => {
    const f = await fixture({ viaNet: "VIN" }), requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.sourceScope.status).toBe("verified"); expect(row(result, "reference:VIN").status).toBe("fail"); expect(requests).toHaveLength(0);
  });

  it("rejects footprint copper graphics structurally rather than ignoring them in reference projection", async () => {
    const f = await fixture({ copperGraphic: true }); const result = await assessFreshPlaneAcceptance(f.input);
    expect(result.sourceScope.status).toBe("failed"); expect(row(result, "reference:VIN").status).toBe("fail");
  });

  it("retains exact area threshold arithmetic rather than interpreting ALWAYS removal as area enforcement", async () => {
    const f = await fixture({ minimumAreaMm2: 0.0000000000005 });
    expect((await assessFreshPlaneAcceptance(f.input)).planes[0]!.minimumArea.requiredAreaTwiceNm2).toBe("1");
    const subHalf = await fixture({ minimumAreaMm2: 0.0000000000001 });
    expect((await assessFreshPlaneAcceptance(subHalf.input)).planes[0]!.minimumArea.requiredAreaTwiceNm2).toBe("0.2");
    const exact = await fixture({ minimumAreaMm2: 0.000000000001 }); const result = await assessFreshPlaneAcceptance(exact.input);
    expect(result.planes[0]!.minimumArea.requiredAreaTwiceNm2).toBe("2");
    expect(result.planes[0]!.minimumArea.observedAreaTwiceNm2).toEqual(["1102000000000000"]);
  });

  it("fails an actually smaller retained fill despite native ALWAYS removal and connected pads", async () => {
    const f = await fixture({ minimumAreaMm2: 300, filledWidthMm: 10 });
    const result = await assessFreshPlaneAcceptance(f.input);
    expect(result.planes[0]!.geometry.status).toBe("verified"); expect(result.planes[0]!.componentCount).toBe(1);
    expect(result.planes[0]!.minimumArea).toMatchObject({ status: "failed", requiredAreaTwiceNm2: "600000000000000", observedAreaTwiceNm2: ["380000000000000"] });
    expect(row(result, "plane-policy:GND_PLANE").status).toBe("fail"); expect(row(result, "reference:VIN").status).not.toBe("pass");
  });
});
