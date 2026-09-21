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
import { isFreshPlaneCommonChecksAssessment } from "../../src/harness/fresh-plane-common-checks.js";
import { captureToolboxPlaneAcceptance, summarizePlaneAcceptance } from "../../src/mcp/toolbox-plane-acceptance.js";
import { assessFreshPlaneNativeChecks, FRESH_PLANE_NATIVE_CHECK_PROFILE } from "../../src/harness/fresh-plane-native-checks.js";
import type { KicadCheckResult, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { interfaceConstructionBundle, interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";
import { usbChannelBundle } from "../helpers/usb-channel-bundle.js";
import { usbChannelPcb, usbChannelSourceId } from "../helpers/usb-channel-source.js";
import { fourLayerPlaneBundle, fourLayerPlaneDraft } from "../helpers/four-layer-plane-bundle.js";
import { createKicadTransmissionLineCalculator, KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
  KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION, KICAD_TRANSMISSION_LINE_SOURCE_COMMIT } from "../../src/integrations/kicad-transmission-line.js";

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
type NmPoint = readonly [number, number];
interface BoardOptions {
  viaNet?: string;
  copperGraphic?: boolean;
  surfaceSignalPads?: boolean;
  launchHeader?: boolean;
  routeNm?: { start: NmPoint; end: NmPoint };
  probeBoreNm?: NmPoint;
  outline?: string;
  routeWidthNm?: number;
  viaDrillNm?: number;
}
const mm = (value: number) => {
  const integer = BigInt(value), magnitude = integer < 0n ? -integer : integer;
  return `${integer < 0n ? "-" : ""}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, "0")}`;
};
function board(options: BoardOptions = {}) {
  const draft = planeDividerDraft();
  const route: { start: NmPoint; end: NmPoint } = options.routeNm ?? { start: [3_000_000, 3_000_000], end: [8_000_000, 3_000_000] };
  const origin = (index: number): NmPoint => index === 0 ? route.start : index === 1 ? route.end : [13_000_000, 3_000_000];
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
    (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
    ${draft.components.map((component, i) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${U(10 + i)}") (layer "F.Cu") (at ${origin(i).map(mm).join(" ")})
      (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
      ${options.copperGraphic && i === 0 ? `(fp_line (start 0 0) (end 1 1) (stroke (width 0.2) (type default)) (layer "F.Cu"))` : ""}
      ${component.pins.map((pin, j) => { const net = pin.assignment.kind === "net" ? pin.assignment.net : "";
        const surface = options.surfaceSignalPads && !(component.reference === "J1" && (pin.pin === "3" || options.launchHeader && pin.pin === "1"));
        // Keep the one plated ground anchor at (3,7) mm while moving signal
        // terminals with the exact test route; its bore cannot mask probe cases.
        const at = options.routeNm && component.reference === "J1" && pin.pin === "3"
          ? [mm(3_000_000 - origin(i)[0]), mm(7_000_000 - origin(i)[1])].join(" ") : `0 ${2 * j}`;
        return `(pad ${JSON.stringify(pin.pin)} ${surface ? "smd rect" : "thru_hole circle"} (uuid "${U(100 + i * 10 + j)}") (at ${at}) (size 1 1)
          ${surface ? `(layers "F.Cu")` : `(drill 0.4) (layers "*.Cu" "F.Mask" "B.Mask")`} (net ${JSON.stringify(net)}))`; }).join("\n")})`).join("\n")}
    ${options.outline ?? `(gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "${U(9)}"))`}
    (segment (start ${route.start.map(mm).join(" ")}) (end ${route.end.map(mm).join(" ")}) (width ${mm(options.routeWidthNm ?? 500_000)}) (layer "F.Cu") (net "VIN") (uuid "${U(1)}"))
    ${options.viaNet ? `(via (at 13 5) (size 0.6) (drill ${mm(options.viaDrillNm ?? 300_000)}) (layers "F.Cu" "B.Cu") (net "${options.viaNet}") (uuid "${U(2)}"))` : ""}
    ${options.probeBoreNm ? `(via (at ${options.probeBoreNm.map(mm).join(" ")}) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${U(3)}"))` : ""})\n`;
}
function bundle(minimumAreaMm2 = 0) {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const draft = planeDividerDraft(); draft.planes[0]!.islandPolicy.minimumAreaMm2 = minimumAreaMm2;
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Offline pure acceptance test fixture." }, dependencies);
}
function interfaceBoard(compilationBundle: FreshPlaneAcceptanceInput["compilationBundle"], widthMm = 0.5) {
  const seed = createInterfaceConstructionBoardSeed(compilationBundle).trimEnd();
  const footprints = compilationBundle.contract.components.map((component, index) => `(footprint ${JSON.stringify(component.footprintLibId)}
    (uuid "${U(10 + index)}") (layer "F.Cu") (at ${3 + 5 * index} 3)
    (property "Reference" "${component.reference}") (property "Value" ${JSON.stringify(component.value)})
    ${component.pins.map((pin, pad) => { const net = pin.assignment.kind === "net" ? pin.assignment.net : ""; return `(pad "${pin.pin}" ${pad === 2 ? "thru_hole circle" : "smd rect"}
      (uuid "${U(100 + 10 * index + pad)}") (at 0 ${pad === 2 ? 4 : pad}) (size 0.5 0.5)
      ${pad === 2 ? '(drill 0.2) (layers "*.Cu" "F.Mask" "B.Mask")' : '(layers "F.Cu")'} (net "${net}"))`; }).join("\n")})`);
  return `${seed.slice(0, -1)}\n${footprints.join("\n")}
    (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "${U(9)}"))
    (segment (start 3 3) (end 8 3) (width ${widthMm}) (layer "F.Cu") (net "DP") (uuid "${U(1)}"))
    (segment (start 3 4) (end 8 4) (width ${widthMm}) (layer "F.Cu") (net "DN") (uuid "${U(2)}")))\n`;
}
async function fixture(options: Parameters<typeof board>[0] & { minimumAreaMm2?: number; disconnectedGround?: boolean; filledWidthMm?: number; projectSettingsSource?: string;
  compilationBundle?: FreshPlaneAcceptanceInput["compilationBundle"]; pcbSource?: string; splitSupplemental?: boolean; retainedPadLayers?: boolean } = {}) {
  const compilationBundle = options.compilationBundle ?? bundle(options.minimumAreaMm2), before = options.pcbSource ?? board(options);
  let prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: before, planeId: compilationBundle.contract.planes[0]!.id, operation: "create" });
  const split = (id: string) => options.splitSupplemental && id === "BACK_GND" ? { filledContoursNm: [
    [[500000,500000],[14500000,500000],[14500000,19500000],[500000,19500000]],
    [[15500000,500000],[29500000,500000],[29500000,19500000],[15500000,19500000]],
  ] as const } : {};
  let stageFixture = await planeStageObservationFixture({ beforePcbSource: before, mutation: prepared.mutation, ...(options.retainedPadLayers ? { retainedPadLayers: true } : {}), ...split(compilationBundle.contract.planes[0]!.id) });
  for (const plane of compilationBundle.contract.planes.slice(1)) {
    prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: stageFixture.stagedSource, planeId: plane.id, operation: "create" });
    stageFixture = await planeStageObservationFixture({ beforePcbSource: stageFixture.stagedSource, mutation: prepared.mutation,
      beforeZoneProtos: [stageFixture.stagedZoneProto], zoneId: U(900), ...(options.retainedPadLayers ? { retainedPadLayers: true } : {}), ...split(plane.id) });
  }
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
  const pcbSource = stageFixture.stagedSource, native = await nativePadObservationFixture(pcbSource, pcbSource, options);
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
  const projectSettingsSource = options.projectSettingsSource ?? "{}\n";
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
  const layerId = (name: string) => name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : name === "In1.Cu" ? 4 : 6;
  const points = (raw: Raw) => raw.nodes.map((node: Raw) => [Number(node.point.x_nm ?? 0), Number(node.point.y_nm ?? 0)]);
  const contact = ({ uuid, nativeClass, nativeType, netCode, netName }: { uuid: string; nativeClass: string; nativeType: number; netCode: number; netName: string }) => ({ uuid, nativeClass, nativeType, netCode, netName, proxyType: nativeClass === "PCB_VIA" ? "PCB_TRACK" : nativeClass });
  const report: Raw = {
    zones: stage.nativeFilledZones.map(zone => {
      const sourceZone = parseFreshPcbReferenceGeometry(pcbSource).zones.find(source => source.uuid === zone.uuid)!;
      const layer = sourceZone.layers[0]!;
      const polygons = (zone.raw as Raw).filled_polygons[0].shapes.polygons;
      return { uuid: zone.uuid, nativeClass: "ZONE", nativeType: 18, netCode: 1, netName: "GND", isRuleArea: false, isFilled: true, needRefill: false,
      padConnection: 1, minimumThicknessNm: 500000,
      layers: [{ id: layerId(layer), name: layer, hasFilledPolys: true, fillFlag: 1, filledGeometrySha256: "0".repeat(64), filledSubpolygonCount: polygons.length,
        subpolygons: polygons.map((polygon: Raw,index: number)=>({ index, sha256: "0".repeat(64), isIsland: false, outline: points(polygon.outline), holes: [] })) }],
      directPads: allPads.filter(pad => pad.netName === "GND" && pad.layers.some(member => member.name === layer)).map(contact), directTracks: [], directVias: [] }; }), allPads,
    allFootprints: parsed.footprints.map(fp => ({ uuid: fp.id!, reference: fp.reference, localZoneConnection: -1, resolvedZoneConnectionOverride: -1 })),
    allTracks: [...parsed.segments.map(track => ({ uuid: track.id, nativeClass: "PCB_TRACK", nativeType: 13, netCode: 1, netName: track.netName, layers: [{ id: 0, name: track.layer }] })),
      ...parsed.vias.map(via => ({ uuid: via.id, nativeClass: "PCB_VIA", nativeType: 14, netCode: 1, netName: via.netName, layers: compilationBundle.contract.scope.board.copperLayers.map(name => ({ id: layerId(name), name })) }))],
    inventory: { zoneCount: stage.nativeFilledZones.length, padCount: allPads.length, footprintCount: parsed.footprints.length, trackCount: parsed.segments.length + parsed.vias.length } };
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

/** Complete synthetic CLI port result, validated by the actual branded native
 * checks assessor. No native process or authentication predicate is replaced. */
async function ercFixture(kind: "clean" | "violation" | "ignored" | "missing", options: NonNullable<Parameters<typeof fixture>[0]> = {}) {
  const project = { board: { design_settings: { rule_severities: {
    ...Object.fromEntries(FRESH_PLANE_NATIVE_CHECK_PROFILE.requiredClearanceShortChecks.map(key => [key, "error"])),
    ...Object.fromEntries(FRESH_PLANE_NATIVE_CHECK_PROFILE.requiredViaManufacturingChecks.map(key => [key, "warning"])), starved_thermal: "error" },
    rules: { min_resolved_spokes: 2, max_error: 0.005 }, drc_exclusions: [] } },
    erc: { rule_severities: { single_global_label: "error", footprint_filter: "error", simulation_model_issue: "error", four_way_junction: "error" } } };
  if (kind === "ignored") project.erc.rule_severities.single_global_label = "ignore";
  const f = await fixture({ surfaceSignalPads: true, ...options, projectSettingsSource: JSON.stringify(project) });
  const projectRoot = "D:\\evleda-offline-pad-fixture", pcbPath = `${projectRoot}\\fixture.kicad_pcb`, schematicPath = `${projectRoot}\\fixture.kicad_sch`;
  const executable: KicadExecutableIdentity = { kind: "kicad-cli", path: "C:\\offline-pinned\\kicad-cli.exe", version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "1".repeat(64), sizeBytes: 1234,
    capabilityHelpSha256: "2".repeat(64), confirmedCapabilities: ["pcb drc", "sch erc"] };
  const sourceHashes = { "fixture.kicad_pcb": contentIdentity(f.input.pcbSource).digest, "fixture.kicad_pro": contentIdentity(f.input.projectSettingsSource).digest,
    "fixture.kicad_dru": contentIdentity(f.input.rulesSource).digest, "fixture.kicad_sch": contentIdentity("synthetic schematic").digest,
    "sym-lib-table": contentIdentity("synthetic symbol table").digest, "fp-lib-table": contentIdentity("synthetic footprint table").digest };
  const invocation = (args: string[], exitCode = 0) => ({ executable, command: executable.path, cwd: projectRoot, exitCode,
    stdout: "Synthetic completed native check", stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z", args });
  const drcPath = "D:\\offline-checks\\drc.json", ercPath = "D:\\offline-checks\\erc.json", count = kind === "violation" ? 1 : 0;
  const native: Raw = { classification: "candidate-validation", releaseAuthorized: false, executable, sourceHashes, clean: count === 0,
    drc: { kind: "drc", status: "clean", reportPath: drcPath, violationCount: 0, schematicParityCount: 0,
      invocation: invocation(["pcb", "drc", "--output", drcPath, "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--schematic-parity", pcbPath]),
      report: { $schema: "https://schemas.kicad.org/drc.v1.json", coordinate_units: "mm", kicad_version: "10.0.3", source: "fixture.kicad_pcb",
        included_severities: ["error", "warning", "exclusion"], ignored_checks: [], violations: [], unconnected_items: [], schematic_parity: [] } },
    erc: { kind: "erc", status: count ? "violations" : "clean", reportPath: ercPath, violationCount: count, schematicParityCount: 0,
      invocation: invocation(["sch", "erc", "--output", ercPath, "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", schematicPath], count ? 5 : 0),
      report: { $schema: "https://schemas.kicad.org/erc.v1.json", coordinate_units: "mm", kicad_version: "10.0.3", source: "fixture.kicad_sch",
        included_severities: ["error", "warning", "exclusion"], ignored_checks: kind === "ignored" ? [{ key: "single_global_label", description: "Ignored explicit fixture rule" }] : [],
        sheets: [{ path: "/", uuid_path: "/", violations: count ? [{ type: "pin_not_connected", severity: "error", description: "Synthetic unconnected pin", excluded: false }] : [] }] } } };
  if (kind === "missing") delete native.erc;
  const saved = f.input.savedEvidence!;
  const nativeChecks = assessFreshPlaneNativeChecks({ compilationBundle: f.input.compilationBundle, savedEvidence: saved,
    current: { projectBindingIdentity: saved.projectBindingIdentity, sourceScopeIdentity: saved.sourceScopeIdentity },
    sources: { projectRoot, pcbPath, pcbSource: f.input.pcbSource, projectPath: `${projectRoot}\\fixture.kicad_pro`, projectSource: f.input.projectSettingsSource,
      rulesPath: `${projectRoot}\\fixture.kicad_dru`, rulesSource: f.input.rulesSource }, expectedSourceHashes: sourceHashes,
    expectedExecutable: executable, nativeChecks: native as KicadCheckResult });
  return { ...f, nativeChecks };
}
function row(result: Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>, id: string) { return result.rows.find(row => row.id === id)!; }
type ReferenceResult = "covered" | "uncovered" | "boundary_uncertain";
async function calculator(status: ReferenceResult | readonly ReferenceResult[], requests: ReferenceCoverageRequest[] = []): Promise<ReferenceCoverageCalculator> {
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
      const observedStatus = typeof status === "string" ? status : status[requests.length] ?? "boundary_uncertain";
      requests.push({ groups: [], routes });
      const envelope = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
      const output = { schemaVersion: 1, coordinateUnit: "nm", dcConnectivityClaimed: false, hfElectricalValidityClaimed: false,
        inputBase64: input.toString("base64"), implementationRevision: "evleda-reference-coverage-v1", sourceCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", clipperVersion: "1.3.0",
        normalizedCopper: envelope, diagnosticGeometry: "clipper_integer_quantized_not_a_continuous_geometry_proof", envelopeModel: "inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius",
        coverageMeaning: "closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin", routes: routes.map((_, routeIndex) => ({ routeIndex, status: observedStatus,
          certificate: observedStatus === "covered" ? "exact_outer_envelope_containment" : observedStatus === "uncovered" ? "exact_inner_envelope_outside_witness" : "no_exact_certificate",
          innerEnvelope: envelope, outerEnvelope: envelope, uncoveredOuterEnvelope: [], ...(observedStatus === "uncovered" ? { outsideWitnessDoubledNm: [0, 0] } : {}) })) };
      return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 0, stdout: JSON.stringify(output), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z" };
    } });
}

/** Synthetic bounded process response through the genuine pinned calculator
 * factory. This verifies plumbing and evidence handling, not native physics. */
async function transmissionLineCalculator(differentialOhm: number) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-interface-transline-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "synthetic.exe"), bytes = Buffer.from("Factory identity fixture; never executed.");
  await writeFile(executablePath, bytes);
  const units = (name: string) => ["H", "T", "PHYS_WIDTH", "PHYS_LEN", "H_T", "ROUGH", "PHYS_S", "STRIPLINE_A"].includes(name) ? "m"
    : name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : name === "ANG_L" ? "rad" : name.startsWith("Z0") ? "ohm" : "1";
  return createKicadTransmissionLineCalculator({ executablePath, cwd: root, environment: {},
    expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length },
    runner: async options => {
      const inputs = Object.fromEntries(options.args.filter(arg => arg.includes("=")).map(arg => {
        const [name, value] = arg.split("=");
        return [name!, value === "absent" ? { value: "absent", unit: "1" } : { value: Number(value), unit: units(name!) }];
      }));
      const result = (value: number, unit: string) => ({ value, unit, status: "ok" });
      const output = { schemaVersion: KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION, implementationRevision: KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
        sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: options.args[1], operation: options.args[3], converged: true, valid: true, inputs,
        results: { PHYS_WIDTH: result(Number(inputs.PHYS_WIDTH!.value), "m"), PHYS_LEN: result(Number(inputs.PHYS_LEN!.value), "m"),
          PHYS_S: result(Number(inputs.PHYS_S!.value), "m"), Z0_O: result(differentialOhm / 2, "ohm"), Z0_E: result(70, "ohm"), Z_DIFF: result(differentialOhm, "ohm") } };
      return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 0,
        stdout: JSON.stringify(output), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z" };
    } });
}

const horizontal = { start: [5_000_000, 12_000_000], end: [10_000_000, 12_000_000] } as const;
const vertical = { start: [7_500_000, 9_500_000], end: [7_500_000, 14_500_000] } as const;
// A 3-4-5 direction gives exact integer-nm perpendicular distances. These
// cases test the reference-ribbon predicate, not the separate miter_45 row.
const diagonal = { start: [5_000_000, 10_500_000], end: [9_000_000, 13_500_000] } as const;
const boreCases: Array<{ name: string; route: { start: NmPoint; end: NmPoint }; center: NmPoint; intersects: boolean;tangent?:true }> = [
  { name: "horizontal body 1 nm overlap", route: horizontal, center: [7_500_000, 12_949_999], intersects: true },
  { name: "horizontal body exact tangent", route: horizontal, center: [7_500_000, 12_950_000], intersects: false,tangent:true },
  { name: "horizontal body 1 nm outside", route: horizontal, center: [7_500_000, 12_950_001], intersects: false },
  { name: "start cap 1 nm overlap", route: horizontal, center: [4_050_001, 12_000_000], intersects: true },
  { name: "start cap exact tangent", route: horizontal, center: [4_050_000, 12_000_000], intersects: false,tangent:true },
  { name: "start cap 1 nm outside", route: horizontal, center: [4_049_999, 12_000_000], intersects: false },
  { name: "end cap 1 nm overlap", route: horizontal, center: [10_949_999, 12_000_000], intersects: true },
  { name: "end cap exact tangent", route: horizontal, center: [10_950_000, 12_000_000], intersects: false,tangent:true },
  { name: "end cap 1 nm outside", route: horizontal, center: [10_950_001, 12_000_000], intersects: false },
  { name: "vertical body 1 nm overlap", route: vertical, center: [8_449_999, 12_000_000], intersects: true },
  { name: "vertical body exact tangent", route: vertical, center: [8_450_000, 12_000_000], intersects: false,tangent:true },
  { name: "vertical body 1 nm outside", route: vertical, center: [8_450_001, 12_000_000], intersects: false },
  { name: "3-4-5 diagonal body 1 nm overlap", route: diagonal, center: [6_429_999, 12_759_998], intersects: true },
  { name: "3-4-5 diagonal body exact tangent", route: diagonal, center: [6_430_000, 12_760_000], intersects: false,tangent:true },
  { name: "3-4-5 diagonal body 1 nm outside", route: diagonal, center: [6_430_001, 12_760_002], intersects: false },
  { name: "projection exactly at start, tangent", route: horizontal, center: [5_000_000, 12_950_000], intersects: false,tangent:true },
  { name: "projection exactly at end, tangent", route: horizontal, center: [10_000_000, 12_950_000], intersects: false,tangent:true },
  { name: "diagonal projection exactly at start, tangent", route: diagonal, center: [4_430_000, 11_260_000], intersects: false,tangent:true },
  { name: "diagonal projection exactly at end, tangent", route: diagonal, center: [8_430_000, 14_260_000], intersects: false,tangent:true },
];

describe("pure current-source V2 plane acceptance", () => {
  it.each(["covered", "boundary_uncertain"] as const)("completes a %s reference result only with actual ground-terminal copper paths", async status => {
    const f = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: true, viaNet: "GND" });
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator(status) });
    const reference = result.references.find(r => r.net === "VIN")!;
    expect(reference.geometricStatus).toBe(status);
    expect(reference.resolvedGeometricStatus).toBe("covered");
    expect(reference.referenceCopperConnectivity!.status).toBe("verified");
    expect(reference.referenceCopperConnectivity!.physicalPadUuids.length).toBeGreaterThan(0);
    expect(row(result, "reference:VIN").status).toBe("pass");
    expect(row(result, "plane-fill:GND_PLANE").status).toBe("unknown");
    if (status === "boundary_uncertain") {
      expect(reference.capsuleRefinement!.result).toMatchObject({ allRoutesContained: true, drillsIncluded: false, terminalConnectivityClaimed: false });
      expect((reference.calculation as Raw).routes[0].status).toBe("boundary_uncertain");
    } else expect(reference.capsuleRefinement).toBeUndefined();
    const publicReference = summarizePlaneAcceptance(result).references.find(r => r.net === "VIN")!;
    expect(publicReference.geometricStatus).toBe(status);
    expect(publicReference.resolvedGeometricStatus).toBe("covered");
    expect(publicReference.referenceCopperConnectivity!.status).toBe("verified");
    expect(result.accepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
  });
  it("preserves exact reference tangency and an original uncovered result after ground paths pass", async () => {
    const f = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: true, viaNet: "GND",
      routeNm: { start: [3_000_000, 1_250_000], end: [8_000_000, 1_250_000] } });
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("boundary_uncertain") });
    const reference = result.references.find(r => r.net === "VIN")!;
    expect(reference.referenceCopperConnectivity!.status).toBe("verified");
    expect(reference.capsuleRefinement!.result!.allRoutesContained).toBe(false);
    expect(reference.capsuleRefinement!.result!.routes[0]!.boundaryRelation).toBe("tangent");
    expect(reference.resolvedGeometricStatus).toBe("boundary_uncertain"); expect(row(result, "reference:VIN").status).toBe("unknown");
    expect(summarizePlaneAcceptance(result).references[0]!.resolvedGeometricStatus).toBe("boundary_uncertain");
    const clear = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: true, viaNet: "GND" });
    const uncovered = await assessFreshPlaneAcceptance({ ...clear.input, nativeChecks: clear.nativeChecks, referenceCoverage: await calculator("uncovered") });
    expect(uncovered.references[0]!.referenceCopperConnectivity!.status).toBe("verified");
    expect(uncovered.references[0]!.capsuleRefinement).toBeUndefined();
    expect(row(uncovered, "reference:VIN").status).toBe("fail");
  });
  it("does not publish a reference success with missing paths or a changed exact-refinement scope", async () => {
    const f = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: true, viaNet: "GND" });
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("boundary_uncertain") });
    for (const change of ["pad", "missing-refinement", "route", "margin", "component", "claims", "original-failure"] as const) {
      const bad: Raw = structuredClone(result), reference = bad.references.find((r: Raw) => r.net === "VIN");
      if (change === "pad") reference.referenceCopperConnectivity.physicalPadUuids = [U(999)];
      if (change === "missing-refinement") delete reference.capsuleRefinement;
      if (change === "route") reference.capsuleRefinement.result.routes = [];
      if (change === "margin") reference.capsuleRefinement.result.marginNm--;
      if (change === "component") reference.capsuleRefinement.result.nativePolygonIndex++;
      if (change === "claims") reference.capsuleRefinement.result.highFrequencyValidityClaimed = true;
      if (change === "original-failure") reference.geometricStatus = "uncovered";
      expect(() => summarizePlaneAcceptance(bad as Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>)).toThrow();
    }
  });
  it("completes only the plane-net row when every physical terminal has an actual drilled-copper path", async () => {
    const f = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: false }), result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks });
    expect(result.planes[0]!.terminalCopperConnectivity, JSON.stringify(result.planes[0]!.terminalCopperConnectivity?.reasons)).toMatchObject({ status: "verified", calculation: { allTerminalsWitnessed: true } });
    expect(row(result, "plane-net:GND").status).toBe("pass");
    expect(row(result, "plane-fill:GND_PLANE").status).toBe("unknown");
    expect(row(result, "plane-policy:GND_PLANE").status).toBe("unknown");
    expect(result.accepted).toBe(false);
    const report = summarizePlaneAcceptance(result);
    expect(report.planes[0]!.terminalCopperConnectivity!.calculation!.terminals).toHaveLength(2);
    expect(report.limitations.terminalContactContinuity).toBe("per-plane-source-native-geometric-witnesses-where-reported");
  });
  it("does not substitute native reachability for a missing surface-terminal copper path", async () => {
    const f = await ercFixture("clean", { retainedPadLayers: true, surfaceSignalPads: true }), result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks });
    expect(result.planes[0]!.intendedPlaneConnectivity.status).toBe("verified");
    expect(result.planes[0]!.terminalCopperConnectivity, JSON.stringify(result.planes[0]!.terminalCopperConnectivity?.reasons)).toMatchObject({ status: "unknown", calculation: { allTerminalsWitnessed: false } });
    expect(row(result, "plane-net:GND").status).toBe("unknown");
    expect(result.planes[0]!.terminalCopperConnectivity!.calculation!.terminals.some(t => t.status === "unproven")).toBe(true);
  });
  it("does not erase a disconnected-native-net failure or manufacture paths without fresh fill", async () => {
    const f = await ercFixture("clean", { retainedPadLayers: true, disconnectedGround: true, surfaceSignalPads: false });
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks });
    expect(row(result, "plane-net:GND").status).toBe("fail");
    expect(result.planes[0]!.terminalCopperConnectivity!.calculation).toBeNull();
    const reopened = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(reopened.planes).toEqual([]);
    expect(row(reopened, "plane-net:GND").status).toBe("unknown");
  });
  it("retains four channel reference requirements and source-series anchors while physical termination remains unknown", async () => {
    const compilationBundle = usbChannelBundle();
    let source = usbChannelPcb();
    source = source.replace(parseFreshPcbReferenceGeometry(source).zones[0]!.source, "")
      .replaceAll('(at 0 0) (uuid', '(at 5 7) (uuid')
      .replace(/\((start|end|xy) (-?[0-9.]+) (-?[0-9.]+)\)/gu, (_match, kind, x, y) => `(${kind} ${Number(x) + 5} ${Number(y) + 7})`)
      .replace(`(at 5 7) (uuid "${usbChannelSourceId(30)}")`, `(at 5 8) (uuid "${usbChannelSourceId(30)}")`)
      .replace('(pad "1" smd rect (at 1 1)', '(pad "1" smd rect (at 1 0)')
      .replace('(pad "2" smd rect (at 2 1)', '(pad "2" smd rect (at 2 0)');
    const f = await fixture({ compilationBundle, pcbSource: source });
    const result = await assessFreshPlaneAcceptance(f.input), channel = result.interfaces![0]!;
    expect(channel.referenceCoverage.memberNets).toEqual(["DP", "DN", "LP", "LN"]);
    expect(channel.referenceCoverage.referenceRowIds).toEqual(["reference:DP", "reference:DN", "reference:LP", "reference:LN"]);
    expect(result.evidence.interfaces![0]!.channel!.anchors).toHaveLength(14);
    expect(result.evidence.interfaces![0]!.terminations.pins).toHaveLength(4);
    expect(channel.topology.status).toBe("verified");
    expect(channel.termination.status).toBe("unknown");
    expect(result.evidence.interfaces![0]!.impedance.completeRouteModelCoverage).toBe(false);
    expect(result.accepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
  });
  it("preserves the legacy assessment and public shape when no interfaces are declared", async () => {
    const f = await fixture(), result = await assessFreshPlaneAcceptance(f.input);
    expect(result).not.toHaveProperty("interfaces"); expect(result.evidence).not.toHaveProperty("interfaces");
    expect(summarizePlaneAcceptance(result)).not.toHaveProperty("interfaces");
    expect(result.rows.map(check => ({ id: check.id, kind: check.kind }))).toEqual(
      f.input.compilationBundle.verificationPlan.requirements.map(check => ({ id: check.id, kind: check.kind })));
  });

  it("retains a known saved pair width failure without issuing current-fill authority", async () => {
    const compilationBundle = interfaceConstructionBundle(), f = await fixture({ compilationBundle, pcbSource: interfaceBoard(compilationBundle, 0.7) });
    const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(result.authority.status).toBe("unknown"); expect(result.evidence.commonChecks).toBeNull();
    expect(result.references).toEqual([]); expect(result.status).toBe("failed");
    expect(row(result, "interface-geometry:LINK").status).toBe("fail");
    expect(result.rows.filter(check => !check.kind.startsWith("interface_")).every(check => check.status === "unknown")).toBe(true);
    expect(result.interfaces![0]!.referenceCoverage.status).toBe("unknown");
    expect(result.evidence.interfaces![0]!.sourceIdentity).toEqual(contentIdentity(f.input.pcbSource));
    expect(result.evidence.interfaces![0]!.bundleIdentity).toEqual(compilationBundle.identity);
    expect(result.accepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
    const projected = summarizePlaneAcceptance(result);
    expect(projected.interfaces![0]!.acceptance.pairGeometry.status).toBe("failed");
    expect(projected.rows).toHaveLength(result.rows.length);
    expect(JSON.stringify(projected)).not.toContain("(kicad_pcb");
  });

  it("retains a saved construction mismatch independently of missing fill and model evidence", async () => {
    const compilationBundle = interfaceConstructionBundle();
    const pcbSource = interfaceBoard(compilationBundle).replace("(thickness 1.57)", "(thickness 1.58)");
    const f = await fixture({ compilationBundle, pcbSource });
    const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(row(result, "interface-construction").status).toBe("fail");
    expect(result.evidence.interfaces![0]!.construction.status).toBe("failed_saved_declaration");
    expect(result.interfaces![0]!.referenceCoverage.status).toBe("unknown");
    expect(result.status).toBe("failed"); expect(result.authority.status).toBe("unknown");
    expect(summarizePlaneAcceptance(result).rows.find(check => check.id === "interface-construction")!.status).toBe("fail");
  });

  it("requires both current reference ribbons and ground-terminal copper before the complete interface geometry row can pass", async () => {
    const compilationBundle = interfaceConstructionBundle(), f = await ercFixture("clean", { compilationBundle, pcbSource: interfaceBoard(compilationBundle), retainedPadLayers: true });
    const missingFill = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(row(missingFill, "interface-geometry:LINK").status).toBe("unknown");
    const missingCalculator = await assessFreshPlaneAcceptance(f.input);
    expect(row(missingCalculator, "interface-geometry:LINK").status).toBe("unknown");
    const requests: ReferenceCoverageRequest[] = [];
    const onlyNative = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered") });
    expect(row(onlyNative, "interface-geometry:LINK").status).toBe("unknown");
    const covered = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("covered", requests) });
    expect(covered.evidence.interfaces![0]!.sourceInventory.reasons).toEqual([]);
    expect(covered.references).toHaveLength(2); expect(requests).toHaveLength(2);
    expect(covered.references.every(reference => reference.status === "verified" && reference.geometricStatus === "covered")).toBe(true);
    expect(row(covered, "interface-topology:LINK").status).toBe("pass");
    expect(row(covered, "interface-geometry:LINK").status).toBe("pass");
    expect(row(covered, "interface-termination:LINK").status).toBe("pass");
    expect(covered.rows.map(check => check.id)).toEqual(compilationBundle.verificationPlan.requirements.map(check => check.id));
    expect(row(covered, "plane-net:GND").status).toBe("pass");
    expect(row(covered, "reference:DP").status).toBe("pass");
    expect(row(covered, "reference:DN").status).toBe("pass");
    expect(summarizePlaneAcceptance(covered).interfaces![0]!.acceptance.referenceCoverage.status).toBe("verified");
    expect(covered.accepted).toBe(false); expect(covered.fabricationAuthorized).toBe(false);
    const uncovered = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("uncovered") });
    expect(row(uncovered, "interface-geometry:LINK").status).toBe("fail");
  });

  it("keeps a declared differential model unknown when its host calculator is unavailable", async () => {
    const draft = interfaceConstructionDraft(), pair = draft.interfaceRequirements.interfaces[0];
    draft.interfaceRequirements.construction.surfaceFinish = "bare copper";
    pair.impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 10, frequencyHz: 100_000_000,
      constructionId: "STACK", source: pair.source };
    const compilationBundle = interfaceConstructionBundle(draft), f = await fixture({ compilationBundle, pcbSource: interfaceBoard(compilationBundle) });
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered") });
    expect(row(result, "interface-impedance:LINK").status).toBe("unknown");
    expect(result.mandatoryRowsRemaining).toContain("interface-impedance:LINK");
    expect(result.evidence.interfaces![0]!.impedance.status).toBe("unassessed");
  });

  it("uses declared source and receiver roles for integrated termination source facts", async () => {
    const draft = interfaceConstructionDraft(), pair = draft.interfaceRequirements.interfaces[0];
    for (const [side, componentReference] of [["source", "J1"], ["receiver", "J2"]] as const)
      pair.terminations[side] = { kind: "integrated", componentReference, positivePin: "1", negativePin: "2", source: pair.source };
    const compilationBundle = interfaceConstructionBundle(draft), f = await ercFixture("clean", { compilationBundle, pcbSource: interfaceBoard(compilationBundle), retainedPadLayers: true });
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("covered") });
    expect(result.evidence.interfaces![0]!.geometry!.terminationAnchors).toEqual([]);
    expect(row(result, "interface-topology:LINK").status).toBe("pass");
    expect(row(result, "interface-termination:LINK").status).toBe("pass");
    expect(row(result, "interface-geometry:LINK").status).toBe("pass");
    expect(result.evidence.interfaces![0]!.terminations.deviceInternalTermination).toBe("not_verified");
    expect(result.accepted).toBe(false);
  });

  it.each([{ terminationXmm: 7.9, expected: "unknown" }, { terminationXmm: 5, expected: "fail" }])(
    "separates external resistance assertions from observed termination facts at x=$terminationXmm", async ({ terminationXmm, expected }) => {
      const draft = interfaceConstructionDraft(), pair = draft.interfaceRequirements.interfaces[0];
      const resistor = { ...planeDividerDraft().components.find(component => component.reference === "R1")!, value: "100",
        pins: ["DP", "DN"].map((net, index) => ({ pin: String(index + 1), assignment: { kind: "net", net } })) };
      draft.components.push(resistor); draft.placementConstraints.push({ ...draft.placementConstraints[0], reference: "R1", edgePreference: "none" });
      for (const [index, name] of ["DP", "DN"].entries()) {
        const endpoint = { reference: "R1", pin: String(index + 1) };
        draft.nets.find((net: Raw) => net.name === name).endpoints.push(endpoint);
        const route = draft.routingConstraints.nets.find((route: Raw) => route.net === name); route.topology = "tree";
        route.referencePath.terminalReferences.push({ signalEndpoint: endpoint, referenceEndpoint: { reference: "J2", pin: "3" } });
      }
      pair.terminations.receiver = { kind: "parallel", componentReference: "R1", positivePin: "1", negativePin: "2",
        resistanceOhms: 100, maximumDistanceToEndpointMm: 0.5, source: pair.source };
      const compilationBundle = interfaceConstructionBundle(draft);
      const pcbSource = interfaceBoard(compilationBundle).replace("(at 13 3)", `(at ${terminationXmm} 3)`);
      const f = await ercFixture("clean", { compilationBundle, pcbSource, retainedPadLayers: true });
      const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("covered") });
      const saved = result.evidence.interfaces![0]!, projected = summarizePlaneAcceptance(result);
      expect(saved.terminations.resistanceVerification).toBe("caller_assertion_only");
      expect(saved.terminations.assertedResistanceOhms).toEqual([{ side: "receiver", value: 100 }]);
      expect(saved.terminations.pins).toHaveLength(2);
      expect(saved.terminations.pins.every(pin => pin.matchingPadUuids.length === 1 && pin.distanceSquaredNm2 !== null)).toBe(true);
      expect(row(result, "interface-termination:LINK").status).toBe(expected);
      expect(projected.interfaces![0]!.acceptance.termination.status).toBe(expected === "fail" ? "failed" : "unknown");
      expect(projected.interfaces![0]!.acceptance.termination.reasons.join(" ")).toContain("planar pad-center separation");
      if (expected === "unknown") {
        expect(saved.terminations.status).toBe("matched_source_facts");
        expect(saved.terminations.pins.map(pin => pin.distanceSquaredNm2)).toEqual(["10000000000", "10000000000"]);
        expect(row(result, "interface-topology:LINK").status).toBe("pass");
        expect(row(result, "interface-geometry:LINK").status).toBe("pass");
        expect(projected.interfaces![0]!.acceptance.termination.reasons.join(" ")).toContain("caller-asserted");
      } else expect(saved.terminations.pins.every(pin => pin.reasons.some(reason => reason.code === "TERMINATION_ENDPOINT_DISTANCE_EXCEEDED"))).toBe(true);
      expect(result.accepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
    });

  it.each([{ differentialOhm: 100, expected: "unknown" }, { differentialOhm: 150, expected: "fail" }])(
    "retains a $differentialOhm ohm numerical model result independently of missing fill and unresolved applicability", async ({ differentialOhm, expected }) => {
      const draft = interfaceConstructionDraft(), pair = draft.interfaceRequirements.interfaces[0];
      draft.interfaceRequirements.construction.surfaceFinish = "bare copper";
      pair.impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 10, frequencyHz: 100_000_000,
        constructionId: "STACK", source: pair.source };
      const compilationBundle = interfaceConstructionBundle(draft), f = await fixture({ compilationBundle, pcbSource: interfaceBoard(compilationBundle) });
      const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null, transmissionLine: await transmissionLineCalculator(differentialOhm) });
      expect(result.authority.status).toBe("unknown"); expect(result.interfaces![0]!.referenceCoverage.status).toBe("unknown");
      expect(result.evidence.interfaces![0]!.impedance.intervals[0]?.calculatedDifferentialOhm,
        JSON.stringify(result.evidence.interfaces![0]!.impedance.intervals[0]?.reasons)).toBe(differentialOhm);
      expect(row(result, "interface-impedance:LINK").status).toBe(expected);
      expect(result.evidence.interfaces![0]!.impedance.intervals).toHaveLength(1);
      expect(result.evidence.interfaces![0]!.impedance.intervals[0]!.calculatedDifferentialOhm).toBe(differentialOhm);
      expect(result.evidence.interfaces![0]!.impedance.intervals[0]!.calculation!.impedance.differentialAtFrequencyOhm).toBe(differentialOhm);
      expect(result.accepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
    });

  it.each([
    { statuses: ["covered", "boundary_uncertain"] as const, expected: "unknown" },
    { statuses: ["boundary_uncertain", "covered"] as const, expected: "unknown" },
    { statuses: ["covered", "uncovered"] as const, expected: "fail" },
    { statuses: ["uncovered", "covered"] as const, expected: "fail" },
  ])("requires both member reference results independently: $statuses", async ({ statuses, expected }) => {
    const compilationBundle = interfaceConstructionBundle(), f = await fixture({ compilationBundle, pcbSource: interfaceBoard(compilationBundle) });
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator(statuses) });
    expect(result.references.map(reference => reference.geometricStatus)).toEqual(statuses);
    expect(row(result, "interface-geometry:LINK").status).toBe(expected);
    expect(row(result, "interface-topology:LINK").status).toBe("pass");
    expect(summarizePlaneAcceptance(result).interfaces![0]!.acceptance.referenceCoverage.status).toBe(expected === "fail" ? "failed" : "unknown");
  });

  it.each([{ widthMm: 0.5, expectedGeometry: "unknown" }, { widthMm: 0.7, expectedGeometry: "fail" }])(
    "retains independent $widthMm mm width facts with unsupported selected pads and covered reference ribbons", async ({ widthMm, expectedGeometry }) => {
    const compilationBundle = interfaceConstructionBundle();
    // Native pad/source fixtures retain the same explicit non-cardinal pad
    // rotation on both footprints. The bounded saved-pair projection cannot
    // silently drop these selected physical members into a complete pair.
    const pcbSource = interfaceBoard(compilationBundle, widthMm).replaceAll("(at 0 0) (size 0.5 0.5)", "(at 0 0 45) (size 0.5 0.5)");
    const f = await fixture({ compilationBundle, pcbSource });
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered") });
    expect(result.references.every(reference => reference.status === "verified" && reference.geometricStatus === "covered")).toBe(true);
    expect(result.references).toHaveLength(2);
    expect(result.evidence.interfaces![0]!.sourceInventory.status).toBe("unsupported");
    expect(row(result, "interface-topology:LINK").status).toBe("unknown");
    expect(row(result, "interface-geometry:LINK").status).toBe(expectedGeometry);
  });

  it("retains complete saved interface evidence privately and rejects stale public bindings", async () => {
    const compilationBundle = interfaceConstructionBundle(), f = await fixture({ compilationBundle, pcbSource: interfaceBoard(compilationBundle) });
    const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    const outputRoot = await mkdtemp(path.join(tmpdir(), "evleda-interface-plane-acceptance-"));
    cleanups.push(() => rm(outputRoot, { recursive: true, force: true }));
    const captured = await captureToolboxPlaneAcceptance(outputRoot, result);
    const stored = JSON.parse(await readFile(path.join(outputRoot, captured.diagnostic.filename), "utf8"));
    expect(stored.evidence.interfaces).toEqual(result.evidence.interfaces);
    expect(captured.report.interfaces![0]!.assessmentIdentity).toEqual(result.evidence.interfaces![0]!.identity);
    expect(captured.report.rows.map(check => check.id)).toEqual(result.rows.map(check => check.id));
    for (const key of ["sourceIdentity", "bundleIdentity", "contractIdentity", "verificationPlanIdentity"] as const) {
      const detached: Raw = structuredClone(result), inner = detached.evidence.interfaces[0];
      inner[key] = key === "sourceIdentity" ? contentIdentity("stale source") : canonicalIdentity({ stale: key }, "evleda.stale-fixture.v1");
      const { identity: _old, ...payload } = inner;
      inner.identity = canonicalIdentity(payload, inner.schemaVersion); detached.interfaces[0].assessmentIdentity = inner.identity;
      expect(() => summarizePlaneAcceptance(detached as Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>)).toThrow(/source binding/);
    }
    const mismatched: Raw = structuredClone(result);
    mismatched.rows.find((check: Raw) => check.id === "interface-topology:LINK").status = "fail";
    expect(() => summarizePlaneAcceptance(mismatched as Awaited<ReturnType<typeof assessFreshPlaneAcceptance>>)).toThrow(/original V2 verification row/);
    expect(JSON.stringify(captured.report)).not.toMatch(/kicad_pcb|D:\\\\evleda|rawSnapshot|physical\.source/u);
  });

  it.each(["clean", "violation", "ignored", "missing"] as const)("merges %s ERC through its genuine source-bound native assessment while preserving DRC and common rows", async kind => {
    const f = await ercFixture(kind), result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks });
    expect(row(result, "erc").status).toBe(kind === "clean" ? "pass" : kind === "violation" ? "fail" : "unknown");
    expect(row(result, "drc").status).toBe("pass"); expect(row(result, "board:outline").status).toBe("pass");
    expect(result.evidence.nativeChecks).toBe(f.nativeChecks); expect(result.accepted).toBe(false);
    const report = summarizePlaneAcceptance(result);
    expect(report.nativeChecks!.checks.erc!.status).toBe(kind === "clean" ? "verified" : kind === "violation" ? "failed" : "unsupported");
    expect(report.nativeChecks!.ercSourceSetIdentity).toEqual(f.nativeChecks.ercSourceScope.sourceSetIdentity);
    expect(report.nativeChecks!.nativeErcIdentity).toEqual(f.nativeChecks.nativeErcIdentity);
    expect(JSON.stringify(report)).not.toContain("offline-checks");
  });
  it("retains native-only contacts and bore-aware ribbon facts without passing whole connectivity rows", async () => {
    const f = await fixture({ surfaceSignalPads: true }), requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.authority.status).toBe("verified"); expect(result.nativeInventory.status).toBe("verified");
    expect(row(result, "plane-config:GND_PLANE").status).toBe("pass"); expect(row(result, "plane-net:GND").status).toBe("unknown");
    expect(row(result, "reference:VIN").status).toBe("unknown");
    expect(result.planes[0]!.intendedPlaneConnectivity).toMatchObject({ status: "verified", scope: "native-pad-reachability-to-stored-zone-component" });
    expect(result.planes[0]!.drillTopology).toMatchObject({ status: "verified", physicalConnectivity: "not_assessed", terminalContactContinuity: "not_assessed",
      cachedAreaTwiceNm2: "1102000000000000", conservativeAreaLowerBoundTwiceNm2: "1101680000000000" });
    expect(result.references[0]).toMatchObject({ status: "verified", geometricStatus: "covered", intersectingBoreUuids: [] });
    expect(result.planes[0]!.componentCount).toBe(1); expect(result.planes[0]!.minimumArea.status).toBe("verified");
    expect(requests[0]!.routes).toEqual([{ x1Nm: 3_000_000, y1Nm: 3_000_000, x2Nm: 8_000_000, y2Nm: 3_000_000, widthNm: 500_000, marginNm: 500_000 }]);
    expect(row(result, "plane-fill:GND_PLANE").status).toBe("unknown"); expect(row(result, "plane-policy:GND_PLANE").status).toBe("unknown");
    expect(result.accepted).toBe(false); expect(result.status).toBe("incomplete"); expect(result.mandatoryRowsRemaining).toContain("visual");
    expect(result.rows).toHaveLength(f.input.compilationBundle.verificationPlan.requirements.length);
    const common = result.evidence.commonChecks;
    expect(isFreshPlaneCommonChecksAssessment(common)).toBe(true);
    expect(common!.endpointConnectivityIdentity).toEqual(f.input.endpointConnectivity.identity);
    for (const check of common!.rows) expect(row(result, check.id)).toMatchObject({ kind: check.kind, status: check.status, reasons: check.reasons });
    expect(row(result, "board:outline").status).toBe("pass");
    expect(row(result, "vias:GND").status).toBe("pass"); expect(row(result, "trace-geometry:VIN").status).toBe("pass");
    expect(result.verificationPlanRowsPassed).toEqual(result.rows.filter(row => row.status === "pass").map(row => row.id));
    expect(result.mandatoryRowsRemaining).toEqual(result.rows.filter(row => row.status !== "pass").map(row => row.id));
    const publicReport = summarizePlaneAcceptance(result);
    expect(publicReport.commonChecks!.assessmentIdentity).toEqual(common!.identity);
    expect(publicReport.rows.find(row => row.id === "vias:GND")!.observations).toMatchObject({ viaCount: 0, globalViaCount: 0 });
    expect(publicReport.rows.find(row => row.id === "trace-geometry:VIN")!.observations).toMatchObject({ trackUuids: [U(1)], fullRouteInventorySupplied: true });
    expect(publicReport).not.toHaveProperty("evidence"); expect(publicReport.commonChecks).not.toHaveProperty("profile");
    expect(result.evidence.savedFill).toBe(f.input.savedEvidence); expect(isKicadPlaneContactsObservation(result.evidence.nativeContacts)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("compares a through-via against every enabled copper layer and rejects missing or extra membership", async () => {
    const compilationBundle = fourLayerPlaneBundle();
    const source = interfaceBoard(compilationBundle).trimEnd();
    const pcbSource = source.slice(0, -1) + `(via (at 13 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${U(3)}")))\n`;
    const f = await fixture({ compilationBundle, pcbSource });
    const valid = await assessFreshPlaneAcceptance(f.input);
    expect(valid.nativeInventory.status).toBe("verified");
    expect(valid.planes).toHaveLength(2);
    const via = f.report.allTracks.find((track: Raw) => track.nativeClass === "PCB_VIA");
    const enabled = structuredClone(via.layers);
    via.layers = enabled.filter((layer: Raw) => layer.name !== "In1.Cu");
    expect((await assessFreshPlaneAcceptance(f.input)).nativeInventory.status).toBe("failed");
    via.layers = [...enabled, { id: 8, name: "In3.Cu" }];
    expect((await assessFreshPlaneAcceptance(f.input)).nativeInventory.status).toBe("failed");
  });
  it("binds supplemental-region witnesses to current fill, matching native via contacts and the primary endpoint anchor", async () => {
    const compilationBundle = fourLayerPlaneBundle(), source = interfaceBoard(compilationBundle).trimEnd();
    const pcbSource = source.slice(0, -1) + `(via (at 13 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${U(3)}")))\n`;
    const f = await ercFixture("clean", { compilationBundle, pcbSource }), via = f.report.allTracks.find((v: Raw) => v.nativeClass === "PCB_VIA");
    const contact = { uuid: via.uuid, nativeType: via.nativeType, nativeClass: via.nativeClass, netCode: via.netCode, netName: via.netName, proxyType: "PCB_TRACK" };
    for (const zone of f.report.zones) zone.directVias = [contact];
    const input = { ...f.input, nativeChecks: f.nativeChecks }, result = await assessFreshPlaneAcceptance(input);
    expect(result.planeRegionBridges).toHaveLength(1);
    expect(result.planeRegionBridges[0]).toMatchObject({ status: "verified", planeId: "BACK_GND", referencePlaneId: "GND_PLANE",
      calculation: { allRegionsWitnessed: true, globalDrillClippedContinuityClaimed: false, currentCapacityClaimed: false } });
    expect(result.accepted).toBe(false);
    const reopened = await assessFreshPlaneAcceptance({ ...input, savedEvidence: null });
    expect(reopened.planeRegionBridges[0]).toMatchObject({ status: "unknown", calculation: null });
    f.report.zones[0].directVias = [];
    const noCommonContact = await assessFreshPlaneAcceptance(input);
    expect(noCommonContact.planeRegionBridges[0]).toMatchObject({ status: "unknown", calculation: { allRegionsWitnessed: false } });
    f.report.zones[0].directVias = [contact]; f.report.zones[1].layers[0].subpolygons[0].isIsland = true;
    const island = await assessFreshPlaneAcceptance(input);
    expect(island.planeRegionBridges[0]!.status).toBe("unknown");
    expect(island.planes.some(p => p.islandPolicy.status === "failed")).toBe(true);
  });
  it("assesses explicit regional intent without treating it as complete drilled-copper acceptance", async () => {
    async function regional(single: boolean, minimumAreaMm2 = 1) {
      const draft = fourLayerPlaneDraft(), policy = draft.planes.find((p: Raw)=>p.id==="BACK_GND").islandPolicy;
      policy.minimumAreaMm2 = minimumAreaMm2;
      if (!single) Object.assign(policy, { requireSingleConnectedComponent: false, referencePlaneId: "GND_PLANE", engineeringBasis: "Synthetic explicit supplemental-region intent." });
      const compilationBundle = interfaceConstructionBundle(draft), source = interfaceBoard(compilationBundle).trimEnd();
      const pcbSource = source.slice(0,-1) + [13,17].map((x,i)=>`(via (at ${x} 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${U(3+i)}"))`).join("\n") + ")\n";
      const f = await ercFixture("clean", { compilationBundle, pcbSource, splitSupplemental: true });
      const vias = f.report.allTracks.filter((v: Raw)=>v.nativeClass==="PCB_VIA").map((v: Raw)=>({ uuid:v.uuid,nativeType:v.nativeType,nativeClass:v.nativeClass,netCode:v.netCode,netName:v.netName,proxyType:"PCB_TRACK" }));
      for (const zone of f.report.zones) zone.directVias = vias;
      return { ...f, complete: { ...f.input, nativeChecks: f.nativeChecks }, vias };
    }
    const strict = await regional(true);
    expect(row(await assessFreshPlaneAcceptance(strict.complete), "plane-policy:BACK_GND").status).toBe("fail");
    const f = await regional(false), result = await assessFreshPlaneAcceptance(f.complete), target = result.planes.find(p=>p.planeId==="BACK_GND")!;
    expect(target.componentCount).toBe(2); expect(target.nativePolygonAttribution.status).toBe("verified");
    expect(target.regionalPolicyConditions?.status).toBe("verified"); expect(target.minimumArea.status).toBe("verified");
    expect(result.planeRegionBridges[0]!.geometricRegionConnectivity.status).toBe("verified");
    expect(result.planeRegionBridges[0]!.calculation!.boreClearAnnuli.allRegionsWitnessed).toBe(true);
    expect(target.islandPolicy.status).toBe("verified");
    expect(target.minimumArea.componentAreaLowerBounds).toHaveLength(2);
    expect(target.intendedPlaneConnectivity.scope).toBe("native-region-via-contacts-to-primary-plane");
    expect(row(result,"plane-policy:BACK_GND").status).toBe("unknown"); expect(result.accepted).toBe(false);
    const publicReport = summarizePlaneAcceptance(result);
    expect(publicReport.planes.find(p=>p.planeId==="BACK_GND")!.minimumArea.componentAreaLowerBounds).toHaveLength(2);
    const secondary = f.report.zones.find((z:Raw)=>z.layers[0].name==="In2.Cu"); secondary.directVias = f.vias.slice(0,1);
    const missingBridge = await assessFreshPlaneAcceptance(f.complete);
    expect(missingBridge.planes.find(p=>p.planeId==="BACK_GND")!.regionalPolicyConditions?.status).toBe("unknown");
    expect(missingBridge.planeRegionBridges[0]!.geometricRegionConnectivity.status).toBe("unknown");
    expect(missingBridge.planes.find(p=>p.planeId==="BACK_GND")!.islandPolicy.status).toBe("unknown");
    const tooSmall = await regional(false,270);
    expect(row(await assessFreshPlaneAcceptance(tooSmall.complete),"plane-policy:BACK_GND").status).toBe("fail");
  });

  it("requires current-session fill authority after resume and rejects copied branded evidence", async () => {
    const f = await fixture(); const result = await assessFreshPlaneAcceptance({ ...f.input, savedEvidence: null });
    expect(result.verificationPlanRowsPassed).toEqual([]); expect(result.authority.reasons.join(" ")).toMatch(/reapply/i);
    expect(result.evidence.commonChecks).toBeNull(); expect(result.rows.every(row => row.status === "unknown")).toBe(true);
    expect(summarizePlaneAcceptance(result).commonChecks).toBeNull();
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
    const f = await fixture({ surfaceSignalPads: true }); let called = false;
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

  it("keeps a connected native PAD anchor below whole-plane acceptance and still fails native disconnection", async () => {
    const f = await fixture({ viaNet: "GND" }); f.report.zones[0].directPads = f.report.zones[0].directPads.slice(0, 1);
    const result = await assessFreshPlaneAcceptance(f.input); expect(row(result, "plane-net:GND").status).toBe("unknown");
    expect(result.planes[0]!.intendedPlaneConnectivity).toMatchObject({ status: "verified", scope: "native-pad-reachability-to-stored-zone-component" });
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
    const f = await fixture({ surfaceSignalPads: true }); const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator(status) });
    expect(row(result, "reference:VIN").status).toBe(status === "uncovered" ? "fail" : "unknown");
  });

  it.each(["uncovered", "covered", "boundary_uncertain"] as const)("retains %s stored-fill geometry when global drill topology is unknown", async status => {
    const f = await fixture({ surfaceSignalPads: true, probeBoreNm: [500_000, 3_000_000] });
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator(status, requests) });
    expect(result.planes[0]!.nativePolygonAttribution.status).toBe("verified");
    expect(result.planes[0]!.drillTopology.status).toBe("unknown");
    expect(result.references[0]!.intersectingBoreUuids).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(result.references[0]!.geometricStatus).toBe(status);
    const expected = status === "uncovered" ? "fail" : "unknown";
    expect(row(result, "reference:VIN").status).toBe(expected);
    expect(summarizePlaneAcceptance(result).rows.find(r => r.id === "reference:VIN")!.status).toBe(expected);
    expect(result.accepted).toBe(false);
  });

  it("does not let an unproved plane endpoint anchor hide an exact missing-copper witness", async () => {
    const f = await fixture({ surfaceSignalPads: true }); f.report.zones[0].directPads = [];
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("uncovered", requests) });
    expect(result.planes[0]!.intendedPlaneConnectivity.status).toBe("unknown");
    expect(requests).toHaveLength(1);
    expect(row(result, "reference:VIN").status).toBe("fail");
    expect(result.accepted).toBe(false);
  });

  it("still withholds geometric evaluation for source/native polygon disagreement", async () => {
    const f = await fixture({ surfaceSignalPads: true });
    f.report.zones[0].layers[0].subpolygons[0].outline[0][0] += 1;
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("uncovered", requests) });
    expect(result.planes[0]!.nativePolygonAttribution.status).toBe("failed");
    expect(requests).toHaveLength(0);
    expect(result.references[0]!.geometricStatus).toBe("not_assessed");
    expect(result.accepted).toBe(false);
  });

  it("retains legitimate plane-access vias but rejects forbidden referenced-signal vias", async () => {
    const f = await fixture({ viaNet: "VIN" }), requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.sourceScope.status).toBe("verified"); expect(row(result, "reference:VIN").status).toBe("fail"); expect(requests).toHaveLength(0);
  });

  it("rejects footprint copper graphics structurally rather than ignoring them in reference projection", async () => {
    await expect(fixture({ copperGraphic: true })).rejects.toThrow("Copper fp_line graphics");
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

  it("does not mistake a conservative drill-area lower bound below the threshold for a proven physical area failure", async () => {
    const f = await fixture({ minimumAreaMm2: 550 }); const result = await assessFreshPlaneAcceptance(f.input);
    expect(result.planes[0]!.drillTopology.status).toBe("verified");
    expect(result.planes[0]!.minimumArea).toMatchObject({ status: "unknown", requiredAreaTwiceNm2: "1100000000000000",
      observedAreaTwiceNm2: ["1102000000000000"], conservativeAreaLowerBoundTwiceNm2: "1099760000000000" });
    expect(row(result, "plane-policy:GND_PLANE").status).toBe("unknown");
  });

  it("rejects reference ribbons through plated endpoint bores even when the stored polygon helper would report covered", async () => {
    const f = await fixture(), requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.planes[0]!.geometry).toMatchObject({ status: "verified", geometryEquivalent: true });
    expect(result.planes[0]!.drillTopology).toMatchObject({ status: "verified", inventory: { boreCount: 7, complete: true } });
    expect(result.references[0]).toMatchObject({ status: "failed", geometricStatus: "uncovered", intersectingBoreUuids: [U(100), U(110)], calculation: null });
    expect(row(result, "reference:VIN").status).toBe("fail"); expect(requests).toHaveLength(0);
  });

  it.each([0, 90])("uses the complete %i-degree slot for reference-gap evidence", async angle => {
    const original = board({ surfaceSignalPads: true });
    const ground = parseFreshPcbSource(original).footprints.find(fp => fp.reference === "J1")!.pads.find(pad => pad.number === "3")!.physical.source;
    const changed = ground.replace("thru_hole circle", "thru_hole oval").replace("(at 0 4)", `(at 0 4 ${angle})`)
      .replace("(size 1 1)", "(size 0.8 9.4)").replace("(drill 0.4)", "(drill oval 0.4 9)");
    expect(changed).not.toBe(ground);
    const f = await fixture({ surfaceSignalPads: true, pcbSource: original.replace(ground, changed) });
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.planes[0]!.drillTopology.inventory.complete).toBe(true);
    expect(result.references[0]!.intersectingBoreUuids).toEqual(angle === 0 ? [U(102)] : []);
    expect(result.references[0]!.geometricStatus).toBe(angle === 0 ? "uncovered" : "covered");
    expect(row(result, "reference:VIN").status).toBe(angle === 0 ? "fail" : "unknown");
    expect(requests).toHaveLength(angle === 0 ? 0 : 1);
    expect(result.accepted).toBe(false);
  });

  it("requires explicit launch intent and complete local conditions while preserving full-reference uncertainty", async () => {
    const options = { surfaceSignalPads: true, launchHeader: true };
    const original = await ercFixture("clean", options);
    expect(row(await assessFreshPlaneAcceptance({ ...original.input, nativeChecks: original.nativeChecks,
      referenceCoverage: await calculator("covered") }), "reference:VIN").status).toBe("fail");
    const draft: Raw = planeDividerDraft();
    draft.routingConstraints.nets.find((r: Raw) => r.net === "VIN").referencePath.terminalLaunches = [{
      signalEndpoint: { reference: "J1", pin: "1" }, referenceEndpoint: { reference: "J1", pin: "3" }, maximumLengthMm: 1.5,
      maximumReturnSpacingMm: 4, engineeringBasis: "Synthetic explicit terminal approach with local direct ground anchor." }];
    const compilationBundle = interfaceConstructionBundle(draft), f = await ercFixture("clean", { ...options, compilationBundle });
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("covered", requests) });
    expect(row(result, "reference-launch:VIN:J1:1").status).toBe("pass");
    expect(row(result, "reference:VIN").status).toBe("unknown");
    expect(requests[0]!.routes[0]).toMatchObject({ x1Nm: 4_500_000, y1Nm: 3_000_000, x2Nm: 8_000_000, marginNm: 500_000 });
    expect(result.references[0]!.terminalLaunches![0]!.geometry?.referencePadUuid).toBe(U(102));
    expect(summarizePlaneAcceptance(result).references[0]!.terminalLaunches![0]!.geometry?.cutNm).toEqual({ x: 4_500_000, y: 3_000_000 });
    expect(result.accepted).toBe(false);
    const noDrc = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered") });
    expect(row(noDrc, "reference-launch:VIN:J1:1").status).toBe("unknown");
    f.report.zones[0].directPads = [];
    expect(row(await assessFreshPlaneAcceptance({ ...f.input, nativeChecks: f.nativeChecks, referenceCoverage: await calculator("covered") }), "reference-launch:VIN:J1:1").status).toBe("unknown");
    const foreign = await ercFixture("clean", { ...options, compilationBundle, probeBoreNm: [3_500_000, 3_000_000] });
    const blocked = await assessFreshPlaneAcceptance({ ...foreign.input, nativeChecks: foreign.nativeChecks, referenceCoverage: await calculator("covered") });
    expect(row(blocked, "reference-launch:VIN:J1:1").status).toBe("fail");
    expect(blocked.references[0]!.terminalLaunches![0]!.foreignBoreUuids).toContain(U(3));
    expect(row(blocked, "reference:VIN").status).toBe("fail");
    draft.routingConstraints.nets.find((r: Raw) => r.net === "VIN").referencePath.terminalLaunches[0].maximumReturnSpacingMm = 3.9;
    const distant = await ercFixture("clean", { ...options, compilationBundle: interfaceConstructionBundle(draft) });
    expect(row(await assessFreshPlaneAcceptance({ ...distant.input, nativeChecks: distant.nativeChecks }), "reference-launch:VIN:J1:1").status).toBe("fail");
  });

  it("retains a definite bore-ribbon failure when another bore makes global plane topology unknown", async () => {
    // The extra bore straddles the cached outer boundary, away from VIN. That
    // prevents a global topology certificate but cannot hide VIN's own holes.
    const f = await fixture({ probeBoreNm: [500_000, 3_000_000] });
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    expect(result.planes[0]!.drillTopology).toMatchObject({ status: "unknown", inventory: { boreCount: 8, complete: true } });
    expect(result.planes[0]!.drillTopology.bores).toHaveLength(8);
    expect(result.planes[0]!.minimumArea.status).toBe("unknown");
    expect(result.references[0]).toMatchObject({ status: "failed", geometricStatus: "uncovered", intersectingBoreUuids: [U(100), U(110)], calculation: null });
    expect(row(result, "reference:VIN").status).toBe("fail"); expect(requests).toHaveLength(0);
    expect(result.accepted).toBe(false);
  });

  it.each([
    ["missing outline", { outline: "" }, "board:outline"],
    ["one nm narrow saved trace", { routeWidthNm: 499_999 }, "trace-geometry:VIN"],
    ["half-nm small via annular ring", { viaNet: "GND", viaDrillNm: 300_001 }, "vias:GND"],
  ] as const)("merges the genuine common-source failure for %s into its original V2 row", async (_name, options, id) => {
    const f = await fixture({ surfaceSignalPads: true, ...options }), result = await assessFreshPlaneAcceptance(f.input);
    expect(isFreshPlaneCommonChecksAssessment(result.evidence.commonChecks)).toBe(true);
    expect(row(result, id).status).toBe("fail"); expect(result.status).toBe("failed"); expect(result.accepted).toBe(false);
    expect(summarizePlaneAcceptance(result).rows.find(row => row.id === id)!.status).toBe("fail");
    expect(result.rows.map(row => row.id)).toEqual(f.input.compilationBundle.verificationPlan.requirements.map(row => row.id));
  });

  it.each(boreCases)("checks exact source/native bore against the reference capsule: $name", async testCase => {
    const f = await fixture({ surfaceSignalPads: true, routeNm: testCase.route, probeBoreNm: testCase.center });
    const requests: ReferenceCoverageRequest[] = [];
    const result = await assessFreshPlaneAcceptance({ ...f.input, referenceCoverage: await calculator("covered", requests) });
    const topology = result.planes[0]!.drillTopology, reference = result.references[0]!;
    expect(topology.status, topology.issues.join(" ")).toBe("verified");
    expect(topology.bores.find(bore => bore.uuid === U(3))).toMatchObject({ kind: "via", centerNm: { x: testCase.center[0], y: testCase.center[1] },
      diameterNm: 400_000, classification: "new_interior_void", geometrySource: "exact-saved-through-via" });
    expect(reference.intersectingBoreUuids).toEqual(testCase.intersects ? [U(3)] : []);
    expect(reference.tangentBoreUuids).toEqual(testCase.tangent?[U(3)]:[]);
    expect(row(result, "reference:VIN").status).toBe(testCase.intersects ? "fail" : "unknown");
    expect(reference.geometricStatus).toBe(testCase.intersects ? "uncovered" :testCase.tangent?"boundary_uncertain": "covered");
    expect(requests).toHaveLength(testCase.intersects||testCase.tangent ? 0 : 1);
    if (!testCase.intersects&&!testCase.tangent) {
      expect(requests[0]!.routes).toEqual([{ x1Nm: testCase.route.start[0], y1Nm: testCase.route.start[1], x2Nm: testCase.route.end[0],
        y2Nm: testCase.route.end[1], widthNm: 500_000, marginNm: 500_000 }]);
      expect(row(result, "reference:VIN").reasons.join(" ")).toMatch(/drill-aware.*continuity/);
    }
    expect(row(result, "plane-net:GND").status).toBe("unknown"); expect(result.accepted).toBe(false);
  });
});
