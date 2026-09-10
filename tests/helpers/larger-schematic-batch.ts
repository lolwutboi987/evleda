import type { CallToolResult } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbDesignIntentDraft, type PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef } from "../../src/harness/pcb-design-compilation-bundle.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, selectFreshSymbolTerminalGeometryPins, parseFreshSchematicSource, parseFreshSchematicConnectivityPrimitiveInventory } from "../../src/harness/fresh-kicad-parser.js";
import { buildFreshSchematicSourceTerminalGroups } from "../../src/harness/fresh-schematic-source-adapter.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE, type FreshSchematicStrokeStyleCapture } from "../../src/harness/fresh-schematic-stroke-style.js";
import type { KicadSchematicSvgResult } from "../../src/integrations/kicad-cli.js";
import type { FreshSchematicBatchRequest } from "../../src/harness/fresh-schematic-connectivity-batch.js";
import { normalizeFakeSchematicWriterSource, replaceFakeSchematicGeometry } from "./normalizing-schematic-writer.js";

// These are protocol/state-transition fixtures, NOT functional circuit designs
// or native ERC/SVG results. Source definitions themselves are exact stock data.
const mcu = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/rp2350-stock-terminal-source.json", import.meta.url), "utf8")) as { sourceBase64: string; definitions: { libraryId: string; source: string }[] };
const resistor = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/stock-resistor-source.json", import.meta.url), "utf8")) as { definitionSource: string };
const uuid = (number: number) => `00000000-0000-0000-0000-${number.toString(16).padStart(12, "0")}`;
const add = (source: string, forms: string): string => { const close = source.lastIndexOf(")"); return `${source.slice(0, close)}\n${forms}\n${source.slice(close)}`; };

export type LargerSchematicFault = "none" | "missing-batch" | "graph-member" | "native-member" | "receipt-uuid" | "after-source" | "no-style";
export async function largerSchematicBatchFixture(kind: "rp2350b" | "resistor-bank", fault: LargerSchematicFault = "none", workLimit?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-larger-schematic-"));
  const libraryId = kind === "rp2350b" ? "MCU_RaspberryPi:RP2350B" : "Device:R";
  const leaf = libraryId.split(":")[1]!;
  const definition = kind === "rp2350b" ? mcu.definitions.find((entry) => entry.libraryId === libraryId)!.source : resistor.definitionSource;
  const librarySource = kind === "rp2350b" ? Buffer.from(mcu.sourceBase64, "base64").toString("utf8") : `(kicad_symbol_lib ${definition})`;
  const geometry = parseFreshSymbolLibraryTerminalGeometrySource(librarySource, contentIdentity(librarySource), libraryId);
  const pins = selectFreshSymbolTerminalGeometryPins(geometry, 1, 1);
  const references = kind === "rp2350b" ? ["U1"] : Array.from({ length: 16 }, (_, index) => `R${index + 1}`);
  const footprint = kind === "rp2350b" ? "Package_DFN_QFN:QFN-80-1EP_10x10mm_P0.4mm_EP3.4x3.4mm" : "Resistor_SMD:R_0603_1608Metric";
  const netFor = (pin: typeof pins[number]): string | null => kind === "rp2350b" ? pin.name === "IOVDD" ? "N_IO" : pin.name === "DVDD" ? "N_CORE" : null : pin.number === "1" ? "N_TOP" : "N_BOTTOM";
  const components = references.map((reference) => ({ reference, symbolLibId: libraryId, value: leaf, footprintLibId: footprint, unit: 1,
    pins: pins.map((pin) => ({ pin: pin.number, assignment: netFor(pin) === null ? { kind: "no_connect" } : { kind: "net", net: netFor(pin)! } })) }));
  const names = [...new Set(pins.map(netFor).filter((value): value is string => value !== null))].sort();
  const nets = names.map((name) => ({ name, role: "passive", endpoints: references.flatMap((reference) => pins.filter((pin) => netFor(pin) === name).map((pin) => ({ reference, pin: pin.number }))), netClassId: "SIGNAL",
    electrical: { voltage: { minimumV: 0, nominalV: 0, maximumV: 0 }, current: { nominalA: 0, maximumContinuousA: 0, peakA: 0, peakDurationMs: 1000 }, speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null } } }));
  const resolver: PcbReadOnlyLibraryResolver & { inspectSymbolTerminalGeometry: (id: string) => typeof geometry | null } = {
    resolveSymbol: (id) => id !== libraryId ? null : { libraryId: id, source: "kicad-stock", unitCount: 1, componentKind: "generic", polarized: false, pins: pins.map((pin) => ({ number: pin.number, function: pin.name === "" || pin.name === "~" ? null : pin.name })) },
    resolveFootprint: (id) => id !== footprint ? null : { libraryId: id, source: "kicad-stock", packageKind: "generic", pads: pins.map((pin) => pin.number) },
    inspectSymbolTerminalGeometry: (id) => id === libraryId ? geometry : null,
  };
  const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const draft = { schemaVersion: "evleda.pcb-design-intent-draft.v1", kind: "pcb_design_intent_draft",
    scope: { sheetCount: 1, componentUnitPolicy: "single_unit", board: { shape: "rectangle", widthMm: 200, heightMm: 200, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } }, components, nets,
    netClasses: [{ id: "SIGNAL", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] }],
    placementConstraints: references.map((reference) => ({ reference, side: "front", regionMm: { minXmm: 1, maxXmm: 199, minYmm: 1, maxYmm: 199 }, allowedRotationsDeg: [0], minimumEdgeClearanceMm: 1, minimumCourtyardClearanceMm: 0.25, edgePreference: "none" })),
    routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.2, allowRightAngleCorners: false, allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false,
      viaPolicy: { mode: "forbidden", maxTotal: 0 }, nets: names.map((net) => ({ net, topology: "tree", preferredLayer: "F.Cu", maxVias: 0, routeLength: { mode: "unbounded" } })) }, unresolved: [] };
  const compilation = compilePcbDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const bundle = createPcbDesignCompilationBundle({ originalPrompt: "FAKE-MCP SCHEMATIC STATE-MACHINE TEST ONLY, not a functioning PCB design.", compilation }, dependencies);
  const fresh = await prepareFreshProject({ outputDir: root, name: "larger", resume: false, workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: createPcbDesignCompilationBundleRef(bundle) });
  const centers = new Map(references.map((reference, index) => [reference, kind === "rp2350b" ? { x: 101.6, y: 101.6 } : { x: 30.48 + index * 15.24, y: 76.2 }]));
  const embedded = definition.replace(`(symbol "${leaf}"`, `(symbol "${libraryId}"`);
  const source = `(kicad_sch (version 20250114) (generator "test_fixture") (uuid "${uuid(1)}") (paper "A4") (lib_symbols ${embedded})
    ${references.map((reference, index) => { const at = centers.get(reference)!; return `(symbol (lib_id "${libraryId}") (at ${at.x} ${at.y} 0) (unit 1) (uuid "${uuid(10 + index)}") (property "Reference" "${reference}") (property "Value" "${leaf}") (property "Footprint" "${footprint}"))`; }).join("\n")}
    (sheet_instances (path "/" (page "1"))))`;
  await writeFile(fresh.schematicPath, source);
  const livePins = references.flatMap((reference) => pins.map((pin) => { const center = centers.get(reference)!; return { reference, pin: pin.number, at: { xMm: Number((center.x + pin.at.xMm).toFixed(4)), yMm: Number((center.y - pin.at.yMm).toFixed(4)) }, angleDeg: pin.angleDeg }; }));
  const contract = createFreshConnectivityContract(bundle.contract);
  const expectedGroups = buildFreshSchematicSourceTerminalGroups({ schematicSource: source, expectedSourceIdentity: contentIdentity(source), contract: bundle.contract, libraryResolver: resolver, livePins }).result;
  if (expectedGroups.status !== "complete") throw new Error(JSON.stringify(expectedGroups));
  const pristine = expectedGroups.value.groups.map((group, index) => `Group ${index + 1}: ~unnamed | pins=${group.memberEndpointIds.join(", ")}`).join("\n");
  const exactGraph = () => [...contract.nets.map((net, index) => `Group ${index + 1}: ${net.name} | pins=${net.endpoints.filter((_, member) => fault !== "graph-member" || index !== 0 || member !== 0).map((endpoint) => `${endpoint.reference}:${endpoint.pin}`).join(", ")}`),
    ...contract.noConnects.map((endpoint, index) => `Group ${contract.nets.length + index + 1}: ~no-connect | pins=${endpoint.reference}:${endpoint.pin}`)].join("\n");
  const native = () => `(export (components ${contract.components.map((component) => `(comp (ref "${component.reference}") (value "${component.value}") (footprint "${component.footprintLibId}") (libsource (lib "${libraryId.split(":")[0]}") (part "${leaf}")))`).join(" ")}) (nets
    ${contract.nets.map((net, index) => `(net (code "${index + 1}") (name "${net.name}") ${net.endpoints.filter((_, member) => fault !== "native-member" || index !== 0 || member !== 0).map((endpoint) => `(node (ref "${endpoint.reference}") (pin "${endpoint.pin}") (pintype "passive"))`).join(" ")})`).join(" ")}
    ${contract.noConnects.map((endpoint, index) => `(net (code "${contract.nets.length + index + 1}") (name "unconnected-(${endpoint.reference}-${endpoint.pin})") (node (ref "${endpoint.reference}") (pin "${endpoint.pin}") (pintype "no_connect")))`).join(" ")}))`;
  let applied = false;
  const calls: string[] = [];
  let batchCalls = 0;
  let nextUuid = 1000;
  const session: KicadHarnessSession = {
    assertActivePcb: async () => undefined,
    readActivePcbSource: async () => await readFile(fresh.pcbPath, "utf8"),
    listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map((name) => ({ name, permission: "write", inputSchema: { type: "object" } })),
    supportsSchematicConnectivityBatch: () => fault !== "missing-batch",
    applySchematicConnectivityBatch: async (args): Promise<CallToolResult> => {
      batchCalls += 1; calls.push("private-batch");
      const request = args as FreshSchematicBatchRequest;
      const beforeSource = await readFile(fresh.schematicPath, "utf8");
      let after = add(beforeSource, [
        ...request.wires.map((wire) => `(wire (pts (xy ${wire.x1_mm} ${wire.y1_mm}) (xy ${wire.x2_mm} ${wire.y2_mm})))`),
        ...request.global_labels.map((label) => `(global_label "${label.name}" (shape passive) (at ${label.x_mm} ${label.y_mm} ${label.rotation}) (effects (font (size 1.524 1.524)) (justify ${label.justify})) (uuid "${uuid(nextUuid++)}"))`),
        ...request.no_connects.map((point) => `(no_connect (at ${point.x_mm} ${point.y_mm}) (uuid "${uuid(nextUuid++)}"))`),
        ...request.junctions.map((point) => `(junction (at ${point.x_mm} ${point.y_mm}) (diameter 0))`),
      ].join("\n"));
      after = normalizeFakeSchematicWriterSource(after); // independent pairwise test writer, once over the whole plan
      const normalized = parseFreshSchematicSource(after);
      after = add(replaceFakeSchematicGeometry(after, { wires: [], junctions: [] }), [
        ...normalized.wires.map((wire) => `(wire (pts (xy ${wire.start.x} ${wire.start.y}) (xy ${wire.end.x} ${wire.end.y})) (stroke (width 0) (type default)) (uuid "${uuid(nextUuid++)}"))`),
        ...normalized.junctions.map((point) => `(junction (at ${point.x} ${point.y}) (diameter 0) (uuid "${uuid(nextUuid++)}"))`),
      ].join("\n"));
      await writeFile(fresh.schematicPath, after);
      const actual = parseFreshSchematicConnectivityPrimitiveInventory(after);
      const inventory = {
        wires: actual.wires.map((wire) => ({ x1_mm: wire.start.x, y1_mm: wire.start.y, x2_mm: wire.end.x, y2_mm: wire.end.y, uuid: wire.uuid })),
        global_labels: actual.globalLabels.map((label) => ({ name: label.name, x_mm: label.at.x, y_mm: label.at.y, rotation: label.rotationDeg, shape: label.shape, justify: label.justify?.join(" ") ?? "none", uuid: label.uuid })),
        no_connects: actual.noConnects.map((point) => ({ x_mm: point.at.x, y_mm: point.at.y, uuid: point.uuid })), junctions: actual.junctions.map((point) => ({ x_mm: point.at.x, y_mm: point.at.y, uuid: point.uuid })),
      };
      const kinds = ["wires", "global_labels", "no_connects", "junctions"] as const;
      const operationReceipt = kinds.flatMap((kind) => request[kind].map((submitted, index) => {
        const resultingPrimitiveIndices = inventory[kind].flatMap((written, resultIndex) => {
          const a = submitted as Record<string, any>, b = written as Record<string, any>;
          const matches = kind === "wires" ? (a.x1_mm === a.x2_mm && b.x1_mm === b.x2_mm && a.x1_mm === b.x1_mm && Math.min(a.y1_mm, a.y2_mm) >= Math.min(b.y1_mm, b.y2_mm) && Math.max(a.y1_mm, a.y2_mm) <= Math.max(b.y1_mm, b.y2_mm))
            || (a.y1_mm === a.y2_mm && b.y1_mm === b.y2_mm && a.y1_mm === b.y1_mm && Math.min(a.x1_mm, a.x2_mm) >= Math.min(b.x1_mm, b.x2_mm) && Math.max(a.x1_mm, a.x2_mm) <= Math.max(b.x1_mm, b.x2_mm))
            : a.x_mm === b.x_mm && a.y_mm === b.y_mm && (kind !== "global_labels" || a.name === b.name);
          return matches ? [resultIndex] : [];
        });
        return { kind, index, status: "applied", resultingPrimitiveIndices };
      }));
      const receipt = { schemaVersion: "evleda.kicad-schematic-connectivity-batch.v1", normalizationVersion: request.normalization_version, applied: true,
        projectFile: request.project_file, schematicFile: request.schematic_file, before: contentIdentity(beforeSource), after: contentIdentity(after),
        submittedCounts: Object.fromEntries(kinds.map((kind) => [kind, request[kind].length])), appliedCounts: Object.fromEntries(kinds.map((kind) => [kind, inventory[kind].length])), inventory, operationReceipt, reload: { status: "not_requested", confirmed: false } };
      if (fault === "receipt-uuid") receipt.inventory.wires[0]!.uuid = uuid(999999);
      if (fault === "after-source") await writeFile(fresh.schematicPath, after.replace("test_fixture", "changed_generator"));
      applied = true;
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt, isError: false };
    },
    callTool: async (name, args = {}) => {
      calls.push(name);
      if (["sch_add_wire", "sch_add_labels", "sch_add_no_connect", "sch_add_missing_junctions"].includes(name)) throw new Error("Larger fixture must never enter the legacy serial writer.");
      if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
      let result = "ok";
      if (name === "sch_get_symbols") result = references.map((reference) => { const center = centers.get(reference)!; return `- ${reference} ${leaf} ${libraryId} @ (${center.x}, ${center.y}) rot=0 unit=1 footprint=${footprint}`; }).join("\n");
      if (name === "sch_get_pin_positions") {
        const reference = references.find((candidate) => Math.abs(centers.get(candidate)!.x - Number(args.x_mm)) < 0.001)!;
        result = livePins.filter((pin) => pin.reference === reference).map((pin) => `- Pin ${pin.pin}: (${pin.at.xMm}, ${pin.at.yMm}) mm`).join("\n");
      }
      if (name === "sch_get_bounding_boxes") result = `Schematic bounding boxes (${references.length} symbols):\nRef Value X Y X_min Y_min X_max Y_max\n--------------------\n${references.map((reference) => {
        const center = centers.get(reference)!; const values = livePins.filter((pin) => pin.reference === reference);
        return `${reference} ${leaf} ${center.x} ${center.y} ${Math.min(center.x - 1.27, ...values.map((pin) => pin.at.xMm))} ${Math.min(center.y - 1.27, ...values.map((pin) => pin.at.yMm))} ${Math.max(center.x + 1.27, ...values.map((pin) => pin.at.xMm))} ${Math.max(center.y + 1.27, ...values.map((pin) => pin.at.yMm))}`;
      }).join("\n")}\n\nSheet occupied region: X=[0,300] Y=[0,200] mm`;
      if (name === "sch_get_connectivity_graph") result = applied ? exactGraph() : pristine;
      return { content: [], structuredContent: { result } };
    },
  };
  const captureStyle = async () => {
    // Trusted renderer mock for state-machine tests only. Native style constants
    // have separate measured fixtures; this capture makes no native-run claim.
    const schematic = await readFile(fresh.schematicPath, "utf8"), pcb = await readFile(fresh.pcbPath, "utf8"), project = await readFile(path.join(fresh.projectPath, `${fresh.name}.kicad_pro`), "utf8");
    const sourceIdentities = { schematic: contentIdentity(schematic), pcb: contentIdentity(pcb), projectSettings: contentIdentity(project) };
    const config = JSON.stringify({ drawing: { default_line_thickness: 6 } });
    const profile = FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE;
    const executable = { kind: "kicad-cli", path: path.join(root, "fake-bin", "kicad-cli.exe"), version: profile.version, sha256: profile.executable.digest, sizeBytes: profile.executable.size };
    const outputDirectory = path.join(root, "fake-svg"); const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
    const render = { classification: "candidate-validation", releaseAuthorized: false, executable, sourceIdentities, outputDirectory, source: svg,
      sourceHashes: { [path.relative(root, fresh.schematicPath).split(path.sep).join("/")]: sourceIdentities.schematic.digest },
      schematicSvg: { path: path.join(outputDirectory, "larger.svg"), sha256: contentIdentity(svg).digest, sizeBytes: Buffer.byteLength(svg) },
      invocation: { command: executable.path, executable, exitCode: 0, cwd: root,
        args: ["sch", "export", "svg", "--output", outputDirectory, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", fresh.schematicPath] },
    } as unknown as KicadSchematicSvgResult;
    const tree = canonicalIdentity({ fixture: "synthetic-private-config" }, "evleda.kicad-schematic-configuration-tree.v1");
    const capture: FreshSchematicStrokeStyleCapture = { render, projectSettingsSource: project,
      schematicEngine: { path: path.join(root, "fake-bin", "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
      configuration: { isolation: "caller-owned-isolated", configHome: path.join(root, "fake-config"), treeBefore: tree, treeAfter: tree,
        applicationConfig: { relativePath: "10.0/eeschema.json", source: config, before: contentIdentity(config), after: contentIdentity(config) } } };
    return createFreshSchematicStrokeStyleEvidence(capture, sourceIdentities);
  };
  const bridge = createKicadHarnessTools(session, { freshProject: fresh, freshConnectivityContract: bundle.contract, freshCompilationBundle: bundle, freshSchematicGeometryResolver: resolver,
    ...(fault === "no-style" ? {} : { captureFreshSchematicStrokeStyle: captureStyle }), ...(workLimit === undefined ? {} : { freshSchematicWorkLimit: workLimit }),
    verifyPersistedMutation: async () => true, captureFreshNativeNetlist: async () => native() });
  return { root, fresh, bridge, source, contract, calls, get batchCalls() { return batchCalls; } };
}
