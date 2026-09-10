import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as harnessComposition from "../../src/harness/index.js";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  parsePcbAgentCliArgs,
  computeGenericPcbAgentHarnessRuleIdentity,
  runPcbAgentCheckpointOpen,
  runPcbAgentCli,
  type PcbAgentCliDependencies,
  type PcbAgentGenericFreshCliOptions,
} from "../../src/cli/pcb-agent.js";
import {
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
  checkpointFreshProjectOpenNormalization,
  createFreshNetClassPreparationEvidence,
  createFreshConnectivityContract,
  materializeFreshNetClasses,
  parseFreshProjectOpenPreparedSourceAuthority,
  readFreshNetClassSemanticAuthority,
  readFreshClearanceEvidence,
  parsePcbDesignCompilationBundle,
  prepareFreshProject,
  serializePcbDesignCompilationBundle,
  PCB_AGENT_MIN_ITERATIONS,
  PCB_AGENT_MAX_FRESH_ITERATIONS,
  type FreshProjectNetClassSemanticProjection,
} from "../../src/harness/index.js";
import { KicadCliAdapter, KicadSourceMutationError, type KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { ProcessTimeoutError } from "../../src/integrations/bounded-process.js";
import { createGenericBundleFixture, createGenericDividerBundleFixture, genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { schematicRenderCapture, CLEAR_SCHEMATIC_SVG } from "../helpers/schematic-render-capture.js";
import { verifyFluxSchematicRenderReceiptForReport } from "../../src/flux/runtime.js";
import { compilePcbDesignIntentDraftV1 } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef } from "../../src/harness/pcb-design-compilation-bundle.js";
import { parsePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { verifyHostKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";

const owned = new Set<string>();
const actualOpenAiProviderFactory = harnessComposition.createOpenAIHarnessProvider;

const KICAD_IDENTITY: KicadExecutableIdentity = Object.freeze({
  kind: "kicad-cli",
  path: "C:/fixture/kicad-cli.exe",
  version: "10.0.3",
  commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  capabilityHelpSha256: "b".repeat(64),
  confirmedCapabilities: Object.freeze(["pcb drc"]),
});

const clearanceBoardSource = (netNames: readonly string[]): string => `(kicad_pcb
  (version 20250316)
  (generator "pcbnew")
  (generator_version "10.0.3")
  (general)
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  ${netNames.map((name, index) => `(net ${index + 1} "${name}")`).join("\n  ")}
  ${netNames.map((name, index) => `(footprint "Test:Pad_${index + 1}"
    (layer "F.Cu")
    (at ${5 + index * 3} 5)
    (property "Reference" "X${index + 1}")
    (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net ${index + 1} "${name}"))
  )`).join("\n  ")}
)
`;

/** Complete offline library capability for tests that stop before pad collection. */
async function preflightPhysicalDependencies(fixture: ReturnType<typeof createGenericDividerBundleFixture>) {
  const source = `(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
    ${fixture.bundle.contract.components.map((component, i) => `(footprint "${component.footprintLibId}"
      (uuid "88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}") (layer "F.Cu") (at 0 0) (property "Reference" "${component.reference}")
      ${component.pins.map((pin, j) => `(pad "${pin.pin}" smd rect (uuid "99999999-9999-4999-8999-${String(i * 100 + j + 1).padStart(12, "0")}") (at 0 ${j * 3}) (size 1 1) (layers "F.Cu"))`).join(" ")})`).join(" ")})`;
  const physical = await nativePadObservationFixture(source);
  return { ...fixture.dependencies, libraryResolver: { ...fixture.dependencies.libraryResolver, ...physical.expected.physicalFootprintResolver! } };
}

type FreshNetClassPort = NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>;

const freshNetClassPort = (): FreshNetClassPort => ({
  kicad: KICAD_IDENTITY,
  materialize: async ({ project, bundle }: Parameters<FreshNetClassPort["materialize"]>[0]) =>
    await materializeFreshNetClasses({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY }),
  readSemanticAuthority: async ({ project, bundle }: Parameters<FreshNetClassPort["readSemanticAuthority"]>[0]) =>
    await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY }),
  read: async ({ project, bundle }: Parameters<FreshNetClassPort["read"]>[0]) =>
    await readFreshClearanceEvidence({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY }),
});

const normalizedGenericOpenProject = (name: string, netSettings: unknown): string => JSON.stringify({
  board: {
    file: `${name}.kicad_pcb`, layer_pairs: [], layer_presets: [], viewports: [],
    design_settings: {
      diff_pair_dimensions: [], drc_exclusions: [], track_widths: [], via_dimensions: [],
      rules: { max_error: 0.005, min_clearance: 0, min_connection: 0, min_copper_edge_clearance: 0.5, min_groove_width: 0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_microvia_diameter: 0.2, min_microvia_drill: 0.1, min_resolved_spokes: 2, min_silk_clearance: 0, min_text_height: 0.8, min_text_thickness: 0.08, min_through_hole_diameter: 0.3, min_track_width: 0.2, min_via_annular_width: 0.1, min_via_diameter: 0.5, solder_mask_to_copper_clearance: 0, use_height_for_length_calcs: true },
    },
  },
  boards: [],
  component_class_settings: { assignments: [], sheet_component_classes: { enabled: false } },
  cvpcb: { equivalence_files: [] },
  libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
  meta: { filename: `${name}.kicad_pro`, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project", version: 3 },
  net_settings: netSettings,
  pcbnew: { last_paths: { idf: "", netlist: "", plot: "", specctra_dsn: "", vrml: "" }, page_layout_descr_file: "" },
  schematic: { bus_aliases: {}, file: `${name}.kicad_sch`, legacy_lib_dir: "", legacy_lib_list: [], top_level_sheets: [{ filename: `${name}.kicad_sch`, name, uuid: "00000000-0000-0000-0000-000000000000" }] },
  sheets: [],
  text_variables: {},
  tuning_profiles: {},
}, null, 2);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...owned].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }));
});

const genericOptions = (
  outputDir: string,
  mode: "prepare" | "resume" = "prepare",
): PcbAgentGenericFreshCliOptions => {
  const fixture = createGenericDividerBundleFixture();
  return {
    workflowKind: "generic",
    provider: "openai",
    model: "gpt-test",
    newProjectName: "divider",
    outputDir,
    iterations: 1,
    openAiServiceTier: "fast",
    mode,
    compilationBundle: fixture.bundle,
    compilationBundleRef: fixture.reference,
  };
};

async function runClearanceReceiptScenario(
  root: string,
  disposition: "forged" | "drift-after-verify" | "native-render" | "svg-source-mutation" | "svg-abort" | "svg-timeout" | "drift-after-capture" | "svg-invalid-binding" | "svg-unsupported" | "gate-exception" | "pads-forged" | "pads-stale" | "pads-library-drift" | "pads-close-failure" | "pads-close-drift" | "pads-absent" | "pads-marker-drift" | "pads-tool-drift" | "pads-library-geometry" | "pads-resolver-absent",
  executionOptions: Partial<Pick<PcbAgentGenericFreshCliOptions, "provider" | "iterations">> = {},
) {
  const fixture = createGenericDividerBundleFixture(`Clearance receipt ${disposition} regression.`);
  // Complete synthetic physical library: repeated numbered copper, a real PTH
  // member and paste-only apertures. Fake IPC responses are not native proof.
  const padId = (i: number, j: number) => `77777777-7777-4777-8777-${String(i * 100 + j).padStart(12, "0")}`;
  const boardText = `(kicad_pcb (version 20250316) (generator "pcbnew") (generator_version "10.0.3")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
    ${fixture.bundle.contract.nets.map((net, i) => `(net ${i + 1} "${net.name}")`).join(" ")}
    ${fixture.bundle.contract.components.map((component, i) => `(footprint "${component.footprintLibId}" (uuid "${padId(i, 1)}") (layer "F.Cu") (at ${5 + 7 * i} 5)
      (property "Reference" "${component.reference}") (property "Value" "${component.value}")
      ${component.pins.map((pin, j) => `(pad "${pin.pin}" smd rect (uuid "${padId(i, j + 2)}") (at 0 ${j * 3}) (size 1 1) (layers "F.Cu") (net ${fixture.bundle.contract.nets.findIndex(net => pin.assignment.kind === "net" && net.name === pin.assignment.net) + 1} "${pin.assignment.kind === "net" ? pin.assignment.net : ""}"))`).join(" ")}
      ${component.reference.startsWith("R") ? `(pad "2" thru_hole circle (uuid "${padId(i, 20)}") (at 0 3) (size 0.8 0.8) (drill 0.3) (layers "*.Cu") (net ${fixture.bundle.contract.nets.findIndex(net => component.pins[1]!.assignment.kind === "net" && net.name === component.pins[1]!.assignment.net) + 1} "${component.pins[1]!.assignment.kind === "net" ? component.pins[1]!.assignment.net : ""}"))
        (pad "" smd rect (uuid "${padId(i, 21)}") (at 0 1.5) (size 0.4 0.4) (layers "F.Paste"))` : ""})`).join(" ")})`;
  const physicalFixture = await nativePadObservationFixture(boardText);
  let libraryDrift = false;
  const physicalResolver = { ...fixture.dependencies.libraryResolver, inspectFootprint: (id: string) => {
    const inspection = physicalFixture.expected.physicalFootprintResolver!.inspectFootprint(id);
    if (inspection !== null && libraryDrift && disposition === "pads-library-geometry") return { ...inspection, physicalPads: inspection.physicalPads.map((pad, i) => i ? pad : { ...pad, at: { ...pad.at, xMm: pad.at.xMm + 0.1 } }) };
    return inspection === null || !libraryDrift ? inspection : { ...inspection, sourceIdentity: contentIdentity("changed library") };
  } };
  const compilationDependencies = disposition === "pads-resolver-absent" ? fixture.dependencies : { ...fixture.dependencies, libraryResolver: physicalResolver };
  const output = path.join(root, disposition);
  const prepared = await runPcbAgentCli({
    ...genericOptions(output, "prepare"),
    compilationBundle: fixture.bundle,
    compilationBundleRef: fixture.reference,
  }, {
    compilationBundleDependencies: compilationDependencies,
    freshDesignClearanceEvidencePort: freshNetClassPort(),
  });
  const preparationEvidence = prepared.report.freshNetClassPreparationEvidence;
  const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
  if (preparationEvidence === undefined || preparedSourceAuthority === undefined) throw new Error("Expected prepare authorities.");
  let portReadCalls = 0;
  let renderCalls = 0;
  let padCalls = 0; const lifecycle: string[] = [];
  let fakeSessionGeneration = 1;
  let providerCalls = 0; let providerTurns = 0; let sessionCloses = 0; const publishedStatuses: string[] = []; const httpRequests: Record<string, unknown>[] = [];
  if ((executionOptions.provider ?? "openai") === "openai") {
    vi.spyOn(harnessComposition, "createOpenAIHarnessProvider").mockImplementation((options) => {
      const provider = actualOpenAiProviderFactory(options); const originalTurn = provider.turn.bind(provider);
      vi.spyOn(provider, "turn").mockImplementation(async (request, context) => {
        providerTurns += 1;
        return await originalTurn(request, context);
      });
      return provider;
    });
  }
  const execution = await runPcbAgentCli({
    ...genericOptions(output, "resume"),
    ...executionOptions,
    compilationBundle: fixture.bundle,
    compilationBundleRef: fixture.reference,
  }, {
    compilationBundleDependencies: compilationDependencies,
    expectedFreshNetClassPreparationEvidence: preparationEvidence,
    expectedFreshProjectOpenPreparedSourceAuthority: preparedSourceAuthority,
    environment: { OPENAI_API_KEY: "test" },
    observer: async (event) => { if (event.type === "report") publishedStatuses.push(event.report.status); },
    fetch: async (_url, init) => { providerCalls += 1;
      if (typeof init?.body !== "string") throw new Error("Expected a JSON fixture request body.");
      httpRequests.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
      id: `resp-board-edit-${providerCalls}`, status: "completed", error: null, incomplete_details: null,
      output: disposition === "svg-unsupported" && providerCalls > 1
        ? [{ id: `msg-board-review-${providerCalls}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Validate the remaining unsupported SVG coverage.", annotations: [] }] }]
        : [{ id: `fc-board-edit-${providerCalls}`, type: "function_call", status: "completed", call_id: `board-edit-${providerCalls}`, name: "pcb_add_track", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } }); },
    freshDesignClearanceEvidencePort: {
      kicad: KICAD_IDENTITY,
      materialize: async () => { throw new Error("resume must not materialize"); },
      readSemanticAuthority: async ({ project, bundle }) =>
        await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY }),
      read: async ({ project, bundle }) => {
        portReadCalls += 1;
        if (disposition === "forged") {
          const pcbSha256 = contentIdentity(await readFile(project.pcbPath)).digest;
          return {
            schemaVersion: "forged-receipt",
            acceptanceEvidence: {
              origin: "host",
              schemaVersion: FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
              source: "kicad-effective-netclass-rules",
              pcbSha256,
              rulesSourceSha256: "c".repeat(64),
              netClasses: [{ id: "DEFAULT", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.2 }],
            },
          } as never;
        }
        return await readFreshClearanceEvidence({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY });
      },
    },
    freshDesignNetlistCollector: async ({ project }) => {
      if (disposition === "drift-after-verify") {
        await writeFile(project.pcbPath, `${await readFile(project.pcbPath, "utf8")} `, "utf8");
      }
      return "invalid native netlist evidence";
    },
    freshSchematicRenderCollector: async ({ project, validationSourceBinding }) => {
      renderCalls += 1;
      if (disposition === "svg-source-mutation") {
        await writeFile(project.schematicPath, `${await readFile(project.schematicPath, "utf8")} `, "utf8");
        throw new KicadSourceMutationError([path.basename(project.schematicPath)]);
      }
      if (disposition === "svg-abort") throw new DOMException("SVG collector aborted", "AbortError");
      if (disposition === "svg-timeout") throw new ProcessTimeoutError("SVG collector timed out", { command: "fixture-kicad-cli", args: ["sch", "export", "svg"], cwd: output, timeoutMs: 1, env: {}, maxOutputBytes: 1024 }, "", "");
      const expected = { sources: { schematic: validationSourceBinding.after.schematic, pcb: validationSourceBinding.after.pcb, projectSettings: validationSourceBinding.after.projectSettings! }, executable: KICAD_IDENTITY, validationSourceBindingIdentity: validationSourceBinding.identity };
      const outputDirectory = path.join(output, "native-svg-fixture", String(renderCalls)); await mkdir(outputDirectory, { recursive: true });
      const source = disposition === "svg-unsupported" ? CLEAR_SCHEMATIC_SVG.replace("M1 1 L2 1", "M1 1 C2 2 3 3 4 4") : CLEAR_SCHEMATIC_SVG;
      const capture = schematicRenderCapture(expected, outputDirectory, source); await writeFile(capture.schematicSvg.path, capture.source, "utf8");
      if (disposition === "drift-after-capture") await writeFile(project.schematicPath, `${await readFile(project.schematicPath, "utf8")} `, "utf8");
      return disposition === "svg-invalid-binding" ? { ...capture, schematicSvg: { ...capture.schematicSvg, sha256: "f".repeat(64) } } : capture;
    },
    sessionFactory: async (sessionOptions) => ({
      get identity() { return { fakeSessionGeneration }; },
      close: async () => { sessionCloses += 1; lifecycle.push("close"); if (disposition === "pads-close-failure") throw new Error("Fake pad session close failed"); if (disposition === "pads-close-drift") libraryDrift = true; },
      ...(disposition === "pads-absent" ? {} : { readLivePcbPadSnapshot: async (ids: readonly string[]) => {
        expect(sessionCloses).toBe(0); padCalls += 1; lifecycle.push("pads");
        if (disposition === "pads-forged") return { content: [], structuredContent: physicalFixture.observation };
        const source = await readFile(path.join(sessionOptions.projectRoot, "divider.kicad_pcb"), "utf8");
        const current = await nativePadObservationFixture(source, boardText);
        const payload = structuredClone(current.observation.rawSnapshot) as any;
        const document = { type: "DOCTYPE_PCB", board_filename: "divider.kicad_pcb", project: { name: "divider", path: sessionOptions.projectRoot } };
        payload.documentBefore = document; payload.documentAfter = document;
        payload.enabledLayers.request.board = document; payload.footprintInventory.request.header.document = document; payload.padstackPresence.request.board = document;
        payload.connectivity = ids.map(id => { const query = payload.connectivity.find((query: any) => query.sourcePrimitiveId === id); if (query === undefined) throw new Error("Missing fake query"); query.request.header.document = document; return query; });
        if (disposition === "pads-stale") await writeFile(path.join(sessionOptions.projectRoot, "divider.kicad_pcb"), source + "\n", "utf8");
        if (disposition === "pads-library-drift" || disposition === "pads-library-geometry") libraryDrift = true;
        if (disposition === "pads-tool-drift") fakeSessionGeneration += 1;
        if (disposition === "pads-marker-drift") {
          const markerPath = path.join(output, ".evleda-pcb-agent-fresh.json");
          await writeFile(markerPath, `${await readFile(markerPath, "utf8")} `, "utf8");
        }
        return { isError: false, content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
      } }),
      assertActivePcb: async (expected) => { expect(expected).toBe(path.join(sessionOptions.projectRoot, "divider.kicad_pcb")); },
      readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
      listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter((name) => name !== "evleda_get_live_pcb_document").map((name) => ({
        name, permission: "write" as const, description: name, inputSchema: { type: "object" },
      })),
      callTool: async (name) => {
        const pcbPath = path.join(sessionOptions.projectRoot, "divider.kicad_pcb");
        if (name === "pcb_add_track") await writeFile(pcbPath, boardText, "utf8");
        if (name === "pcb_save") await writeFile(pcbPath, `${await readFile(pcbPath, "utf8")}\n`, "utf8");
        const structuredContent = name === "run_erc"
          ? { status: "clean", findings: [], metadata: { available: true, violation_count: 0 } }
          : name === "run_drc"
            ? { status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } }
            : name === "pcb_get_board_summary"
              ? { status: "clean", findings: [], metadata: { footprints: 3, nets: 3, tracks: 1, shapes: 1 } }
              : name === "pcb_visual_qa"
                ? { status: "clean", findings: [], footprint_count: 3, board_bounds: [0, 0, 30, 20] }
                : name === "kicad_get_project_info"
                  ? { active_pcb_path: pcbPath }
                  : name === "pcb_get_board_as_string"
                    ? { result: await readFile(pcbPath, "utf8") }
                    : { status: "ok", result: "ok" };
        return { content: [], structuredContent };
      },
    }),
  });
  return { execution, portReadCalls, renderCalls, fixture, providerCalls, providerTurns, sessionCloses, publishedStatuses, httpRequests, padCalls, lifecycle };
}

describe("generic compilation-bundle PCB CLI", () => {
  it("collects source-pinned physical pads through the private session before closure and passes the pair to acceptance", async () => {
    const evaluator = vi.spyOn(harnessComposition, "evaluateFreshDesignAcceptance");
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-cli-native-pads-")); owned.add(root);
    const result = await runClearanceReceiptScenario(root, "native-render");
    const captures = evaluator.mock.calls.filter(([evidence]) => evidence.nativePads !== undefined);
    expect(captures.length, result.execution.report.summary).toBeGreaterThanOrEqual(2);
    for (const [evidence, artifacts] of captures) {
      expect(verifyHostKicadNativePadObservation(evidence.nativePads, artifacts.nativePadExpected!)).toBe(evidence.nativePads);
      expect(artifacts.nativePadExpected!.pcbSource).toBe(evidence.pcbSource);
      expect(evidence.nativePads!.physicalLibraryBindings).toHaveLength(3);
      expect(evidence.nativePads!.inventory!.physicalPads).toHaveLength(11);
      expect(evidence.nativePads!.inventory!.terminals).toHaveLength(7);
      expect(artifacts.nativePadExpected!.requestedPrimitiveIds).toHaveLength(9);
    }
    expect(result.lifecycle.at(-1)).toBe("close"); expect(result.sessionCloses).toBe(1);
    const reportText = await readFile(result.execution.reportPath, "utf8");
    expect(reportText).not.toContain("rawSnapshot"); expect(reportText).not.toContain("padRecords");
    expect(JSON.stringify(result.httpRequests)).not.toContain("padRecords");
  });
  it.each(["pads-absent", "pads-resolver-absent", "pads-forged", "pads-stale", "pads-library-drift", "pads-library-geometry", "pads-marker-drift", "pads-tool-drift", "pads-close-failure", "pads-close-drift"] as const)("fails closed and clears paired acceptance on %s", async fault => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-cli-native-pads-fault-")); owned.add(root);
    const result = await runClearanceReceiptScenario(root, fault);
    expect(result.execution.report.status, result.execution.report.summary).toBe("failed");
    const reason = { "pads-absent": /runtime capability/, "pads-resolver-absent": /approved physical-footprint resolver/,
      "pads-forged": /Native pad observation/, "pads-stale": /source\/marker changed/, "pads-library-drift": /library source/,
      "pads-library-geometry": /inventory\/geometry differs/, "pads-marker-drift": /marker bytes changed/, "pads-tool-drift": /session\/tool identity changed/,
      "pads-close-failure": /Fake pad session close failed/, "pads-close-drift": /library source/ }[fault];
    expect(result.execution.report.summary).toMatch(reason);
    expect(result.publishedStatuses).toEqual(["failed"]); expect(result.sessionCloses).toBe(fault === "pads-resolver-absent" ? 0 : 1);
    expect(result.execution.report.freshAcceptance?.passed).not.toBe(true);
    expect(result.execution.report.freshSchematicRenderClearanceEvidence).toBeUndefined();
    expect(result.execution.report.freshClearanceEvidenceReceipt).toBeUndefined();
    if (fault === "pads-absent" || fault === "pads-resolver-absent") { expect(result.padCalls).toBe(0); expect(result.providerCalls).toBe(0); }
    else expect(result.padCalls).toBeGreaterThan(0);
  });
  it.each([
    ["svg-source-mutation", "KiCad changed protected native source files"],
    ["svg-abort", "SVG collector aborted"],
    ["svg-timeout", "SVG collector timed out"],
    ["drift-after-capture", "Fresh sources changed after collection"],
    ["svg-invalid-binding", "invalid source/tool/artifact authority"],
  ] as const)("terminates %s after one provider turn and closes the owned session without completed publication", async (fault, summary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-terminal-svg-")); owned.add(root);
    const result = await runClearanceReceiptScenario(root, fault, { iterations: 3 });
    expect(result.providerTurns).toBe(1); expect(result.providerCalls).toBe(1); expect(result.renderCalls).toBe(1); expect(result.sessionCloses).toBe(1);
    expect(result.execution.report).toMatchObject({ status: "failed", summary: expect.stringContaining(summary) });
    expect(result.execution.report.freshSchematicRenderClearanceEvidence).toBeUndefined(); expect(result.execution.report.freshClearanceEvidenceReceipt).toBeUndefined();
    expect(result.publishedStatuses).toEqual(["failed"]);
    expect(JSON.parse(await readFile(result.execution.reportPath, "utf8"))).toMatchObject({ status: "failed", summary: expect.stringContaining(summary) });
  });

  it("retains a gate exception and closes the session even when terminal acceptance recollection also rejects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-terminal-gate-")); owned.add(root);
    const failure = new Error("Completion gate internal preservation fault");
    const originalEvaluator = harnessComposition.evaluateFreshDesignAcceptance; let evaluations = 0;
    const evaluator = vi.spyOn(harnessComposition, "evaluateFreshDesignAcceptance").mockImplementation((evidence, artifacts) => { evaluations += 1; if (evaluations === 1) return originalEvaluator(evidence, artifacts); throw failure; });
    const result = await runClearanceReceiptScenario(root, "gate-exception", { iterations: 3 });
    expect(result.providerTurns).toBe(1); expect(result.providerCalls).toBe(1); expect(result.renderCalls).toBe(1); expect(result.sessionCloses).toBe(1);
    expect(evaluator).toHaveBeenCalledTimes(3); expect(result.execution.report).toMatchObject({ status: "failed", summary: expect.stringContaining(failure.message) });
    expect(result.publishedStatuses).toEqual(["failed"]); expect(result.execution.report.freshSchematicRenderClearanceEvidence).toBeUndefined();
  });

  it("replays actual CLI quality feedback through a second fake OpenAI HTTP request and closes once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-unsupported-svg-")); owned.add(root);
    const result = await runClearanceReceiptScenario(root, "svg-unsupported", { iterations: 2 });
    expect(result.providerTurns, result.execution.report.summary).toBe(2); expect(result.providerCalls).toBe(2); expect(result.httpRequests).toHaveLength(2);
    expect(JSON.stringify(result.httpRequests[1]?.input)).toContain("schematic-render-clearance [unknown]");
    expect(JSON.stringify(result.httpRequests[1]?.input)).toContain("UNSUPPORTED_PATH_COMMAND");
    expect(result.httpRequests[1]?.input).toEqual(expect.arrayContaining([
      { id: "fc-board-edit-1", type: "function_call", status: "completed", call_id: "board-edit-1", name: "pcb_add_track", arguments: "{}" },
      expect.objectContaining({ type: "function_call_output", call_id: "board-edit-1" }),
    ]));
    expect(result.renderCalls, result.execution.report.summary).toBe(3); expect(result.sessionCloses).toBe(1);
    expect(result.execution.report.status).toBe("needs_review"); expect(result.execution.report.freshSchematicRenderClearanceEvidence).toMatchObject({ status: "unknown", bindingProblems: [] });
    expect(result.publishedStatuses).toEqual(["needs_review"]);
  });

  it("rejects historical v1 acceptance profiles before current generic prepare can create a project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-legacy-")); owned.add(root);
    const current = createGenericDividerBundleFixture(); const compilation = compilePcbDesignIntentDraftV1(genericDividerDraft(), current.dependencies);
    const bundle = createPcbDesignCompilationBundle({ originalPrompt: "Historical v1 candidate", compilation }, current.dependencies);
    const output = path.join(root, "legacy-output");
    await expect(runPcbAgentCli({ ...genericOptions(output), compilationBundle: bundle, compilationBundleRef: createPcbDesignCompilationBundleRef(bundle) }, {
      compilationBundleDependencies: current.dependencies, freshDesignClearanceEvidencePort: freshNetClassPort(),
    })).rejects.toThrow(/historical V1 bundles cannot authorize execution/iu);
    await expect(readFile(path.join(output, "pcb-agent-report.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("carries a passing native ink receipt through the real CLI, harness and serialized Flux report boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-render-")); owned.add(root);
    const { execution, renderCalls, fixture } = await runClearanceReceiptScenario(root, "native-render");
    expect(renderCalls).toBeGreaterThanOrEqual(2); // In-run gate and terminal recollection.
    expect(execution.report.freshSchematicRenderClearanceEvidence?.status).toBe("pass");
    expect(execution.report.freshAcceptance?.requirements.find((entry) => entry.id === "schematic-render-clearance")?.status).toBe("pass");
    const disk = JSON.parse(await readFile(execution.reportPath, "utf8")) as typeof execution.report;
    expect(disk).toEqual(execution.report);
    expect(verifyFluxSchematicRenderReceiptForReport(disk, execution.report, fixture.bundle.acceptancePlan.identity, KICAD_IDENTITY).status).toBe("pass");
    // A report serializer cannot pretend that a deserialized receipt retains its host brand.
    expect(() => verifyFluxSchematicRenderReceiptForReport(disk, structuredClone(execution.report), fixture.bundle.acceptancePlan.identity, KICAD_IDENTITY)).toThrow();
    const forged = { ...execution.report, freshSchematicRenderClearanceEvidence: { ...execution.report.freshSchematicRenderClearanceEvidence!, status: "pass" as const } };
    expect(() => verifyFluxSchematicRenderReceiptForReport(forged, forged, fixture.bundle.acceptancePlan.identity, KICAD_IDENTITY)).toThrow();
    const acceptance = execution.report.freshAcceptance!;
    if (!("acceptancePlanIdentity" in acceptance)) throw new Error("Expected current generic acceptance.");
    const missingRow = { ...execution.report, freshAcceptance: { ...acceptance, requirements: acceptance.requirements.filter((entry) => entry.id !== "schematic-render-clearance") } };
    expect(() => verifyFluxSchematicRenderReceiptForReport(missingRow, missingRow, fixture.bundle.acceptancePlan.identity, KICAD_IDENTITY)).toThrow();
    const binding = execution.report.harness!.validation.sourceBinding!;
    const snapshot = { ...binding.after, schematic: contentIdentity("source changed after export") }; const validationPayload = { schemaVersion: binding.schemaVersion, before: snapshot, after: snapshot, unchanged: true };
    const stale = { ...execution.report, harness: { ...execution.report.harness!, validation: { ...execution.report.harness!.validation, sourceBinding: { ...validationPayload, identity: canonicalIdentity(validationPayload, validationPayload.schemaVersion) } } } };
    expect(() => verifyFluxSchematicRenderReceiptForReport(stale, stale, fixture.bundle.acceptancePlan.identity, KICAD_IDENTITY)).toThrow();
  });
  it.each([
    ["codex", 12], ["codex", 24], ["claude-cli", 12], ["claude-cli", 24],
  ] as const)("scopes execution resource headroom to fresh extended budgets: %s %i", async (provider, iterations) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-budget-")); owned.add(root);
    const factory = vi.spyOn(harnessComposition, provider === "codex" ? "createCodexCliHarnessProvider" : "createClaudeCliHarnessProvider")
      .mockReturnValue({ provider, turn: async () => { throw new Error("Provider must not run in resource wiring test"); } } as never);
    const runner = vi.spyOn(harnessComposition, "runPcbAgentHarness").mockRejectedValue(new Error("Resource wiring probe stopped before provider execution"));
    await runClearanceReceiptScenario(root, "forged", { provider, iterations });
    expect(factory).toHaveBeenCalledTimes(1); expect(runner).toHaveBeenCalledTimes(1);
    const providerOptions = factory.mock.calls[0]![0]!; const harnessOptions = runner.mock.calls[0]![0];
    expect(providerOptions).not.toHaveProperty("timeoutMs"); expect(harnessOptions).toMatchObject({ maxIterations: iterations });
    if (iterations > 12) {
      expect(providerOptions).toMatchObject({ maxOutputBytes: 1024 * 1024 }); expect(harnessOptions).toMatchObject({ maxMessages: 256 });
    } else {
      expect(providerOptions).not.toHaveProperty("maxOutputBytes"); expect(harnessOptions).not.toHaveProperty("maxMessages");
    }
  });

  it("parses canonical bundle files before constructing prompt-free generic options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const bundleFile = path.join(root, "divider.bundle.json");
    const referenceFile = path.join(root, "divider.ref.json");
    await writeFile(bundleFile, serializePcbDesignCompilationBundle(fixture.bundle));
    await writeFile(referenceFile, `${JSON.stringify(fixture.reference)}\n`, "utf8");
    const parsed = await parsePcbAgentCliArgs([
      "--workflow", "generic", "--bundle-file", bundleFile, "--bundle-ref-file", referenceFile,
      "--model", "gpt-test", "--new-project", "divider", "--output-dir", path.join(root, "output"), "--prepare",
    ], root, fixture.dependencies);
    expect(parsed).toMatchObject({ workflowKind: "generic", compilationBundleRef: fixture.reference, iterations: 3 });
    expect(parsed).not.toHaveProperty("prompt");
    expect("compilationBundle" in parsed && parsed.compilationBundle.identity).toStrictEqual(fixture.bundle.identity);
    const argumentsFor = (iterations: number) => [
      "--workflow", "generic", "--bundle-file", bundleFile, "--bundle-ref-file", referenceFile,
      "--model", "gpt-test", "--new-project", "divider", "--output-dir", path.join(root, `output-${iterations}`), "--prepare", "--iterations", String(iterations),
    ];
    await expect(parsePcbAgentCliArgs(argumentsFor(PCB_AGENT_MAX_FRESH_ITERATIONS), root, fixture.dependencies)).resolves.toMatchObject({ iterations: PCB_AGENT_MAX_FRESH_ITERATIONS });
    await expect(parsePcbAgentCliArgs(argumentsFor(PCB_AGENT_MAX_FRESH_ITERATIONS + 1), root, fixture.dependencies)).rejects.toThrow(`through ${PCB_AGENT_MAX_FRESH_ITERATIONS}`);
    await expect(parsePcbAgentCliArgs(argumentsFor(PCB_AGENT_MIN_ITERATIONS - 1), root, fixture.dependencies)).rejects.toThrow(`from ${PCB_AGENT_MIN_ITERATIONS}`);
  });

  it("binds the divider bundle, exact generated library tables, generic acceptance, and V2 checkpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const options: PcbAgentGenericFreshCliOptions = { ...genericOptions(output), compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference };
    const execution = await runPcbAgentCli(options, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    expect(execution.report.schemaVersion).toBe("evleda.pcb-agent-cli-report.v2");
    expect(execution.report.status).toBe("needs_review");
    expect(execution.report.ruleProfile.harnessRuleIdentity).toBe(computeGenericPcbAgentHarnessRuleIdentity(fixture.bundle));
    expect("workflow" in execution.report && execution.report.workflow).toMatchObject({
      kind: "generic",
      bundleRef: fixture.reference,
      contractIdentity: fixture.bundle.contract.identity,
      libraryBindingIdentity: fixture.bundle.libraryBinding.identity,
      deepRuleBindingIdentity: fixture.bundle.deepRuleBinding.identity,
      acceptancePlanIdentity: fixture.bundle.acceptancePlan.identity,
      executionPromptContentIdentity: fixture.bundle.executionPrompt.textContentIdentity,
    });
    if (!("workflow" in execution.report)) throw new Error("Expected V2 workflow binding.");
    const { identity: workflowIdentity, ...workflowPayload } = execution.report.workflow;
    expect(workflowIdentity).toStrictEqual(canonicalIdentity(workflowPayload, "evleda.pcb-agent-workflow-binding.v2"));
    expect(execution.report.freshAcceptance).toMatchObject({
      schemaVersion: "evleda.fresh-design-acceptance.v2",
      passed: false,
      contractIdentity: fixture.bundle.contract.identity,
      acceptancePlanIdentity: fixture.bundle.acceptancePlan.identity,
    });
    expect(execution.report.freshAcceptance?.requirements.map((row) => row.id)).toContain("net:VOUT:schematic");
    expect(execution.report.freshAcceptance?.missing).toContainEqual(expect.stringMatching(/^netclass:POWER:clearance \[unknown\]:/u));
    expect(execution.report.freshNetClassMaterialization).toMatchObject({ changed: true });
    expect(execution.report.freshNetClassSemanticAuthority).toMatchObject({
      bundleIdentity: fixture.bundle.identity,
      contractIdentity: fixture.bundle.contract.identity,
    });
    expect(execution.report.freshNetClassPreparationEvidence).toStrictEqual(createFreshNetClassPreparationEvidence(
      execution.report.freshNetClassMaterialization!,
      execution.report.freshNetClassSemanticAuthority!,
    ));
    expect(Object.keys(execution.report.freshNetClassPreparationEvidence!).sort()).toEqual([
      "bundleIdentity", "classification", "contractIdentity", "fabricationAuthorized",
      "freshMarkerContentIdentity", "genericProjectBindingIdentity", "identity", "kicad",
      "materializationIdentity", "origin", "qualificationEstablished", "releaseAuthorized",
      "schemaVersion", "semanticAuthorityIdentity",
    ].sort());
    expect(JSON.stringify(execution.report.freshNetClassPreparationEvidence)).not.toMatch(/[A-Z]:[\\/]|freshNetClassMaterialization|freshNetClassSemanticAuthority/u);
    const preparedSourceAuthority = execution.report.freshProjectOpenPreparedSourceAuthority;
    if (preparedSourceAuthority === undefined) throw new Error("Expected prepared-source authority.");
    expect(canonicalJson(parseFreshProjectOpenPreparedSourceAuthority(preparedSourceAuthority))).toBe(canonicalJson(preparedSourceAuthority));
    expect(preparedSourceAuthority.pro).toStrictEqual(execution.report.freshNetClassMaterialization!.projectSettingsIdentity);
    expect(preparedSourceAuthority.pcb).toStrictEqual(execution.report.freshNetClassMaterialization!.pcbIdentityAtMaterialization);
    expect(preparedSourceAuthority.marker).toStrictEqual(execution.report.freshNetClassMaterialization!.freshMarkerContentIdentity);

    const marker = JSON.parse(await readFile(path.join(output, ".evleda-pcb-agent-fresh.json"), "utf8"));
    const checkpoint = JSON.parse(await readFile(path.join(output, ".evleda-pcb-agent-checkpoint.json"), "utf8"));
    const persistedReport = JSON.parse(await readFile(path.join(output, "pcb-agent-report.json"), "utf8"));
    expect(canonicalJson(persistedReport.freshNetClassPreparationEvidence)).toBe(canonicalJson(execution.report.freshNetClassPreparationEvidence));
    expect(marker).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project.v2", workflowKind: "generic", genericBinding: { bundleRef: fixture.reference } });
    expect(checkpoint).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v2", genericBindingIdentity: marker.genericBinding.identity });
    await expect(checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name: "divider",
      expectedNetClassProjection: {
        netClasses: execution.report.freshNetClassSemanticAuthority!.netClasses,
        contractNetAssignments: execution.report.freshNetClassSemanticAuthority!.contractNetAssignments,
      },
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).resolves.toMatchObject({ changed: false });
    const symbolTable = await readFile(path.join(output, "project", "sym-lib-table"), "utf8");
    const footprintTable = await readFile(path.join(output, "project", "fp-lib-table"), "utf8");
    expect(symbolTable).toContain("Connector_Generic");
    expect(symbolTable).toContain("Device");
    expect(footprintTable).toContain("Connector_PinHeader_2.54mm");
    expect(footprintTable).toContain("Resistor_SMD");
    expect(`${symbolTable}\n${footprintTable}\n${JSON.stringify(marker.genericBinding)}`).not.toMatch(/LED_SMD|fresh-led-indicator|led_compatibility_fixture/u);
    expect(marker.genericBinding.symbolLibraryTableIdentity).toStrictEqual(contentIdentity(symbolTable));
    expect(marker.genericBinding.footprintLibraryTableIdentity).toStrictEqual(contentIdentity(footprintTable));
  });

  it("forwards the exact generic net-class projection when checkpointing changed KiCad project settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const authority = prepared.report.freshNetClassSemanticAuthority;
    if (authority === undefined) throw new Error("Expected semantic authority.");
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (preparedSourceAuthority === undefined) throw new Error("Expected prepared-source authority.");
    const projection: FreshProjectNetClassSemanticProjection = {
      netClasses: authority.netClasses,
      contractNetAssignments: authority.contractNetAssignments,
    };
    const projectSettingsPath = path.join(output, "project", "divider.kicad_pro");
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, "utf8")) as { net_settings: unknown };
    await writeFile(projectSettingsPath, normalizedGenericOpenProject("divider", projectSettings.net_settings), "utf8");

    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).resolves.toMatchObject({ changed: true });
    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).resolves.toMatchObject({ changed: false });
  });

  it("rejects every generic checkpoint missing prepared-source authority or semantic projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const semanticAuthority = prepared.report.freshNetClassSemanticAuthority;
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (semanticAuthority === undefined || preparedSourceAuthority === undefined) throw new Error("Expected generic prepare authorities.");
    const projection: FreshProjectNetClassSemanticProjection = {
      netClasses: semanticAuthority.netClasses,
      contractNetAssignments: semanticAuthority.contractNetAssignments,
    };
    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedNetClassProjection: projection,
    })).rejects.toThrow("Generic KiCad Open normalization requires lifecycle-owned prepared-source authority");
    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).rejects.toThrow("Generic KiCad project normalization requires the expected net-class semantic projection");

    const projectSettingsPath = path.join(output, "project", "divider.kicad_pro");
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, "utf8")) as { net_settings: unknown };
    await writeFile(projectSettingsPath, normalizedGenericOpenProject("divider", projectSettings.net_settings), "utf8");
    const checkpointPath = path.join(output, ".evleda-pcb-agent-checkpoint.json");
    const checkpointBefore = await readFile(checkpointPath, "utf8");

    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedNetClassProjection: projection,
    })).rejects.toThrow("Generic KiCad Open normalization requires lifecycle-owned prepared-source authority");
    await expect(runPcbAgentCheckpointOpen({
      outputDir: output,
      newProjectName: "divider",
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).rejects.toThrow("Generic KiCad project normalization requires the expected net-class semantic projection");
    await expect(readFile(checkpointPath, "utf8")).resolves.toBe(checkpointBefore);
  });

  it("uses the divider contract for host connectivity and the exact untruncated bundle prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const longIntent = `Build a non-LED divider.\n${"verbatim-divider-intent-".repeat(900)}\nEND-INTENT`;
    const fixture = createGenericDividerBundleFixture(longIntent);
    const physicalDependencies = await preflightPhysicalDependencies(fixture);
    let providerUserText = "";
    let providerToolNames: string[] = [];
    const lifecycle: string[] = [];
    const output = path.join(root, "output");
    let semanticReads = 0;
    const port: FreshNetClassPort = {
      kicad: KICAD_IDENTITY,
      materialize: async ({ project, bundle }) => {
        lifecycle.push("prepare-materialize-netclasses");
        return await materializeFreshNetClasses({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY });
      },
      readSemanticAuthority: async ({ project, bundle }) => {
        semanticReads += 1;
        lifecycle.push(semanticReads === 1 ? "prepare-read-semantic-authority" : "resume-read-semantic-authority");
        return await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY });
      },
      read: async () => { throw new Error("No final validation was reached in this connectivity preflight test."); },
    };
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, { compilationBundleDependencies: fixture.dependencies, freshDesignClearanceEvidencePort: port });
    const preparationEvidence = prepared.report.freshNetClassPreparationEvidence;
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (preparationEvidence === undefined || preparedSourceAuthority === undefined) throw new Error("Expected prepare authorities.");
    const execution = await runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: physicalDependencies,
      expectedFreshNetClassPreparationEvidence: preparationEvidence,
      expectedFreshProjectOpenPreparedSourceAuthority: preparedSourceAuthority,
      freshDesignClearanceEvidencePort: {
        ...port,
        materialize: async () => { throw new Error("resume must never materialize net classes"); },
        read: async () => { throw new Error("No final validation was reached in this connectivity preflight test."); },
      },
      environment: { OPENAI_API_KEY: "test" },
      fetch: async (_input, init) => {
        lifecycle.push("provider-turn");
        const body = JSON.parse(String(init?.body)) as { input: { role?: string; content?: { text?: string }[] }[]; tools?: { name?: string }[] };
        providerUserText = body.input.find((entry) => entry.role === "user")?.content?.[0]?.text ?? "";
        providerToolNames = body.tools?.map((tool) => tool.name ?? "") ?? [];
        return new Response(JSON.stringify({
          id: "resp-generic-connectivity", status: "completed", error: null, incomplete_details: null,
          output: [{ id: "fc-generic-connectivity", type: "function_call", status: "completed", call_id: "generic-connectivity", name: "fresh_apply_contract_connectivity", arguments: "{}" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      sessionFactory: async () => {
        lifecycle.push("authority-connect-and-prebind");
        return {
          supportsNativeRouteTransactions:()=>true,
          readLivePcbPadSnapshot: async () => { throw new Error("No final validation was reached in this connectivity preflight test."); },
          assertActivePcb: async () => undefined,
          readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
          listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter((name) => name !== "evleda_get_live_pcb_document").map((name) => ({ name, permission: "write" as const, description: name, inputSchema: { type: "object" } })),
          callTool: async (name) => {
            if (name === "kicad_set_project") lifecycle.push("kicad-set-project");
            return {
              content: [],
              structuredContent: {
                result: name === "sch_get_symbols" ? ""
                  : name === "sch_get_connectivity_graph" ? "The active schematic has no connectivity to summarize."
                    : "ok",
              },
            };
          },
        };
      },
    });
    expect(lifecycle.slice(0, 6)).toEqual([
      "prepare-materialize-netclasses",
      "prepare-read-semantic-authority",
      "resume-read-semantic-authority",
      "authority-connect-and-prebind",
      "kicad-set-project",
      "provider-turn",
    ]);
    expect(providerUserText).toBe(fixture.bundle.executionPrompt.text);
    expect(providerUserText).not.toContain("[truncated]");
    expect(providerToolNames).toEqual(expect.arrayContaining([
      "fresh_get_contract_pad_positions", "fresh_get_route_items", "fresh_replace_route_items", "fresh_sync_from_schematic",
    ]));
    expect(providerToolNames).not.toContain("pcb_sync_from_schematic");
    expect(execution.report.harness?.prompt).toBe(fixture.bundle.executionPrompt.text);
    expect(execution.report.harness?.providerPromptContentIdentity).toStrictEqual(fixture.bundle.executionPrompt.textContentIdentity);
    const operation = execution.report.harness?.operations.find((entry) => entry.name === "fresh_apply_contract_connectivity");
    expect(operation).toBeDefined();
    expect(operation!.result.content).toContain('"contractIdentity"');
    expect(JSON.parse(operation!.result.content)).toMatchObject({ contractIdentity: createFreshConnectivityContract(fixture.bundle.contract).identity });
    expect(execution.report.freshAcceptance).toMatchObject({ contractIdentity: fixture.bundle.contract.identity, passed: false });
    expect("workflow" in execution.report && JSON.stringify(execution.report.workflow)).not.toContain("fresh-led-indicator");
  });

  it("fails prepare-time materialization or semantic readback before checkpoint, sidecar, or provider", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    let sessionLaunches = 0;
    let providerLaunches = 0;
    const externalWork = {
      environment: { OPENAI_API_KEY: "test" },
      fetch: async () => { providerLaunches += 1; throw new Error("must not call provider"); },
      sessionFactory: async () => { sessionLaunches += 1; throw new Error("must not connect sidecar"); },
    } as const;

    const materializationFailureOutput = path.join(root, "materialization-failure");
    await expect(runPcbAgentCli({
      ...genericOptions(materializationFailureOutput, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      ...externalWork,
      freshDesignClearanceEvidencePort: {
        ...freshNetClassPort(),
        materialize: async () => { throw new Error("sk-materializer-secret C:/private/provider.txt"); },
      },
    })).rejects.toThrow("materialization and semantic readback did not complete");
    await expect(readFile(path.join(materializationFailureOutput, "pcb-agent-report.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(materializationFailureOutput, ".evleda-pcb-agent-checkpoint.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const semanticFailureOutput = path.join(root, "semantic-failure");
    await expect(runPcbAgentCli({
      ...genericOptions(semanticFailureOutput, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      ...externalWork,
      freshDesignClearanceEvidencePort: {
        ...freshNetClassPort(),
        readSemanticAuthority: async () => { throw new Error("sk-semantic-secret C:/private/semantic.txt"); },
        read: async () => { throw new Error("must not read"); },
      },
    })).rejects.toThrow("materialization and semantic readback did not complete");
    await expect(readFile(path.join(semanticFailureOutput, "pcb-agent-report.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(semanticFailureOutput, ".evleda-pcb-agent-checkpoint.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const missingPortOutput = path.join(root, "missing-port-output");
    await expect(runPcbAgentCli({
      ...genericOptions(missingPortOutput, "prepare"), compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      ...externalWork,
    })).rejects.toThrow("server-owned net-class evidence port");
    expect(sessionLaunches).toBe(0);
    expect(providerLaunches).toBe(0);
  });

  it("replays generic resume by semantic verification only and rejects drift before connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const expected = prepared.report.freshNetClassPreparationEvidence;
    const expectedPreparedSources = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (expected === undefined || expectedPreparedSources === undefined) throw new Error("Expected prepare authorities.");
    const settingsPath = path.join(output, "project", "divider.kicad_pro");
    const preparedSettings = await readFile(settingsPath, "utf8");
    let semanticReads = 0;
    let resumeMaterializations = 0;
    const verificationOnlyPort: FreshNetClassPort = {
      ...freshNetClassPort(),
      materialize: async () => {
        resumeMaterializations += 1;
        throw new Error("resume must not materialize");
      },
      readSemanticAuthority: async ({ project, bundle }) => {
        semanticReads += 1;
        return await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY });
      },
    };
    await expect(runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: verificationOnlyPort,
    })).rejects.toThrow("lifecycle-owned expected net-class preparation evidence");
    expect(semanticReads).toBe(0);
    expect(resumeMaterializations).toBe(0);
    await expect(runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      expectedFreshNetClassPreparationEvidence: expected,
      freshDesignClearanceEvidencePort: verificationOnlyPort,
    })).rejects.toThrow("lifecycle-owned expected prepared-source authority");
    expect(semanticReads).toBe(0);
    expect(resumeMaterializations).toBe(0);
    for (let replay = 0; replay < 2; replay += 1) {
      const result = await runPcbAgentCli({
        ...genericOptions(output, "resume"),
        compilationBundle: fixture.bundle,
        compilationBundleRef: fixture.reference,
      }, {
        compilationBundleDependencies: fixture.dependencies,
        expectedFreshNetClassPreparationEvidence: expected,
        expectedFreshProjectOpenPreparedSourceAuthority: expectedPreparedSources,
        freshDesignClearanceEvidencePort: verificationOnlyPort,
      });
      expect(result.report).toMatchObject({
        status: "failed",
        freshNetClassPreparationEvidence: expected,
      });
      expect(result.report.summary).toContain("session factory");
      expect(result.report.freshNetClassMaterialization?.changed).toBe(true);
      expect(await readFile(settingsPath, "utf8")).toBe(preparedSettings);
    }
    expect(resumeMaterializations).toBe(0);
    expect(semanticReads).toBe(2);

    let sessionLaunches = 0;
    let providerLaunches = 0;
    const driftPort: FreshNetClassPort = {
      ...freshNetClassPort(),
      materialize: async () => {
        resumeMaterializations += 1;
        throw new Error("resume must not materialize");
      },
      readSemanticAuthority: async ({ project, bundle }) => {
        const authority = await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: KICAD_IDENTITY });
        return { ...authority, boardMinimumClearanceMm: authority.boardMinimumClearanceMm + 0.01 };
      },
    };
    await expect(runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      expectedFreshNetClassPreparationEvidence: expected,
      expectedFreshProjectOpenPreparedSourceAuthority: expectedPreparedSources,
      freshDesignClearanceEvidencePort: driftPort,
      environment: { OPENAI_API_KEY: "test" },
      fetch: async () => { providerLaunches += 1; throw new Error("provider must not run"); },
      sessionFactory: async () => { sessionLaunches += 1; throw new Error("sidecar must not connect"); },
    })).rejects.toThrow("semantic authority changed after prepare");
    expect(resumeMaterializations).toBe(0);
    expect(sessionLaunches).toBe(0);
    expect(providerLaunches).toBe(0);
  });

  it("rejects reminted local report and checkpoint authority after schematic drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const preparationEvidence = prepared.report.freshNetClassPreparationEvidence;
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (preparationEvidence === undefined || preparedSourceAuthority === undefined) throw new Error("Expected prepare authorities.");

    const schematicPath = path.join(output, "project", "divider.kicad_sch");
    const schematicBytes = Buffer.concat([await readFile(schematicPath), Buffer.from(" ", "utf8")]);
    await writeFile(schematicPath, schematicBytes);
    const { identity: _preparedSourceIdentity, ...preparedSourcePayload } = structuredClone(preparedSourceAuthority);
    const remintedSourcePayload = { ...preparedSourcePayload, sch: contentIdentity(schematicBytes) };
    const remintedSourceAuthority = {
      ...remintedSourcePayload,
      identity: canonicalIdentity(remintedSourcePayload, remintedSourcePayload.schemaVersion),
    };
    const reportPath = path.join(output, "pcb-agent-report.json");
    const localReport = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    localReport.freshProjectOpenPreparedSourceAuthority = remintedSourceAuthority;
    const reportBytes = Buffer.from(`${JSON.stringify(localReport, null, 2)}\n`, "utf8");
    await writeFile(reportPath, reportBytes);
    const checkpointPath = path.join(output, ".evleda-pcb-agent-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      files: { sch: { sha256: string } };
      reportSha256: string;
    };
    checkpoint.files.sch.sha256 = contentIdentity(schematicBytes).digest;
    checkpoint.reportSha256 = contentIdentity(reportBytes).digest;
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

    let materializations = 0;
    let semanticReads = 0;
    let sessionConnections = 0;
    let providerTurns = 0;
    await expect(runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      expectedFreshNetClassPreparationEvidence: preparationEvidence,
      expectedFreshProjectOpenPreparedSourceAuthority: preparedSourceAuthority,
      freshDesignClearanceEvidencePort: {
        ...freshNetClassPort(),
        materialize: async () => { materializations += 1; throw new Error("resume must not materialize"); },
        readSemanticAuthority: async () => { semanticReads += 1; throw new Error("semantic read must follow authority checks"); },
      },
      environment: { OPENAI_API_KEY: "test" },
      fetch: async () => { providerTurns += 1; throw new Error("provider must not run"); },
      sessionFactory: async () => { sessionConnections += 1; throw new Error("sidecar must not connect"); },
    })).rejects.toThrow("prepared-source authority does not match the persisted prepare report");
    expect({ materializations, semanticReads, sessionConnections, providerTurns }).toEqual({
      materializations: 0,
      semanticReads: 0,
      sessionConnections: 0,
      providerTurns: 0,
    });
  });

  it("requires a host-owned KiCad CLI adapter factory before production-authorized work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const preparationEvidence = prepared.report.freshNetClassPreparationEvidence;
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (preparationEvidence === undefined || preparedSourceAuthority === undefined) throw new Error("Expected prepare authorities.");
    const sessionAuthorityIdentity = canonicalIdentity({ run: "factory-required" }, "evleda.test-session-authority.v1");
    const directCreate = vi.spyOn(KicadCliAdapter, "create").mockRejectedValue(new Error("unpinned direct constructor invoked"));
    let sessionConnections = 0;
    let providerTurns = 0;

    await expect(runPcbAgentCli({
      ...genericOptions(output, "resume"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      expectedFreshNetClassPreparationEvidence: preparationEvidence,
      expectedFreshProjectOpenPreparedSourceAuthority: preparedSourceAuthority,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
      sessionAuthorityIdentity,
      sessionFactory: async () => { sessionConnections += 1; throw new Error("session must not connect"); },
      environment: { OPENAI_API_KEY: "test" },
      fetch: async () => { providerTurns += 1; throw new Error("provider must not run"); },
    })).rejects.toThrow("requires a host-owned pinned KiCad CLI adapter factory");
    expect(directCreate).not.toHaveBeenCalled();
    expect(sessionConnections).toBe(0);
    expect(providerTurns).toBe(0);
  });

  it("routes replaced-executable fallback through only the injected production adapter factory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const physicalDependencies = await preflightPhysicalDependencies(fixture);
    const output = path.join(root, "output");
    const prepared = await runPcbAgentCli({
      ...genericOptions(output, "prepare"),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });
    const preparationEvidence = prepared.report.freshNetClassPreparationEvidence;
    const preparedSourceAuthority = prepared.report.freshProjectOpenPreparedSourceAuthority;
    if (preparationEvidence === undefined || preparedSourceAuthority === undefined) throw new Error("Expected prepare authorities.");
    const replacedExecutable = path.join(root, "replaced-kicad-cli.exe");
    await writeFile(replacedExecutable, "approved bytes", "utf8");
    await writeFile(replacedExecutable, "replacement bytes", "utf8");
    const sessionAuthorityIdentity = canonicalIdentity({ run: "factory-injected" }, "evleda.test-session-authority.v1");
    const sessionReceiptIdentity = canonicalIdentity({ run: "factory-injected" }, "evleda.test-session-receipt.v1");
    const directCreate = vi.spyOn(KicadCliAdapter, "create").mockRejectedValue(new Error("unpinned direct constructor invoked"));
    const injectedOptions: Parameters<typeof KicadCliAdapter.create>[0][] = [];
    const boardText = clearanceBoardSource(fixture.bundle.contract.nets.map((net) => net.name));
    let providerTurns = 0;
    let providerStarted = false;

    const execution = await runPcbAgentCli({
      ...genericOptions(output, "resume"),
      kicadCliPath: replacedExecutable,
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, {
      compilationBundleDependencies: physicalDependencies,
      expectedFreshNetClassPreparationEvidence: preparationEvidence,
      expectedFreshProjectOpenPreparedSourceAuthority: preparedSourceAuthority,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
      sessionAuthorityIdentity,
      createKicadCliAdapter: async (adapterOptions) => {
        injectedOptions.push(adapterOptions);
        throw new Error("pinned host factory rejected replaced executable");
      },
      environment: { OPENAI_API_KEY: "test" },
      fetch: async () => {
        providerTurns += 1;
        providerStarted = true;
        return new Response(JSON.stringify({
          id: "resp-pinned-adapter", status: "completed", error: null, incomplete_details: null,
          output: [{ id: "fc-pinned-adapter", type: "function_call", status: "completed", call_id: "pinned-adapter", name: "pcb_add_track", arguments: "{}" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      sessionFactory: async (sessionOptions) => ({
        readLivePcbPadSnapshot: async () => { throw new Error("Replaced executable must fail before physical acceptance."); },
        assertActivePcb: async (expected) => { expect(expected).toBe(path.join(sessionOptions.projectRoot, "divider.kicad_pcb")); },
        readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
        identity: { launch: { sessionAuthorityIdentity }, sessionReceiptIdentity },
        listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
          .filter((name) => name !== "evleda_get_live_pcb_document" && (!providerStarted || name !== "run_erc"))
          .map((name) => ({ name, permission: "write" as const, description: name, inputSchema: { type: "object" } })),
        callTool: async (name) => {
          const pcbPath = path.join(sessionOptions.projectRoot, "divider.kicad_pcb");
          if (name === "pcb_add_track") await writeFile(pcbPath, boardText, "utf8");
          if (name === "pcb_save") await writeFile(pcbPath, `${await readFile(pcbPath, "utf8")}\n`, "utf8");
          return {
            content: [],
            structuredContent: name === "kicad_get_project_info"
              ? { active_pcb_path: pcbPath }
              : name === "pcb_get_board_as_string"
                ? { result: await readFile(pcbPath, "utf8") }
              : {
                  result: name === "sch_get_symbols" ? ""
                    : name === "sch_get_connectivity_graph" ? "The active schematic has no connectivity to summarize."
                      : "ok",
                },
          };
        },
      }),
    });
    expect(execution.report.status).not.toBe("completed");
    expect(injectedOptions.length).toBeGreaterThan(0);
    expect(injectedOptions.every((options) => options.executablePath === replacedExecutable)).toBe(true);
    expect(directCreate).not.toHaveBeenCalled();
    expect(providerTurns).toBeGreaterThan(0);
  });

  it("rejects wrong references, reference tampering, source drift, and legacy V1 upgrade", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const output = path.join(root, "output");
    await expect(runPcbAgentCli({
      ...genericOptions(path.join(root, "ambiguous")),
      prompt: "append this contract" as never,
    }, { compilationBundleDependencies: fixture.dependencies })).rejects.toThrow(/prompt fields are forbidden/iu);
    await runPcbAgentCli({ ...genericOptions(output), compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference }, {
      compilationBundleDependencies: fixture.dependencies,
      freshDesignClearanceEvidencePort: freshNetClassPort(),
    });

    const wrong = createGenericDividerBundleFixture("Same contract, different exact prompt identity.");
    await expect(runPcbAgentCli({ ...genericOptions(output, "resume"), compilationBundle: fixture.bundle, compilationBundleRef: wrong.reference }, { compilationBundleDependencies: fixture.dependencies })).rejects.toThrow(/reference does not match/iu);
    const tampered = structuredClone(fixture.reference) as { contentIdentity: { digest: string } };
    tampered.contentIdentity.digest = "f".repeat(64);
    await expect(runPcbAgentCli({ ...genericOptions(output, "resume"), compilationBundle: fixture.bundle, compilationBundleRef: tampered as never }, { compilationBundleDependencies: fixture.dependencies })).rejects.toThrow(/reference|identity/iu);

    const rehydrated = parsePcbDesignCompilationBundle(serializePcbDesignCompilationBundle(fixture.bundle), fixture.dependencies);
    await expect(prepareFreshProject({
      outputDir: output, name: "divider", resume: true, workflowKind: "generic",
      compilationBundle: rehydrated, compilationBundleRef: fixture.reference,
    })).resolves.toMatchObject({ workflowKind: "generic" });
    const symbolTablePath = path.join(output, "project", "sym-lib-table");
    const symbolTable = await readFile(symbolTablePath, "utf8");
    await writeFile(symbolTablePath, `${symbolTable} `, "utf8");
    await expect(prepareFreshProject({
      outputDir: output, name: "divider", resume: true, workflowKind: "generic",
      compilationBundle: rehydrated, compilationBundleRef: fixture.reference,
    })).rejects.toThrow(/library tables differ|bytes differ/iu);
    await writeFile(symbolTablePath, symbolTable, "utf8");
    await writeFile(path.join(output, "project", "divider.kicad_sch"), "source drift", "utf8");
    await expect(prepareFreshProject({
      outputDir: output, name: "divider", resume: true, workflowKind: "generic",
      compilationBundle: rehydrated, compilationBundleRef: fixture.reference,
    })).rejects.toThrow(/bytes differ|hash verification|schematic/iu);

    const legacyOutput = path.join(root, "legacy");
    await prepareFreshProject({ outputDir: legacyOutput, name: "legacy", resume: false, workflowKind: "led_compatibility_fixture" });
    await expect(prepareFreshProject({
      outputDir: legacyOutput, name: "legacy", resume: true, workflowKind: "generic",
      compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference,
    })).rejects.toThrow(/V1.*cannot be upgraded in place/iu);
  });

  it.each(["components", "pins", "net-endpoints", "payload"])("retains the current contract %s admission limit", (limit) => {
    const draft = structuredClone(genericDividerDraft());
    if (limit === "components") {
      draft.components = Array.from({ length: 65 }, (_, index) => ({ ...draft.components[1]!, reference: `R${index + 1}` }));
    } else if (limit === "pins") {
      draft.components[1]!.pins = Array.from({ length: 129 }, (_, index) => ({ pin: String(index + 1), assignment: { kind: "no_connect" as const } }));
    } else if (limit === "net-endpoints") {
      draft.nets[0]!.endpoints = Array.from({ length: 257 }, (_, index) => ({ reference: `R${Math.floor(index / 128) + 1}`, pin: String(index % 128 + 1) }));
    } else {
      draft.components[0]!.value = "x".repeat(256 * 1024);
    }
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow();
  });

  it("prepares a resistor bank with 34 components and 69 unique logical pins beyond the old 8/64 placement envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const large = structuredClone(genericDividerDraft()) as ReturnType<typeof genericDividerDraft>;
    for (let index = 3; index <= 33; index += 1) {
      large.components.push({
        reference: `R${index}`,
        symbolLibId: "Device:R",
        value: "10k",
        footprintLibId: "Resistor_SMD:R_0603_1608Metric",
        unit: 1,
        pins: [
          { pin: "1", assignment: { kind: "net", net: "VIN" } },
          { pin: "2", assignment: { kind: "net", net: "GND" } },
        ],
      });
      large.nets.find((net) => net.name === "VIN")!.endpoints.push({ reference: `R${index}`, pin: "1" });
      large.nets.find((net) => net.name === "GND")!.endpoints.push({ reference: `R${index}`, pin: "2" });
      large.placementConstraints.push({
        reference: `R${index}`,
        side: "front",
        regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
        allowedRotationsDeg: [0, 90, 180, 270],
        minimumEdgeClearanceMm: 1,
        minimumCourtyardClearanceMm: 0.25,
        edgePreference: "none",
      });
    }
    for (const net of large.routingConstraints.nets) net.topology = "tree";
    const fixture = createGenericBundleFixture(large, "Prepare a divider with a parallel resistor load bank.");
    expect(fixture.bundle.contract.components).toHaveLength(34);
    expect(new Set(large.nets.flatMap((net) => net.endpoints.map((endpoint) => `${endpoint.reference}:${endpoint.pin}`))).size).toBe(69);
    const output = path.join(root, "resistor-bank");
    const execution = await runPcbAgentCli({
      ...genericOptions(output),
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    }, { compilationBundleDependencies: fixture.dependencies, freshDesignClearanceEvidencePort: freshNetClassPort() });
    expect(canonicalJson(execution.report.freshNetClassPreparationEvidence?.contractIdentity)).toBe(canonicalJson(fixture.bundle.contract.identity));
    expect(execution.report.freshAcceptance?.passed).toBe(false);
    expect(execution.report.freshProjectOpenPreparedSourceAuthority).toBeDefined();
  });

  it("independently rejects a port-forged clearance receipt instead of trusting its PASS projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const { execution, portReadCalls } = await runClearanceReceiptScenario(root, "forged");
    expect(portReadCalls).toBeGreaterThan(0);
    expect(execution.report.status).toBe("failed");
    expect(execution.report.freshClearanceEvidenceReceipt).toBeUndefined();
    expect(execution.report.freshClearanceEvidenceProblem).toMatch(/receipt|schema|invalid/iu);
    expect(execution.report.freshAcceptance?.requirements.find((row) => row.id === "netclass:POWER:clearance")?.status).toBe("unknown");
  });

  it("discards a verified receipt and stale acceptance projection when sources drift afterward", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-generic-cli-")); owned.add(root);
    const { execution, portReadCalls } = await runClearanceReceiptScenario(root, "drift-after-verify");
    expect(portReadCalls).toBeGreaterThan(0);
    expect(execution.report.status).toBe("failed");
    expect(execution.report.freshClearanceEvidenceReceipt).toBeUndefined();
    expect(execution.report.freshClearanceEvidenceProblem).toContain("receipt and acceptance projection were discarded");
    expect(execution.report.freshAcceptance?.requirements.find((row) => row.id === "netclass:POWER:clearance")?.status).toBe("unknown");
    const currentPcb = await readFile(path.join(root, "drift-after-verify", "project", "divider.kicad_pcb"));
    expect(execution.report.freshAcceptance?.sourceHashes.pcbSha256).toBe(contentIdentity(currentPcb).digest);
  });
});
