import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createKicadHarnessTools,
  captureFreshProjectOpenPreparedSourceAuthority,
  createFreshConnectivityContract,
  assertSingleFreshBoardOutline,
  checkpointFreshProjectOpenNormalization,
  FRESH_INCREMENTAL_INPUT_SCHEMAS,
  FRESH_LED_INDICATOR_PROVIDER_CONTRACT,
  FRESH_PROJECT_PROMPT_CONTEXT,
  FreshSchematicRollback,
  LED_INDICATOR_EXAMPLE,
  KICAD_HARNESS_TOOL_NAMES,
  KICAD_FRESH_HARNESS_TOOL_NAMES,
  KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  parseFreshIncrementalArguments,
  parseFreshBoundingBoxes,
  parseFreshPlacements,
  freshPersistedNoConnectsMatch,
  freshEndpointEscape,
  freshAbsolutePinAngle,
  freshSameNetWire,
  FRESH_CONNECTIVITY_PLACEMENT_SEARCH,
  FRESH_PROVIDER_RESULT_MAX_CHARS,
  inspectFreshConnectivityWirePlan,
  searchFreshConnectivityPlacement,
  serializeFreshContractConnectivityResult,
  prepareFreshProject,
  projectKicadHarnessToolDefinitions,
  type FreshProjectManagedNetClass,
  type FreshProjectNetClassSemanticProjection,
  type KicadHarnessSession,
} from "../../src/harness/index.js";
import { parseFreshEmbeddedPinAngles } from "../../src/harness/fresh-kicad-parser.js";
import { createExactContractNetClassPatterns } from "../../src/harness/fresh-netclass-assignment.js";
import { parsePcbAgentCliArgs, runPcbAgentCli } from "../../src/cli/pcb-agent.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { normalizeFakeSchematicWriterSource } from "../helpers/normalizing-schematic-writer.js";

const owned = new Set<string>();
afterEach(async () => { await Promise.all([...owned].map(async (directory) => { await rm(directory, { recursive: true, force: true }); owned.delete(directory); })); });

const insertBoardForm = (source: string, form: string): string => {
  const changed = source.replace(/^\(kicad_pcb(\r?\n)/u, (_match, newline: string) => `(kicad_pcb${newline}\t${form}${newline}`);
  expect(changed).not.toBe(source);
  expect(changed).toContain(form);
  return changed;
};

const fakePrivatePorts = {
  assertActivePcb: async (_expected: string): Promise<void> => undefined,
  readActivePcbSource: async (expected: string): Promise<string> => await readFile(expected, "utf8"),
};

const session = (names: readonly string[] = KICAD_FRESH_HARNESS_TOOL_NAMES): KicadHarnessSession => ({
  ...fakePrivatePorts,
  listTools: () => names.map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object", additionalProperties: true } })),
  callTool: async (name, argumentsValue = {}) => ({ content: [], structuredContent: { name, argumentsValue } }),
});
const boxReadback = (rows: string): string => {
  const count = rows.split("\n").filter((line) => line.trim().length > 0).length;
  return `Schematic bounding boxes (${count} symbols):\nRef Value X Y X_min Y_min X_max Y_max\n----------------------------------------------------------------------------\n${rows}\n\nSheet occupied region: X=[0.0, 50.0] Y=[0.0, 50.0] mm`;
};
const appendSchematicForm = async (filePath: string, form: string): Promise<void> => {
  const source = await readFile(filePath, "utf8");
  const closing = source.lastIndexOf(")");
  if (closing < 0) throw new Error("test schematic has no root close");
  await writeFile(filePath, normalizeFakeSchematicWriterSource(`${source.slice(0, closing)}\n  ${form}\n${source.slice(closing)}`), "utf8");
};
const nativeComponent = (reference: string, value: string, footprint: string, library: string, part: string): string =>
  `(comp (ref "${reference}") (value "${value}") (footprint "${footprint}") (libsource (lib "${library}") (part "${part}")))`;
const nativeNode = (reference: string, pin: string, pinType = "passive"): string =>
  `(node (ref "${reference}") (pin "${pin}") (pintype "${pinType}"))`;
const planarPinReadback = (symbolName: unknown, collision = false): string => {
  if (symbolName === "Conn_01x02") return "- Pin 1: (10, 10) mm\n- Pin 2: (10, 30) mm";
  if (symbolName === "R") return "- Pin 1: (20, 10) mm\n- Pin 2: (20, 20) mm";
  if (symbolName === "LED") return "- Pin 1: (30, 30) mm\n- Pin 2: (30, 20) mm";
  return collision ? "- Pin 1: (20, 20) mm\n- Pin 2: (40, 30) mm" : "- Pin 1: (40, 10) mm\n- Pin 2: (40, 30) mm";
};
const planarBoxes = boxReadback("J1 Conn 10 20 9 10 11 30\nR1 1k 20 15 19 10 21 20\nD1 LED 30 25 29 20 31 30\nC1 100n 40 20 39 10 41 30");
const planarSymbols = "- J1 Conn Connector_Generic:Conn_01x02 @ (10, 20) rot=0 unit=1\n- R1 1k Device:R @ (20, 15) rot=0 unit=1\n- D1 LED Device:LED @ (30, 25) rot=0 unit=1\n- C1 100n Device:C @ (40, 20) rot=0 unit=1";
const lockedSidecarSymbolReadback = "Symbols (4 total):\n- J1 Conn_01x02 Connector_Generic:Conn_01x02 @ (30.48, 50.80) rot=0 unit=1 footprint=Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical\n- R1 1k Device:R @ (45.72, 45.72) rot=0 unit=1 footprint=Resistor_SMD:R_0603_1608Metric\n- D1 LED Device:LED @ (60.96, 45.72) rot=0 unit=1 footprint=LED_SMD:LED_0603_1608Metric\n- C1 100nF Device:C @ (45.72, 55.88) rot=0 unit=1 footprint=Capacitor_SMD:C_0603_1608Metric";
const ledNativeNetlist = `(export (components
  ${nativeComponent("C1", "100nF", "Capacitor_SMD:C_0603_1608Metric", "Device", "C")}
  ${nativeComponent("D1", "LED", "LED_SMD:LED_0603_1608Metric", "Device", "LED")}
  ${nativeComponent("J1", "Conn_01x02", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "Connector_Generic", "Conn_01x02")}
  ${nativeComponent("R1", "1k", "Resistor_SMD:R_0603_1608Metric", "Device", "R")}) (nets
  (net (code "1") (name "+5V") ${nativeNode("C1", "1")} ${nativeNode("J1", "1")} ${nativeNode("R1", "1")})
  (net (code "2") (name "GND") ${nativeNode("C1", "2")} ${nativeNode("D1", "1")} ${nativeNode("J1", "2")})
  (net (code "3") (name "LED_A") ${nativeNode("D1", "2")} ${nativeNode("R1", "2")})))`;
const pristineLedGraph = "Group 1: ~unnamed | pins=J1:1\nGroup 2: ~unnamed | pins=J1:2\nGroup 3: ~unnamed | pins=R1:1\nGroup 4: ~unnamed | pins=R1:2\nGroup 5: ~unnamed | pins=D1:1\nGroup 6: ~unnamed | pins=D1:2\nGroup 7: ~unnamed | pins=C1:1\nGroup 8: ~unnamed | pins=C1:2";
const exactLedGraph = "Group 1: +5V | pins=C1:1, J1:1, R1:1\nGroup 2: GND | pins=C1:2, D1:1, J1:2\nGroup 3: LED_A | pins=D1:2, R1:2";
const embeddedLedSchematic = (): string => `(kicad_sch (version 20250316) (lib_symbols
  (symbol "Connector_Generic:Conn_01x02" (symbol "Conn_01x02_1_1"
    (pin passive line (at -5.08 0 0) (number "1")) (pin passive line (at -5.08 -2.54 0) (number "2"))))
  (symbol "Device:R" (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (number "1")) (pin passive line (at 0 -3.81 90) (number "2"))))
  (symbol "Device:LED" (symbol "LED_1_1"
    (pin passive line (at -3.81 0 0) (number "1")) (pin passive line (at 3.81 0 180) (number "2"))))
  (symbol "Device:C" (symbol "C_1_1"
    (pin passive line (at 0 3.81 270) (number "1")) (pin passive line (at 0 -3.81 90) (number "2")))))
)\n`;

describe("fresh KiCad project authoring", () => {
  const normalizedProject = (name: string, trackWidth = 0.2) => JSON.stringify({
    board: { file: `${name}.kicad_pcb`, layer_pairs: [], layer_presets: [], viewports: [], design_settings: { diff_pair_dimensions: [], drc_exclusions: [], track_widths: [], via_dimensions: [], rules: { max_error: 0.005, min_clearance: 0.0, min_connection: 0.0, min_copper_edge_clearance: 0.5, min_groove_width: 0.0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_microvia_diameter: 0.2, min_microvia_drill: 0.1, min_resolved_spokes: 2, min_silk_clearance: 0.0, min_text_height: 0.8, min_text_thickness: 0.08, min_through_hole_diameter: 0.3, min_track_width: 0.2, min_via_annular_width: 0.1, min_via_diameter: 0.5, solder_mask_to_copper_clearance: 0.0, use_height_for_length_calcs: true } } },
    boards: [], component_class_settings: { assignments: [], sheet_component_classes: { enabled: false } }, cvpcb: { equivalence_files: [] }, libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
    meta: { filename: `${name}.kicad_pro`, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project", version: 3 },
    net_settings: { classes: [{ bus_width: 12, clearance: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2, line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1, name: "Default", pcb_color: "rgba(0, 0, 0, 0.000)", priority: 2147483647, schematic_color: "rgba(0, 0, 0, 0.000)", track_width: trackWidth, tuning_profile: "", via_diameter: 0.6, via_drill: 0.3, wire_width: 6 }], netclass_assignments: null, netclass_patterns: [], net_colors: null },
    pcbnew: { last_paths: { idf: "", netlist: "", plot: "", specctra_dsn: "", vrml: "" }, page_layout_descr_file: "" },
    schematic: { bus_aliases: {}, file: `${name}.kicad_sch`, legacy_lib_dir: "", legacy_lib_list: [], top_level_sheets: [{ filename: `${name}.kicad_sch`, name, uuid: "00000000-0000-0000-0000-000000000000" }] }, sheets: [], text_variables: {}, tuning_profiles: {},
  }, null, 2);

  const managedNetClass = (name: string, trackWidth: number, clearance: number): FreshProjectManagedNetClass => ({
    bus_width: 12,
    clearance,
    diff_pair_gap: 0.25,
    diff_pair_via_gap: 0.25,
    diff_pair_width: trackWidth,
    line_style: 0,
    microvia_diameter: 0.3,
    microvia_drill: 0.1,
    name,
    pcb_color: "rgba(0, 0, 0, 0.000)",
    priority: -1,
    schematic_color: "rgba(0, 0, 0, 0.000)",
    track_width: trackWidth,
    tuning_profile: "",
    via_diameter: 0.6,
    via_drill: 0.3,
    wire_width: 6,
  });
  const defaultNetClass = (): FreshProjectManagedNetClass => ({
    ...managedNetClass("EVLEDA_000000000000_C01", 0.2, 0.2),
    name: "Default",
    priority: 2_147_483_647,
  });
  const genericProjection = (): FreshProjectNetClassSemanticProjection => ({
    netClasses: [
      managedNetClass("EVLEDA_123456789abc_C01", 0.5, 0.25),
      managedNetClass("EVLEDA_123456789abc_C02", 0.25, 0.2),
    ],
    contractNetAssignments: [
      { netName: "GND", contractNetClassId: "POWER", kicadNetClassName: "EVLEDA_123456789abc_C01" },
      { netName: "VIN", contractNetClassId: "POWER", kicadNetClassName: "EVLEDA_123456789abc_C01" },
      { netName: "VOUT", contractNetClassId: "SENSE", kicadNetClassName: "EVLEDA_123456789abc_C02" },
    ],
  });
  const normalizedGenericProject = (name: string, projection: FreshProjectNetClassSemanticProjection): string => {
    const value = JSON.parse(normalizedProject(name)) as { net_settings: Record<string, unknown> };
    value.net_settings = {
      // Deliberately reverse the caller projection and assignment order.  KiCad
      // JSON formatting/order is not semantic authority.
      classes: [...projection.netClasses].reverse().concat(defaultNetClass()),
      meta: { version: 5 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: [...createExactContractNetClassPatterns(projection.contractNetAssignments)].reverse(),
    };
    return JSON.stringify(value);
  };

  it("accepts only the audited .pro open normalization, rejects drift, and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    const fresh = await prepareFreshProject({ outputDir: output, name: "open", resume: false });
    await writeFile(path.join(output, "pcb-agent-report.json"), JSON.stringify({ status: "blocked" }));
    await writeFile(path.join(fresh.projectPath, "open.kicad_pro"), normalizedProject("open"));
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name: "open" })).resolves.toMatchObject({ changed: true });
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name: "open" })).resolves.toMatchObject({ changed: false });

    const customOutput = path.join(root, "custom");
    const custom = await prepareFreshProject({ outputDir: customOutput, name: "custom", resume: false });
    await writeFile(path.join(customOutput, "pcb-agent-report.json"), JSON.stringify({ status: "blocked" }));
    await writeFile(path.join(custom.projectPath, "custom.kicad_pro"), normalizedProject("custom", 0.5));
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: customOutput, name: "custom" })).rejects.toThrow(/default net class/i);

    const driftOutput = path.join(root, "drift");
    const drift = await prepareFreshProject({ outputDir: driftOutput, name: "drift", resume: false });
    await writeFile(path.join(driftOutput, "pcb-agent-report.json"), JSON.stringify({ status: "blocked" }));
    await writeFile(path.join(drift.projectPath, "drift.kicad_pro"), normalizedProject("drift"));
    await writeFile(drift.schematicPath, "manual schematic change");
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: driftOutput, name: "drift" })).rejects.toThrow(/sch differs/i);
  });

  it("accepts generic Open formatting/order and empty-cache normalization with exact escaped case-distinct net semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-generic-open-")); owned.add(root);
    const output = path.join(root, "output");
    const name = "generic-open";
    const fixture = createGenericDividerBundleFixture();
    const fresh = await prepareFreshProject({
      outputDir: output,
      name,
      resume: false,
      workflowKind: "generic",
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    });
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked" }));
    const baseProjection = genericProjection();
    const projection: FreshProjectNetClassSemanticProjection = {
      ...baseProjection,
      contractNetAssignments: baseProjection.contractNetAssignments.map((entry) => ({
        ...entry, netName: entry.netName === "VIN" ? "PWR+3.3" : entry.netName === "VOUT" ? "pwr+3.3" : entry.netName,
      })),
    };
    const projectPath = path.join(fresh.projectPath, `${name}.kicad_pro`);
    const sparse = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    sparse.board = { file: `${name}.kicad_pcb`, design_settings: { rules: { min_clearance: 0 } } };
    sparse.net_settings = {
      classes: [defaultNetClass(), ...projection.netClasses],
      meta: { version: 5 }, net_colors: null,
      netclass_assignments: {},
      netclass_patterns: createExactContractNetClassPatterns(projection.contractNetAssignments),
    };
    await writeFile(projectPath, JSON.stringify(sparse, null, 2));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    const preparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(fresh);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection })).rejects.toThrow(/lifecycle-owned prepared-source authority/i);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/expected net-class semantic projection/i);
    const tamperedAuthority = { ...preparedSourceAuthority, sch: { ...preparedSourceAuthority.sch, digest: "0".repeat(64) } };
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: tamperedAuthority })).rejects.toThrow(/authority identity is invalid/i);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: false });

    await writeFile(projectPath, normalizedGenericProject(name, projection));
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection })).rejects.toThrow(/lifecycle-owned prepared-source authority/i);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: {
      netClasses: [...projection.netClasses].reverse(),
      contractNetAssignments: [...projection.contractNetAssignments].reverse(),
    }, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: true });
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: false });
  });

  it("refuses to mint prepared-source authority after schematic, PCB, or library-table drift from the immutable marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-authority-drift-")); owned.add(root);
    const fixture = createGenericDividerBundleFixture();
    const fresh = await prepareFreshProject({
      outputDir: path.join(root, "output"), name: "authority-drift", resume: false, workflowKind: "generic",
      compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference,
    });
    const targets = [
      { label: "sch", path: fresh.schematicPath },
      { label: "pcb", path: fresh.pcbPath },
      { label: "symLibTable", path: path.join(fresh.projectPath, "sym-lib-table") },
      { label: "fpLibTable", path: path.join(fresh.projectPath, "fp-lib-table") },
    ] as const;
    for (const target of targets) {
      const baseline = await readFile(target.path);
      await writeFile(target.path, Buffer.concat([baseline, Buffer.from("\n")]));
      await expect(captureFreshProjectOpenPreparedSourceAuthority(fresh)).rejects.toThrow(new RegExp(`${target.label} differs from its immutable marker baseline|library tables differ`, "i"));
      await writeFile(target.path, baseline);
    }
    await expect(captureFreshProjectOpenPreparedSourceAuthority(fresh)).resolves.toMatchObject({ schemaVersion: "evleda.fresh-project-open-prepared-source-authority.v1" });
  });

  it("rejects generic managed-class, derived-cache, authored-pattern, non-net, custom-rule, zone, and local-override drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-generic-drift-")); owned.add(root);
    const output = path.join(root, "output");
    const name = "generic-drift";
    const fixture = createGenericDividerBundleFixture();
    const fresh = await prepareFreshProject({
      outputDir: output,
      name,
      resume: false,
      workflowKind: "generic",
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    });
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked" }));
    const projection = genericProjection();
    const projectPath = path.join(fresh.projectPath, `${name}.kicad_pro`);
    const sparse = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    sparse.board = { file: `${name}.kicad_pcb`, design_settings: { rules: { min_clearance: 0 } } };
    sparse.net_settings = {
      classes: [defaultNetClass(), ...projection.netClasses], meta: { version: 5 }, net_colors: null,
      netclass_assignments: {}, netclass_patterns: createExactContractNetClassPatterns(projection.contractNetAssignments),
    };
    await writeFile(projectPath, JSON.stringify(sparse, null, 2));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    const preparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(fresh);
    const acceptedText = normalizedGenericProject(name, projection);

    const rejectProjectMutation = async (pattern: RegExp, mutate: (candidate: Record<string, any>) => void) => {
      const candidate = JSON.parse(acceptedText) as Record<string, any>;
      mutate(candidate);
      await writeFile(projectPath, JSON.stringify(candidate, null, 4));
      await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(pattern);
    };
    await rejectProjectMutation(/managed net-class|expected managed/i, (candidate) => { candidate.net_settings.classes[0].clearance = 0.9; });
    await rejectProjectMutation(/expected managed|unknown/i, (candidate) => { candidate.net_settings.classes.push(managedNetClass("EVLEDA_ffffffffffff_C09", 0.25, 0.2)); });
    await rejectProjectMutation(/non-managed custom/i, (candidate) => { candidate.net_settings.classes[0].name = "OperatorClass"; });
    await rejectProjectMutation(/derived net-class label assignments/i, (candidate) => { candidate.net_settings.netclass_assignments = { VOUT: ["EVLEDA_123456789abc_C01"] }; });
    await rejectProjectMutation(/derived net-class label assignments/i, (candidate) => { candidate.net_settings.netclass_assignments = { EXTRA: ["EVLEDA_123456789abc_C01"] }; });
    await rejectProjectMutation(/netclass patterns/i, (candidate) => { candidate.net_settings.netclass_patterns = [{ pattern: "*", netclass: "EVLEDA_123456789abc_C01" }]; });
    for (const mutate of [
      (patterns: Record<string, unknown>[]) => patterns.slice(1),
      (patterns: Record<string, unknown>[]) => [...patterns, patterns[0]],
      (patterns: Record<string, unknown>[]) => patterns.map((entry, index) => index === 0 ? { ...entry, netclass: "EVLEDA_123456789abc_C01" } : entry),
      (patterns: Record<string, unknown>[]) => patterns.map((entry, index) => index === 0 ? { ...entry, pattern: "^vout$" } : entry),
      (patterns: Record<string, unknown>[]) => patterns.map((entry, index) => index === 0 ? { ...entry, pattern: "VOUT" } : entry),
      (patterns: Record<string, unknown>[]) => patterns.map((entry, index) => index === 0 ? { ...entry, pattern: "^VOUT.*$" } : entry),
      (patterns: Record<string, unknown>[]) => patterns.map((entry, index) => index === 0 ? { ...entry, unexpected: true } : entry),
    ]) {
      await rejectProjectMutation(/netclass patterns/i, (candidate) => {
        candidate.net_settings.netclass_patterns = mutate(candidate.net_settings.netclass_patterns);
      });
    }
    await rejectProjectMutation(/netclass patterns/i, (candidate) => {
      candidate.net_settings.netclass_patterns = [];
      candidate.net_settings.netclass_assignments = Object.fromEntries(projection.contractNetAssignments.map((entry) => [entry.netName, [entry.kicadNetClassName]]));
    });
    await rejectProjectMutation(/derived net-class label assignments/i, (candidate) => {
      candidate.net_settings.netclass_assignments = { VIN: ["EVLEDA_123456789abc_C01"] };
    });
    await rejectProjectMutation(/non-net-settings drift/i, (candidate) => { candidate.board.design_settings.rules.min_track_width = 0.4; });
    await rejectProjectMutation(/missing or unexpected fields/i, (candidate) => { candidate.net_settings.operator_override = true; });

    await writeFile(projectPath, acceptedText);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: true });
    await writeFile(path.join(fresh.projectPath, `${name}.kicad_dru`), "(version 1)\n(rule unsafe (constraint clearance (min 0.01mm)))\n");
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/custom rules/i);
    await writeFile(path.join(fresh.projectPath, `${name}.kicad_dru`), "(version 1)\n");
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: false });

    const boardBaseline = await readFile(fresh.pcbPath, "utf8");
    await writeFile(fresh.pcbPath, insertBoardForm(boardBaseline, '(zone (net 0) (net_name "") (layer "F.Cu"))'));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/lifecycle-owned prepared-source authority|copper zone/i);
    await writeFile(fresh.pcbPath, insertBoardForm(boardBaseline, '(footprint "Test:Local" (layer "F.Cu") (clearance 0.01))'));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/lifecycle-owned prepared-source authority|local copper-clearance override/i);
  });

  it("rejects forged equal-byte checkpoints and every post-validation file or custom-rule race before checkpoint commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-open-race-")); owned.add(root);
    const output = path.join(root, "output");
    const name = "generic-race";
    const fixture = createGenericDividerBundleFixture();
    const fresh = await prepareFreshProject({
      outputDir: output,
      name,
      resume: false,
      workflowKind: "generic",
      compilationBundle: fixture.bundle,
      compilationBundleRef: fixture.reference,
    });
    const projection = genericProjection();
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked" }));
    const proPath = path.join(fresh.projectPath, `${name}.kicad_pro`);
    const sparse = JSON.parse(await readFile(proPath, "utf8")) as Record<string, unknown>;
    sparse.board = { file: `${name}.kicad_pcb`, design_settings: { rules: { min_clearance: 0 } } };
    sparse.net_settings = {
      classes: [defaultNetClass(), ...projection.netClasses], meta: { version: 5 }, net_colors: null,
      netclass_assignments: {}, netclass_patterns: createExactContractNetClassPatterns(projection.contractNetAssignments),
    };
    await writeFile(proPath, JSON.stringify(sparse, null, 2));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    const preparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(fresh);
    const acceptedText = normalizedGenericProject(name, projection);
    await writeFile(proPath, acceptedText);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).resolves.toMatchObject({ changed: true });

    const trustedCheckpoint = await readFile(fresh.checkpointPath, "utf8");
    const malicious = JSON.parse(acceptedText) as Record<string, unknown>;
    malicious.malicious_unrelated_setting = true;
    const maliciousText = JSON.stringify(malicious);
    const forgedCheckpoint = JSON.parse(trustedCheckpoint) as { files: { pro: { sha256: string } } };
    forgedCheckpoint.files.pro.sha256 = createHash("sha256").update(maliciousText).digest("hex");
    await writeFile(proPath, maliciousText);
    await writeFile(fresh.checkpointPath, JSON.stringify(forgedCheckpoint, null, 2));
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/non-net-settings drift/i);
    await expect(checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name,
      expectedNetClassProjection: { netClasses: [], contractNetAssignments: [] },
      expectedPreparedSourceAuthority: preparedSourceAuthority,
    })).rejects.toThrow(/projection is not closed and valid/i);
    await writeFile(proPath, acceptedText);
    await writeFile(fresh.checkpointPath, trustedCheckpoint.replace("{", "{\n  \"attempt\": 999,"));
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: preparedSourceAuthority })).rejects.toThrow(/duplicate-free strict UTF-8 JSON/i);

    const markerPath = fresh.markerPath;
    const tracked = [
      { label: "pro", path: proPath },
      { label: "sch", path: fresh.schematicPath },
      { label: "pcb", path: fresh.pcbPath },
      { label: "symLibTable", path: path.join(fresh.projectPath, "sym-lib-table") },
      { label: "fpLibTable", path: path.join(fresh.projectPath, "fp-lib-table") },
      { label: "marker", path: markerPath },
    ] as const;
    const baselines = new Map(await Promise.all(tracked.map(async (entry) => [entry.path, await readFile(entry.path)] as const)));
    baselines.set(proPath, Buffer.from(acceptedText));
    const restoreTracked = async () => {
      await Promise.all(tracked.map(async (entry) => await writeFile(entry.path, baselines.get(entry.path)!)));
      await writeFile(fresh.checkpointPath, trustedCheckpoint);
    };
    for (const target of tracked.filter((entry) => entry.label !== "pro")) {
      await restoreTracked();
      const drifted = Buffer.concat([baselines.get(target.path)!, Buffer.from("\n")]);
      const forged = JSON.parse(trustedCheckpoint) as { baselineMarkerSha256: string; files: Record<string, { sha256: string }> };
      const digest = createHash("sha256").update(drifted).digest("hex");
      if (target.label === "marker") forged.baselineMarkerSha256 = digest;
      else forged.files[target.label]!.sha256 = digest;
      await writeFile(target.path, drifted);
      await writeFile(fresh.checkpointPath, JSON.stringify(forged, null, 2));
      await expect(checkpointFreshProjectOpenNormalization({
        outputDir: output,
        name,
        expectedNetClassProjection: projection,
        expectedPreparedSourceAuthority: preparedSourceAuthority,
      })).rejects.toThrow(/lifecycle-owned prepared-source authority|library tables differ/i);
    }
    const reorderedText = JSON.stringify(JSON.parse(acceptedText), null, 4);
    for (const target of tracked) {
      await restoreTracked();
      await writeFile(proPath, reorderedText);
      let hookCalled = false;
      await expect(checkpointFreshProjectOpenNormalization({
        outputDir: output,
        name,
        expectedNetClassProjection: projection,
        expectedPreparedSourceAuthority: preparedSourceAuthority,
        testHooks: { beforeCheckpointCommit: async () => {
          hookCalled = true;
          await writeFile(target.path, Buffer.concat([await readFile(target.path), Buffer.from("\n")]));
        } },
      })).rejects.toThrow(/validated snapshot changed/i);
      expect(hookCalled, `${target.label} race hook`).toBe(true);
      await expect(readFile(fresh.checkpointPath, "utf8")).resolves.toBe(trustedCheckpoint);
      expect((await readdir(output)).filter((entry) => entry.includes("checkpoint.json.") && entry.endsWith(".tmp"))).toEqual([]);
    }

    const rulesPath = path.join(fresh.projectPath, `${name}.kicad_dru`);
    await restoreTracked();
    await rm(rulesPath, { force: true });
    await writeFile(proPath, reorderedText);
    await expect(checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name,
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
      testHooks: { beforeCheckpointCommit: async () => await writeFile(rulesPath, "(version 1)\n(rule raced (constraint clearance (min 0.01mm)))\n") },
    })).rejects.toThrow(/validated snapshot changed/i);
    await expect(readFile(fresh.checkpointPath, "utf8")).resolves.toBe(trustedCheckpoint);

    await restoreTracked();
    await writeFile(rulesPath, "(version 1)\n");
    await writeFile(proPath, reorderedText);
    await expect(checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name,
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
      testHooks: { beforeCheckpointCommit: async () => await writeFile(rulesPath, "(version 1)\n(rule raced (constraint clearance (min 0.01mm)))\n") },
    })).rejects.toThrow(/validated snapshot changed/i);
    await expect(readFile(fresh.checkpointPath, "utf8")).resolves.toBe(trustedCheckpoint);

    await restoreTracked();
    await rm(rulesPath, { force: true });
    await writeFile(proPath, reorderedText);
    let finalFenceCalls = 0;
    await expect(checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name,
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
      assertCanCommit: () => { finalFenceCalls += 1; throw new Error("aggregate checkpoint deadline expired"); },
    })).rejects.toThrow(/aggregate checkpoint deadline expired/i);
    expect(finalFenceCalls).toBe(1);
    await expect(readFile(fresh.checkpointPath, "utf8")).resolves.toBe(trustedCheckpoint);
    expect((await readdir(output)).filter((entry) => entry.includes("checkpoint.json.") && entry.endsWith(".tmp"))).toEqual([]);

    await restoreTracked();
    await writeFile(proPath, reorderedText);
    let releaseLateHook!: () => void;
    let markLateHookEntered!: () => void;
    const lateHookGate = new Promise<void>((resolve) => { releaseLateHook = resolve; });
    const lateHookEntered = new Promise<void>((resolve) => { markLateHookEntered = resolve; });
    let deadlineExpired = false;
    const latePublication = checkpointFreshProjectOpenNormalization({
      outputDir: output,
      name,
      expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: preparedSourceAuthority,
      testHooks: { beforeCheckpointCommit: async () => { markLateHookEntered(); await lateHookGate; } },
      assertCanCommit: () => { if (deadlineExpired) throw new Error("late checkpoint completion rejected"); },
    });
    await lateHookEntered;
    deadlineExpired = true;
    releaseLateHook();
    await expect(latePublication).rejects.toThrow(/late checkpoint completion rejected/i);
    await expect(readFile(fresh.checkpointPath, "utf8")).resolves.toBe(trustedCheckpoint);
    expect((await readdir(output)).filter((entry) => entry.includes("checkpoint.json.") && entry.endsWith(".tmp"))).toEqual([]);
  });

  it("prepares an empty KiCad 10 trio and resume freezes marker file hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    const fresh = await prepareFreshProject({ outputDir: output, name: "canary-led", resume: false });
    await expect(readFile(path.join(fresh.projectPath, "canary-led.kicad_sch"), "utf8")).resolves.toContain("(lib_symbols)");
    await expect(readFile(path.join(fresh.projectPath, "canary-led.kicad_pcb"), "utf8")).resolves.not.toContain("(gr_rect");
    await expect(prepareFreshProject({ outputDir: output, name: "canary-led", resume: true })).resolves.toMatchObject({ projectPath: fresh.projectPath });
    await writeFile(path.join(fresh.projectPath, "canary-led.kicad_pcb"), "changed");
    await expect(prepareFreshProject({ outputDir: output, name: "canary-led", resume: true })).rejects.toThrow(/hash/i);
  });

  it("atomically restores an exact fresh schematic preimage and rejects marker-root identity drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const first = await prepareFreshProject({ outputDir: path.join(root, "first"), name: "rollback", resume: false });
    const rollback = new FreshSchematicRollback(first);
    const original = await readFile(first.schematicPath, "utf8");
    const checkpoint = await rollback.capture(original);
    await writeFile(first.schematicPath, original.replace("(paper \"A4\")", "(paper \"A3\")"), "utf8");
    await rollback.restore(checkpoint);
    await expect(readFile(first.schematicPath, "utf8")).resolves.toBe(original);

    const second = await prepareFreshProject({ outputDir: path.join(root, "second"), name: "drift", resume: false });
    const driftRollback = new FreshSchematicRollback(second);
    const driftCheckpoint = await driftRollback.capture(await readFile(second.schematicPath, "utf8"));
    const displaced = `${second.projectPath}-displaced`;
    await rename(second.projectPath, displaced);
    await mkdir(second.projectPath);
    await expect(driftRollback.restore(driftCheckpoint)).rejects.toThrow(/root identity changed|marker-bound project root/iu);
  });

  it("keeps the locked sidecar's sequential stock-symbol embedding path exact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "sequential-symbols", resume: false });
    let schematic = await readFile(fresh.schematicPath, "utf8");
    expect(schematic).toContain("\t(lib_symbols)\n\t(sheet_instances");

    // Mirrors the locked 3.33.3 sidecar's two insertion branches. The first
    // symbol expands the empty form; every later symbol requires the canonical
    // tab-indented nonempty marker emitted by the fresh-project scaffold.
    const insertDefinition = (current: string, libraryId: string): string => {
      const definition = `(symbol "${libraryId}" (property "Reference" "X"))`;
      if (current.includes(`(symbol "${libraryId}"`)) return current;
      if (current.includes("(lib_symbols)")) {
        return current.replace("(lib_symbols)", `(lib_symbols\n\t${definition}\n\t)`);
      }
      return current.replace("\t(lib_symbols\n", `\t(lib_symbols\n\t${definition}\n`);
    };

    const libraryIds = ["Connector_Generic:Conn_01x02", "Device:R", "Device:LED", "Device:C"] as const;
    for (const libraryId of libraryIds) schematic = insertDefinition(schematic, libraryId);
    for (const libraryId of libraryIds) {
      expect(schematic.split(`(symbol "${libraryId}"`).length - 1).toBe(1);
    }
    expect(schematic).toContain("\t(sheet_instances");
  });

  it("requires exactly one accepted 30x20 Edge.Cuts outline", () => {
    const outline = "(gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type solid)) (fill none) (layer \"Edge.Cuts\"))";
    expect(() => assertSingleFreshBoardOutline(outline)).not.toThrow();
    expect(() => assertSingleFreshBoardOutline(`${outline}\n${outline}`)).toThrow(/exactly one/i);
  });

  it("creates stock KiCad 10 library tables and freezes their marker hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    const fresh = await prepareFreshProject({ outputDir: output, name: "tables", resume: false });
    await expect(readFile(path.join(fresh.projectPath, "sym-lib-table"), "utf8")).resolves.toContain("${KICAD10_SYMBOL_DIR}/Device.kicad_sym");
    await expect(readFile(path.join(fresh.projectPath, "fp-lib-table"), "utf8")).resolves.toContain("${KICAD10_FOOTPRINT_DIR}/LED_SMD.pretty");
    await writeFile(path.join(fresh.projectPath, "sym-lib-table"), "tampered");
    await expect(prepareFreshProject({ outputDir: output, name: "tables", resume: true })).rejects.toThrow(/symLibTable/i);
  });

  it("accepts only KiCad label enums and rejects a captured invalid center justification", () => {
    expect(() => parseFreshIncrementalArguments("sch_add_label", { name: "NET", x_mm: 1, y_mm: 1, rotation: 0, justify: "center" })).toThrow(/invalid option/i);
    expect(() => parseFreshIncrementalArguments("sch_add_labels", { labels: [{ name: "NET", x_mm: 1, y_mm: 1, kind: "global", shape: "bidirectional", justify: "center" }] })).toThrow(/invalid option/i);
    expect(parseFreshIncrementalArguments("sch_add_labels", { labels: [{ name: "NET", x_mm: 1, y_mm: 1, rotation: 90, kind: "hierarchical", shape: "input", justify: "left top" }] })).toMatchObject({ labels: [expect.objectContaining({ kind: "hierarchical", shape: "input", justify: "left top" })] });
    expect(FRESH_INCREMENTAL_INPUT_SCHEMAS.sch_add_label).toMatchObject({ properties: { justify: { enum: ["left", "right", "top", "bottom", "left top", "left bottom", "right top", "right bottom", "none"] } } });
  });

  it("requires finite count-bound millimetre schematic bounding-box evidence", () => {
    expect(parseFreshBoundingBoxes(boxReadback("R1 1k 20 15 19 10 21 20"))).toEqual([{ reference: "R1", minX: 19, minY: 10, maxX: 21, maxY: 20 }]);
    expect(() => parseFreshBoundingBoxes(boxReadback("R1 1k 20 15 19 10 21 20").replace(" mm", ""))).toThrow(/millimetre units/iu);
    expect(() => parseFreshBoundingBoxes(boxReadback("R1 1k 20 15 19 10 21 20").replace("(1 symbols)", "(2 symbols)"))).toThrow(/count mismatch/iu);
    expect(() => parseFreshBoundingBoxes(boxReadback("R1 1k NaN 15 19 10 21 20"))).toThrow(/malformed row|non-finite/iu);
  });

  it("parses exact locked-3.33.3 symbol lines with or without a validated footprint suffix", async () => {
    const locked = parseFreshPlacements(lockedSidecarSymbolReadback);
    expect([...locked.keys()]).toEqual(["J1", "R1", "D1", "C1"]);
    expect(locked.get("J1")?.[0]).toMatchObject({
      reference: "J1", library: "Connector_Generic", symbol: "Conn_01x02", x: 30.48, y: 50.8, rotation: 0, unit: 1,
      footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
    });
    expect(locked.get("R1")?.[0]?.footprint).toBe("Resistor_SMD:R_0603_1608Metric");
    expect(locked.get("D1")?.[0]?.footprint).toBe("LED_SMD:LED_0603_1608Metric");
    expect(locked.get("C1")?.[0]?.footprint).toBe("Capacitor_SMD:C_0603_1608Metric");
    expect(parseFreshPlacements(planarSymbols).size).toBe(4);
    expect(() => parseFreshPlacements(`${lockedSidecarSymbolReadback} extra=yes`)).toThrow(/malformed|suffix/iu);
    expect(() => parseFreshPlacements(lockedSidecarSymbolReadback.replace("footprint=Resistor_SMD:R_0603_1608Metric", "footprint=malformed"))).toThrow(/malformed|suffix/iu);
    expect(() => parseFreshPlacements(lockedSidecarSymbolReadback.replace("unit=1 footprint=", "unit=0 footprint="))).toThrow(/malformed|bounds/iu);
    expect(() => parseFreshPlacements(lockedSidecarSymbolReadback.replace("Symbols (4 total)", "Symbols (5 total)"))).toThrow(/count/iu);
    const liveReport = JSON.parse(await readFile(new URL("../fixtures/fresh-project/captured-symbols.report.json", import.meta.url), "utf8")) as {
      harness?: { operations?: { name?: string; result?: { content?: string } }[] };
    };
    const capturedContent = liveReport.harness?.operations?.find((operation) => operation.name === "sch_get_symbols" && operation.result?.content?.includes("footprint="))?.result?.content;
    expect(capturedContent).toBeTypeOf("string");
    const capturedPayload = JSON.parse(capturedContent!) as { result: string };
    expect(parseFreshPlacements(capturedPayload.result).size).toBe(4);
  });

  it("derives captured stock-symbol escape directions from exact embedded cardinal pin angles", async () => {
    const source = embeddedLedSchematic();
    expect(parseFreshEmbeddedPinAngles(source, "Connector_Generic:Conn_01x02", 1)).toEqual({ "1": 0, "2": 0 });
    expect(parseFreshEmbeddedPinAngles(source, "Device:R", 1)).toEqual({ "1": 270, "2": 90 });
    expect(parseFreshEmbeddedPinAngles(source, "Device:LED", 1)).toEqual({ "1": 0, "2": 180 });
    expect(parseFreshEmbeddedPinAngles(source, "Device:C", 1)).toEqual({ "1": 270, "2": 90 });
    expect(freshAbsolutePinAngle(0, 90)).toBe(90);
    expect(freshAbsolutePinAngle(270, 90)).toBe(0);
    expect(freshAbsolutePinAngle(0, 45)).toBeNull();
    expect(freshEndpointEscape(
      { x: 45.72, y: 53.34, angleDeg: 0 },
      { reference: "J1", minX: 40.64, minY: 43.18, maxX: 60.96, maxY: 58.42 },
    )).toEqual({ x: 39.37, y: 53.34 });
    expect(freshEndpointEscape(
      { x: 60.96, y: 44.45, angleDeg: 270 },
      { reference: "R1", minX: 50.8, minY: 40.64, maxX: 71.12, maxY: 55.88 },
    )).toEqual({ x: 60.96, y: 39.37 });
    expect(freshEndpointEscape(
      { x: 64.77, y: 48.26, angleDeg: 0 },
      { reference: "D1", minX: 58.42, minY: 40.64, maxX: 78.74, maxY: 55.88 },
    )).toEqual({ x: 57.15, y: 48.26 });
    const d1AnodeEscape = freshEndpointEscape(
      { x: 72.39, y: 48.26, angleDeg: 180 },
      { reference: "D1", minX: 58.42, minY: 40.64, maxX: 78.74, maxY: 55.88 },
    );
    expect(d1AnodeEscape?.x).toBe(80.01);
    expect(d1AnodeEscape?.y).toBe(48.26);
    expect(freshEndpointEscape(
      { x: 60.96, y: 59.69, angleDeg: 90 },
      { reference: "C1", minX: 50.8, minY: 48.26, maxX: 71.12, maxY: 63.5 },
    )).toEqual({ x: 60.96, y: 64.77 });
    expect(() => parseFreshEmbeddedPinAngles(source.replace("(at -5.08 -2.54 0)", "(at -5.08 -2.54 45)"), "Connector_Generic:Conn_01x02", 1)).toThrow(/cardinal/iu);
    expect(() => parseFreshEmbeddedPinAngles(source, "Device:Missing", 1)).toThrow(/exactly one embedded/iu);
    const captured = await readFile(new URL("../fixtures/fresh-project/captured-stock-symbols.kicad_sch", import.meta.url), "utf8");
    expect(parseFreshEmbeddedPinAngles(captured, "Device:C", 1)).toEqual({ "1": 270, "2": 90 });
    expect(parseFreshEmbeddedPinAngles(captured, "Device:R", 1)).toEqual({ "1": 270, "2": 90 });
    expect(parseFreshEmbeddedPinAngles(captured, "Device:LED", 1)).toEqual({ "1": 0, "2": 180 });
    expect(parseFreshEmbeddedPinAngles(captured, "Connector_Generic:Conn_01x02", 1)).toEqual({ "1": 0, "2": 0 });
  });

  it("snaps escape boundaries outward while retaining the rounding margin and exact pin axis", () => {
    const pin = { x: 45.72, y: 53.3400001, angleDeg: 0 as const };
    const box = { reference: "J1", minX: 40.66, minY: 43.18, maxX: 60.96, maxY: 58.42 };
    // The 0.02 mm margin lands exactly on the grid, despite binary subtraction.
    expect(freshEndpointEscape(pin, box)).toEqual({ x: 40.64, y: pin.y });
    expect(freshEndpointEscape(pin, { ...box, minX: 40.659 })).toEqual({ x: 39.37, y: pin.y });
    expect(freshEndpointEscape({ ...pin, x: -45.72, angleDeg: 180 }, { ...box, maxX: -40.66 }))
      .toEqual({ x: -40.64, y: pin.y });
    expect(freshEndpointEscape({ ...pin, x: -35.56 }, { ...box, minX: -40.64 }))
      .toEqual({ x: -41.91, y: pin.y });
    expect(freshEndpointEscape({ ...pin, x: 64.6 }, { ...box, minX: 40.64 })).toBeNull();
    expect(freshEndpointEscape({ ...pin, x: Number.NaN }, box)).toBeNull();
  });

  it("deduplicates reversed wire endpoints only within the same net", () => {
    const forward = { x: 1, y: 2, endX: 5, endY: 2, net: "+5V" };
    const reversed = { x: 5, y: 2, endX: 1, endY: 2, net: "+5V" };
    const crossNet = { ...reversed, net: "GND" };
    expect(freshSameNetWire(forward, reversed)).toBe(true);
    expect(freshSameNetWire(forward, crossNet)).toBe(false);
  });

  it("routes the historical LED-proof4 placement on-grid and finds a deterministic complete move for overlapping symbols", async () => {
    const contract = createFreshConnectivityContract(LED_INDICATOR_EXAMPLE);
    const placements = new Map([
      ["J1", { reference: "J1", library: "Connector_Generic", symbol: "Conn_01x02", x: 25.4, y: 50.8, rotation: 0, unit: 1 }],
      ["R1", { reference: "R1", library: "Device", symbol: "R", x: 50.8, y: 25.4, rotation: 0, unit: 1 }],
      ["D1", { reference: "D1", library: "Device", symbol: "LED", x: 76.2, y: 50.8, rotation: 0, unit: 1 }],
      ["C1", { reference: "C1", library: "Device", symbol: "C", x: 101.6, y: 76.2, rotation: 0, unit: 1 }],
    ]);
    const boxes = [
      { reference: "J1", minX: 15.24, minY: 43.18, maxX: 35.56, maxY: 58.42 },
      { reference: "R1", minX: 40.64, minY: 17.78, maxX: 60.96, maxY: 33.02 },
      { reference: "D1", minX: 66.04, minY: 43.18, maxX: 86.36, maxY: 58.42 },
      { reference: "C1", minX: 91.44, minY: 68.58, maxX: 111.76, maxY: 83.82 },
    ];
    const pins = new Map([
      ["J1:1", { x: 20.32, y: 50.8, angleDeg: 0 as const }], ["J1:2", { x: 20.32, y: 53.34, angleDeg: 0 as const }],
      ["R1:1", { x: 50.8, y: 21.59, angleDeg: 270 as const }], ["R1:2", { x: 50.8, y: 29.21, angleDeg: 90 as const }],
      ["D1:1", { x: 72.39, y: 50.8, angleDeg: 0 as const }], ["D1:2", { x: 80.01, y: 50.8, angleDeg: 180 as const }],
      ["C1:1", { x: 101.6, y: 72.39, angleDeg: 270 as const }], ["C1:2", { x: 101.6, y: 80.01, angleDeg: 90 as const }],
    ]);
    const historical = JSON.parse(await readFile(new URL("../fixtures/fresh-project/blocked-wire-plan.report.json", import.meta.url), "utf8")) as { harness: { operations: { name: string; result?: { content?: string } }[] } };
    const finalHistorical = [...historical.harness.operations].reverse().find((operation) => operation.name === "fresh_apply_contract_connectivity");
    expect(JSON.parse(finalHistorical!.result!.content!)).toMatchObject({ issues: [expect.objectContaining({ code: "NO_PROVEN_COLLISION_FREE_WIRE_PLAN", endpoints: ["D1:1", "J1:2"] })] });

    expect(inspectFreshConnectivityWirePlan(contract, pins, boxes)).toMatchObject({ issues: [], routes: expect.arrayContaining([expect.stringContaining("J1")]) });
    // Outward grid lanes now route the historical placement without moves.
    // Give the placement solver an actual overlap so its move contract is tested.
    placements.set("J1", { ...placements.get("J1")!, x: 50.8, y: 25.4 });
    const j1Box = boxes.find((box) => box.reference === "J1")!;
    j1Box.minX += 25.4; j1Box.maxX += 25.4; j1Box.minY -= 25.4; j1Box.maxY -= 25.4;
    for (const [id, pin] of pins) if (id.startsWith("J1:")) pins.set(id, { ...pin, x: pin.x + 25.4, y: pin.y - 25.4 });
    const first = searchFreshConnectivityPlacement(contract, placements, boxes, pins);
    const second = searchFreshConnectivityPlacement(contract, new Map([...placements].reverse()), [...boxes].reverse(), new Map([...pins].reverse()));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "found", exhaustionReason: "none" });
    expect(first.recommendedMoves.length).toBeGreaterThan(0);
    expect(first).not.toHaveProperty("timedOut");
    expect(first.candidateCount).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxTotalCandidates);
    expect(first.statesVisited).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxStates);
    expect(first.configurationsEvaluated).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxConfigurations);
    expect(first.planEvaluations).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxPlanEvaluations);
    expect(first.segmentChecks).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxSegmentChecks);
    expect(first.recommendationIdentity?.digest).toMatch(/^[a-f0-9]{64}$/u);

    const movedPlacements = new Map(placements);
    const movedBoxes = boxes.map((box) => ({ ...box }));
    const movedPins = new Map(pins);
    for (const move of first.recommendedMoves) {
      const before = movedPlacements.get(move.reference)!;
      expect(move.rotationDeg).toBe(before.rotation);
      const dx = move.xMm - before.x;
      const dy = move.yMm - before.y;
      movedPlacements.set(move.reference, { ...before, x: move.xMm, y: move.yMm, rotation: move.rotationDeg });
      const box = movedBoxes.find((entry) => entry.reference === move.reference)!;
      box.minX += dx; box.maxX += dx; box.minY += dy; box.maxY += dy;
      for (const [id, pin] of movedPins) if (id.startsWith(`${move.reference}:`)) movedPins.set(id, { ...pin, x: pin.x + dx, y: pin.y + dy });
    }
    expect(inspectFreshConnectivityWirePlan(contract, movedPins, movedBoxes)).toMatchObject({ issues: [], routes: expect.arrayContaining([expect.stringContaining("J1")]) });

    expect(searchFreshConnectivityPlacement(contract, new Map(), boxes, pins)).toMatchObject({ status: "unsupported", recommendedMoves: [], candidateCount: 0 });
    const outside = boxes.map((box) => ({ ...box, minX: -500, minY: -500, maxX: 500, maxY: 500 }));
    expect(searchFreshConnectivityPlacement(contract, placements, outside, pins)).toMatchObject({ status: "exhausted", recommendedMoves: [], candidateCount: 0, exhaustionReason: "no-solution" });

    const eightComponents = { ...contract, components: Array.from({ length: 8 }, (_, index) => ({ ...contract.components[0]!, reference: `X${index + 1}` })) } as typeof contract;
    const nineComponents = { ...eightComponents, components: [...eightComponents.components, { ...contract.components[0]!, reference: "X9" }] } as typeof contract;
    expect(searchFreshConnectivityPlacement(eightComponents, new Map(), [], new Map())).toMatchObject({ status: "unsupported", exhaustionReason: "no-solution" });
    expect(searchFreshConnectivityPlacement(nineComponents, new Map(), [], new Map())).toMatchObject({ status: "unsupported", exhaustionReason: "component-limit", statesVisited: 0, planEvaluations: 0 });
    const endpoint = contract.nets[0]!.endpoints[0]!;
    const atEndpointLimit = { ...contract, nets: [{ name: "N", endpoints: Array.from({ length: 64 }, () => endpoint) }], noConnects: [] } as typeof contract;
    const overEndpointLimit = { ...contract, nets: [{ name: "N", endpoints: Array.from({ length: 65 }, () => endpoint) }], noConnects: [] } as typeof contract;
    expect(searchFreshConnectivityPlacement(atEndpointLimit, new Map(), [], new Map())).toMatchObject({ status: "unsupported", exhaustionReason: "no-solution" });
    expect(searchFreshConnectivityPlacement(overEndpointLimit, new Map(), [], new Map())).toMatchObject({ status: "unsupported", exhaustionReason: "endpoint-limit", statesVisited: 0, segmentChecks: 0 });
  });

  it("selects a shorter compact complete layout than the captured attempt14 first-feasible recommendation", () => {
    const contract = createFreshConnectivityContract(createGenericDividerBundleFixture().bundle.contract);
    // Immutable negative-case coordinates from attempt14 call_6 through call_9;
    // these are test evidence, never placement coordinates supplied to production.
    const placements = new Map([
      ["J1", { reference: "J1", library: "Connector_Generic", symbol: "Conn_01x03", x: 76.2, y: 76.2, rotation: 0, unit: 1 }],
      ["R1", { reference: "R1", library: "Device", symbol: "R", x: 114.3, y: 63.5, rotation: 0, unit: 1 }],
      ["R2", { reference: "R2", library: "Device", symbol: "R", x: 114.3, y: 88.9, rotation: 0, unit: 1 }],
    ]);
    const boxes = [...placements.values()].map((entry) => ({ reference: entry.reference, minX: entry.x - 10.16, maxX: entry.x + 10.16, minY: entry.y - 7.62, maxY: entry.y + 7.62 }));
    const pins = new Map([
      ["J1:1", { x: 71.12, y: 73.66, angleDeg: 0 as const }],
      ["J1:2", { x: 71.12, y: 76.2, angleDeg: 0 as const }],
      ["J1:3", { x: 71.12, y: 78.74, angleDeg: 0 as const }],
      ["R1:1", { x: 114.3, y: 59.69, angleDeg: 270 as const }],
      ["R1:2", { x: 114.3, y: 67.31, angleDeg: 90 as const }],
      ["R2:1", { x: 114.3, y: 85.09, angleDeg: 270 as const }],
      ["R2:2", { x: 114.3, y: 92.71, angleDeg: 90 as const }],
    ]);
    const initial = JSON.stringify({ contract, placements: [...placements], pins: [...pins], boxes });
    const moveGeometry = (moves: readonly { reference: string; xMm: number; yMm: number }[]) => {
      const movedPins = new Map(pins);
      const movedBoxes = boxes.map((box) => ({ ...box }));
      for (const move of moves) {
        const prior = placements.get(move.reference)!;
        const dx = move.xMm - prior.x;
        const dy = move.yMm - prior.y;
        const box = movedBoxes.find((entry) => entry.reference === move.reference)!;
        box.minX += dx; box.maxX += dx; box.minY += dy; box.maxY += dy;
        for (const [id, pin] of movedPins) if (id.startsWith(`${move.reference}:`)) movedPins.set(id, { ...pin, x: pin.x + dx, y: pin.y + dy });
      }
      return { pins: movedPins, boxes: movedBoxes };
    };
    const captured = moveGeometry([{ reference: "R1", xMm: 101.6, yMm: 76.2 }, { reference: "R2", xMm: 76.2, yMm: 177.8 }]);
    const oldPlan = inspectFreshConnectivityWirePlan(contract, captured.pins, captured.boxes);
    expect(oldPlan.issues).toEqual([]);
    const selected = searchFreshConnectivityPlacement(contract, placements, boxes, pins, undefined, true);
    expect(selected.status).toBe("found");
    expect(selected.configurationsEvaluated).toBeGreaterThan(163);
    const improved = moveGeometry(selected.recommendedMoves);
    const newPlan = inspectFreshConnectivityWirePlan(contract, improved.pins, improved.boxes, true);
    expect(newPlan.issues).toEqual([]);
    expect(newPlan.wireLengthMm).toBeLessThan(oldPlan.wireLengthMm);
    const verticalSpan = (items: typeof boxes) => Math.max(...items.map((box) => box.maxY)) - Math.min(...items.map((box) => box.minY));
    expect(verticalSpan(improved.boxes)).toBeLessThan(verticalSpan(captured.boxes));
    expect(selected.segmentChecks).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxSegmentChecks);
    expect(JSON.stringify({ contract, placements: [...placements], pins: [...pins], boxes })).toBe(initial);
  });

  it("deterministically byte-bounds maximum collision and successful connectivity results", () => {
    const contract = createFreshConnectivityContract(LED_INDICATOR_EXAMPLE);
    const collisionIssues = Array.from({ length: 2_016 }, (_, index) => ({
      code: "PIN_COORDINATE_COLLISION",
      message: `Collision ${index}: ${"électrical-point ".repeat(40)}`,
      remediation: `Separate the exact endpoint pair ${index}: ${"grid-placement ".repeat(40)}`,
      endpoints: [`P${index % 64}`, `P${(index + 1) % 64}`],
      atMm: { x: 25.4, y: 25.4 },
    }));
    const collision = serializeFreshContractConnectivityResult(contract, {
      applied: false, mutated: false, idempotent: false,
      issues: collisionIssues,
      issueEvidence: { total: collisionIssues.length, returned: 128, truncated: true },
      blockingEdges: Array.from({ length: 64 }, (_, index) => ({ net: `N${index}`, endpoints: [`P${index}`, `P${(index + 1) % 64}`] as const })),
    });
    expect(collision.length).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    expect(Buffer.byteLength(collision, "utf8")).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    expect(JSON.parse(collision)).toMatchObject({
      applied: false,
      issueEvidence: { total: 2_016, truncated: true },
      blockingEdgeEvidence: { total: 64, truncated: true },
    });

    const endpointNames = Array.from({ length: 64 }, (_, index) => `R${index + 1}:${"P".repeat(100)}${index}`);
    const success = serializeFreshContractConnectivityResult(contract, {
      applied: true, mutated: true, idempotent: false, issues: [],
      routes: Array.from({ length: 63 }, (_, index) => `${endpointNames[index]}-${endpointNames[index + 1]}`),
      noConnects: endpointNames,
      connectivity: [{ name: "N".repeat(200), endpoints: endpointNames }],
    });
    expect(success.length).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    expect(Buffer.byteLength(success, "utf8")).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    expect(JSON.parse(success)).toMatchObject({ applied: true, mutated: true, issues: [], issueEvidence: { total: 0, returned: 0, truncated: false } });
  });

  it("binds persisted no-connect parity to exact marker coordinates", () => {
    const source = '(kicad_sch (version 20250316) (no_connect (at 12.7 25.4)))';
    expect(freshPersistedNoConnectsMatch(source, [{ x: 12.7, y: 25.4 }])).toBe(true);
    expect(freshPersistedNoConnectsMatch(source, [{ x: 12.7, y: 26.4 }])).toBe(false);
    expect(freshPersistedNoConnectsMatch(source, [])).toBe(false);
  });

  it("continues from a report-bound fresh checkpoint, reconciles report metadata, and rejects byte drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    const fresh = await prepareFreshProject({ outputDir: output, name: "resume", resume: false });
    await writeFile(fresh.schematicPath, "(kicad_sch (changed yes))\n");
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked" }));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    await expect(prepareFreshProject({ outputDir: output, name: "resume", resume: true })).resolves.toMatchObject({ projectPath: fresh.projectPath });
    await writeFile(fresh.schematicPath, "(kicad_sch (manual drift yes))\n");
    await expect(prepareFreshProject({ outputDir: output, name: "resume", resume: true })).rejects.toThrow(/differ from the latest checkpoint/i);

    const secondOutput = path.join(root, "report-mismatch");
    const second = await prepareFreshProject({ outputDir: secondOutput, name: "mismatch", resume: false });
    await writeFile(second.schematicPath, "(kicad_sch (changed yes))\n");
    const secondReport = path.join(secondOutput, "pcb-agent-report.json");
    await writeFile(secondReport, JSON.stringify({ status: "blocked" }));
    await second.checkpointAfterReport(secondReport, "blocked");
    await writeFile(secondReport, JSON.stringify({ status: "needs_review" }));
    await expect(prepareFreshProject({ outputDir: secondOutput, name: "mismatch", resume: true })).resolves.toMatchObject({ projectPath: second.projectPath });
  });

  it("applies the synchronous commit fence to ordinary report checkpoints without replacing the prior checkpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-commit-fence-")); owned.add(root);
    const output = path.join(root, "output");
    const fresh = await prepareFreshProject({ outputDir: output, name: "commit-fence", resume: false });
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked" }));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    const trustedCheckpoint = await readFile(fresh.checkpointPath);
    let fenceCalls = 0;
    await expect(fresh.checkpointAfterReport(reportPath, "blocked", {
      assertCanCommit: () => { fenceCalls += 1; throw new Error("ordinary checkpoint aborted"); },
    })).rejects.toThrow(/ordinary checkpoint aborted/i);
    expect(fenceCalls).toBe(1);
    await expect(readFile(fresh.checkpointPath)).resolves.toEqual(trustedCheckpoint);
    expect((await readdir(output)).filter((entry) => entry.includes("checkpoint.json.") && entry.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the last trusted checkpoint and permanently rejects resume after an unsafe terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "unsafe");
    const fresh = await prepareFreshProject({ outputDir: output, name: "unsafe", resume: false });
    const reportPath = path.join(output, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "blocked", summary: "trusted stop" }));
    await fresh.checkpointAfterReport(reportPath, "blocked");
    const trustedCheckpoint = await readFile(fresh.checkpointPath);
    await writeFile(reportPath, JSON.stringify({ status: "failed", summary: "FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL" }));
    await fresh.recordUnsafeTerminal(reportPath, "FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL");
    await expect(readFile(fresh.checkpointPath)).resolves.toEqual(trustedCheckpoint);
    await expect(readFile(fresh.unsafeTerminalPath, "utf8")).resolves.toContain("evleda.pcb-agent-unsafe-terminal.v1");
    await expect(prepareFreshProject({ outputDir: output, name: "unsafe", resume: true })).rejects.toThrow(/cannot resume|newly prepared/iu);
  });

  it("checkpoints a pre-provider fresh CLI failure and permits the unchanged resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    await prepareFreshProject({ outputDir: output, name: "preflight", resume: false });
    const result = await runPcbAgentCli({
      workflowKind: "led_compatibility_fixture",
      prompt: "x", provider: "openai", model: "test", newProjectName: "preflight", outputDir: output,
      iterations: 1, openAiServiceTier: "fast", mode: "resume",
    }, { sessionFactory: async () => { throw new Error("pre-provider capability failure"); } });
    expect(result.report.status).toBe("failed");
    await expect(readFile(path.join(output, ".evleda-pcb-agent-checkpoint.json"), "utf8")).resolves.toContain('"reportStatus": "failed"');
    await expect(prepareFreshProject({ outputDir: output, name: "preflight", resume: true })).resolves.toMatchObject({ projectPath: path.join(output, "project") });
  });

  it("rejects unsafe fresh names and non-empty output directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    await expect(prepareFreshProject({ outputDir: path.join(root, "out"), name: "../bad", resume: false })).rejects.toThrow(/safe lowercase/i);
    const output = path.join(root, "occupied");
    await writeFile(output, "occupied");
    await expect(prepareFreshProject({ outputDir: output, name: "safe", resume: false })).rejects.toThrow(/ordinary directory/i);
  });

  it("does not expose whole-schematic replacement for normal copied projects", () => {
    const definitions = projectKicadHarnessToolDefinitions(session(KICAD_HARNESS_TOOL_NAMES));
    expect(definitions.map((item) => item.name)).not.toContain("sch_build_circuit");
    expect(KICAD_HARNESS_TOOL_NAMES).not.toContain("sch_build_circuit");
    expect(KICAD_FRESH_HARNESS_TOOL_NAMES).not.toContain("sch_build_circuit");
    expect(KICAD_FRESH_HARNESS_TOOL_NAMES).not.toContain("sch_analyze_net_compilation");
    expect(KICAD_FRESH_HARNESS_TOOL_NAMES).not.toContain("export_manufacturing_package");
  });

  it("exposes only strict incremental fresh authoring and post-edit readback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "gate", resume: false });
    let calls = 0;
    const bridge = createKicadHarnessTools({ ...session(), callTool: async () => { calls += 1; return { content: [], structuredContent: { ok: true } }; } }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    expect(bridge.tools.find((tool) => tool.name === "sch_add_symbol")?.inputSchema).toStrictEqual(FRESH_INCREMENTAL_INPUT_SCHEMAS.sch_add_symbol);
    expect(bridge.tools.map((tool) => tool.name)).not.toContain("export_manufacturing_package");
    const invalid = { library: "Device", symbol_name: "R", x_mm: 1, y_mm: 1, reference: "R1", value: "1k", extra: "no" };
    await expect(bridge.execute({ id: "bad-nested", name: "sch_add_symbol", arguments: invalid })).rejects.toThrow(/unrecognized key/i);
    await bridge.execute({ id: "add-r1", name: "sch_add_symbol", arguments: { library: "Device", symbol_name: "R", x_mm: 1, y_mm: 1, reference: "R1", value: "1k" } });
    await bridge.execute({ id: "readback", name: "sch_get_connectivity_graph", arguments: {} });
    expect(calls).toBe(2);
    expect(FRESH_INCREMENTAL_INPUT_SCHEMAS.sch_add_symbol).toMatchObject({ type: "object", additionalProperties: false });
    expect(FRESH_PROJECT_PROMPT_CONTEXT).toContain("BL_F_Cu");
    expect(FRESH_LED_INDICATOR_PROVIDER_CONTRACT).toContain("Connector_Generic:Conn_01x02");
    expect(FRESH_LED_INDICATOR_PROVIDER_CONTRACT).toContain('"cathodeNet": "GND"');
    expect(FRESH_PROJECT_PROMPT_CONTEXT).toContain("never guess pin, label, or wire coordinates");
    expect(FRESH_PROJECT_PROMPT_CONTEXT).toMatch(/fresh_apply_recommended_schematic_placement.*only the returned recommendationIdentity/iu);
    expect(FRESH_PROJECT_PROMPT_CONTEXT).toMatch(/never call sch_move_symbol for a pending recommendation/iu);
    expect(bridge.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["sch_get_pin_positions", "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement"]));
    expect(bridge.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["sch_add_label", "sch_add_labels", "sch_add_wire", "sch_route_wire_between_pins", "sch_add_no_connect"]));
  });

  it("applies only host-bound connectivity, then no-ops idempotently on exact readback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "names", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const calls: string[] = [];
    let applied = false;
    const pristine = "Connectivity groups (8 total):\n- Group 1: ~unnamed | pins=J1:1 | points=1\n- Group 2: ~unnamed | pins=J1:2 | points=1\n- Group 3: ~unnamed | pins=R1:1 | points=1\n- Group 4: ~unnamed | pins=R1:2 | points=1\n- Group 5: ~unnamed | pins=D1:1 | points=1\n- Group 6: ~unnamed | pins=D1:2 | points=1\n- Group 7: ~unnamed | pins=C1:1 | points=1\n- Group 8: ~unnamed | pins=C1:2 | points=1";
    const exact = "Connectivity groups (3 total):\n- Group 1: +5V | pins=C1:1, J1:1, R1:1 | points=6\n- Group 2: GND | pins=C1:2, D1:1, J1:2 | points=6\n- Group 3: LED_A | pins=D1:2, R1:2 | points=4";
    let capturedNativeNetlist = ledNativeNetlist;
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "sch_move_symbol", "run_erc", "pcb_save"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        calls.push(name);
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: planarBoxes } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: applied ? exact : pristine } };
        if (name === "sch_add_wire") await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`);
        if (name === "sch_add_label") await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
        if (name === "sch_add_no_connect") await appendSchematicForm(fresh.schematicPath, `(no_connect (at ${String(args.x_mm)} ${String(args.y_mm)}))`);
        if (name === "sch_add_missing_junctions") applied = true;
        if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE, verifyPersistedMutation: async () => true, captureFreshNativeNetlist: async () => capturedNativeNetlist });
    await expect(bridge.execute({ id: "wrong-group", name: "sch_add_label" as never, arguments: { name: "+5V", x_mm: 46.99, y_mm: 45.72, justify: "left" } })).rejects.toThrow(/unsupported/i);
    await expect(bridge.execute({ id: "no-provider-topology", name: "sch_route_wire_between_pins" as never, arguments: { ref1: "J1", pin1: "1", ref2: "R1", pin2: "1" } })).rejects.toThrow(/unsupported/i);
    await expect(bridge.execute({ id: "bad-args", name: "fresh_apply_contract_connectivity", arguments: { nets: [] } })).rejects.toThrow(/unrecognized key/i);
    const first = await bridge.execute({ id: "apply-contract", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(first.content)).toMatchObject({ applied: true, mutated: true, idempotent: false, issues: [] });
    const wireCallCount = calls.filter((name) => name === "sch_add_wire").length;
    expect(wireCallCount).toBeGreaterThan(0);
    expect(calls.filter((name) => name === "sch_add_label")).toHaveLength(3);
    expect(calls).toContain("sch_add_missing_junctions");
    expect(calls).toContain("run_erc");
    const firstSave = await bridge.internal.saveAfterMutation({ id: "save-first", name: "pcb_save", arguments: {} });
    expect(firstSave).toMatchObject({ content: expect.stringContaining("saved-and-native-connectivity-verified") });
    const second = await bridge.execute({ id: "apply-again", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(second.content)).toMatchObject({ applied: true, mutated: false, idempotent: true, issues: [], nativeNetlistSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await expect(bridge.execute({ id: "move-after-idempotent", name: "sch_move_symbol", arguments: { reference: "C1", x_mm: 42, y_mm: 20 } })).resolves.toMatchObject({ toolCallId: "move-after-idempotent" });
    capturedNativeNetlist = ledNativeNetlist.replace(nativeNode("R1", "1"), "");
    const rejectedParity = await bridge.execute({ id: "apply-bad-native", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(rejectedParity.content)).toMatchObject({ applied: false, mutated: false, idempotent: true, issues: [expect.objectContaining({ code: "NATIVE_NET_ENDPOINT_PARITY_MISMATCH" })] });
    expect(calls.filter((name) => name === "sch_add_wire")).toHaveLength(wireCallCount);
    expect(bridge.tools.find((tool) => tool.name === "fresh_apply_contract_connectivity")?.inputSchema).toStrictEqual({ type: "object", additionalProperties: false, properties: {}, required: [] });
    expect(bridge.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["sch_route_wire_between_pins", "sch_add_label", "sch_add_no_connect", "sch_add_power_symbol"]));
  });

  it("rolls back newly mutated connectivity when result serialization fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "serialize-rollback", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const baseline = await readFile(fresh.schematicPath, "utf8");
    let applied = false;
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: planarBoxes } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: applied ? exactLedGraph : pristineLedGraph } };
        if (name === "sch_add_wire") await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`);
        if (name === "sch_add_label") await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
        if (name === "sch_add_missing_junctions") applied = true;
        if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const json = JSON as unknown as { stringify(value: unknown): string };
    const originalStringify = json.stringify.bind(JSON);
    json.stringify = (value: unknown): string => {
      if (value !== null && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === "evleda.fresh-contract-connectivity-result.v1" && (value as { mutated?: unknown }).mutated === true) {
        throw new Error("forced result serialization failure");
      }
      return originalStringify(value);
    };
    try {
      await expect(bridge.execute({ id: "serialize-failure", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL.*result construction failed/iu);
    } finally {
      json.stringify = originalStringify;
    }
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
  });

  it.each(["mcp-error", "save-throw", "fingerprint-false", "fingerprint-throw", "no-save-tool", "parity-throw", "duplicate-parity-throw", "board-fallback", "later-read-error", "duplicate-preflight-throw"] as const)("restores pending connectivity and returns a terminal save result for %s", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, mode), name: "savefail", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const baseline = await readFile(fresh.schematicPath, "utf8");
    let applied = false;
    let fingerprint = "before-this-mutation";
    let baselineCaptures = 0;
    let failAfterApply = false;
    const captured: (string | undefined)[] = [];
    const names = ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc", "pcb_add_track", "kicad_get_project_info", "pcb_get_board_as_string", ...(mode === "no-save-tool" ? [] : ["pcb_save"])];
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => names.map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (failAfterApply && mode === "duplicate-preflight-throw" && name === "sch_get_symbols") throw new Error("duplicate preflight read threw");
        if (failAfterApply && mode === "later-read-error" && name === "sch_get_bounding_boxes") return { isError: true, content: [{ type: "text", text: "later read rejected" }] };
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: planarBoxes } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: applied ? exactLedGraph : pristineLedGraph } };
        if (name === "sch_add_wire") { await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`); fingerprint = "changed-by-connectivity"; }
        if (name === "sch_add_label") await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
        if (name === "sch_add_missing_junctions") applied = true;
        if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
        if (name === "pcb_save" && mode === "mcp-error") return { isError: true, content: [{ type: "text", text: "save rejected" }] };
        if (name === "pcb_save" && mode === "save-throw") throw new Error("save transport threw");
        if (name === "kicad_get_project_info") return { content: [], structuredContent: { result: "unusable project info" } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, {
      freshProject: fresh,
      freshConnectivityContract: LED_INDICATOR_EXAMPLE,
      capturePersistedMutationBaseline: async () => { baselineCaptures += 1; return fingerprint; },
      verifyPersistedMutation: async (value) => {
        captured.push(value);
        if (mode === "fingerprint-throw") throw new Error("fingerprint threw");
        if (["fingerprint-false", "no-save-tool", "board-fallback"].includes(mode)) return false;
        return value !== fingerprint;
      },
      captureFreshNativeNetlist: async () => {
        if (mode === "parity-throw" || mode === "duplicate-parity-throw") throw new Error("native parity threw");
        return ledNativeNetlist;
      },
    });
    if (mode === "board-fallback") await bridge.execute({ id: "board-mutation", name: "pcb_add_track", arguments: {} });
    const appliedResult = await bridge.execute({ id: `apply-${mode}`, name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(appliedResult.content)).toMatchObject({ applied: true, mutated: true });
    if (mode === "duplicate-parity-throw") {
      const duplicate = await bridge.execute({ id: "apply-duplicate", name: "fresh_apply_contract_connectivity", arguments: {} });
      expect(JSON.parse(duplicate.content)).toMatchObject({ applied: true, mutated: false, idempotent: true });
    }
    if (mode === "later-read-error" || mode === "duplicate-preflight-throw") {
      failAfterApply = true;
      const later = mode === "later-read-error"
        ? bridge.execute({ id: "later-read", name: "sch_get_bounding_boxes", arguments: {} })
        : bridge.execute({ id: "duplicate-failure", name: "fresh_apply_contract_connectivity", arguments: {} });
      await expect(later).rejects.toThrow(/FRESH_CONNECTIVITY_(?:ROLLED_BACK|ROLLBACK_FAILED)_TERMINAL/iu);
      await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
      return;
    }
    const saved = await bridge.internal.saveAfterMutation({ id: `save-${mode}`, name: "pcb_save", arguments: {} });
    expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("TERMINAL") });
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
    if (mode === "duplicate-parity-throw") expect(baselineCaptures).toBe(1);
    if (!["mcp-error", "save-throw"].includes(mode)) expect(captured[0]).toBe("before-this-mutation");
  });

  it("returns a non-mutating collision issue and succeeds after the provider moves a symbol", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "collision", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    let collision = true;
    let applied = false;
    const mutations: string[] = [];
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (["sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions"].includes(name)) mutations.push(name);
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: collision ? planarSymbols.replace("C1 100n Device:C @ (40, 20)", "C1 100n Device:C @ (20, 20)") : planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: collision
          ? boxReadback("J1 Conn 10 20 9 10 11 30\nR1 1k 20 15 19 10 21 20\nD1 LED 30 25 29 20 31 30\nC1 100n 20 20 19 19 21 30")
          : planarBoxes } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name, args.symbol_name === "C" && collision) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: applied
          ? "Group 1: +5V | pins=C1:1, J1:1, R1:1\nGroup 2: GND | pins=C1:2, D1:1, J1:2\nGroup 3: LED_A | pins=D1:2, R1:2"
          : "Group 1: ~unnamed | pins=J1:1\nGroup 2: ~unnamed | pins=J1:2\nGroup 3: ~unnamed | pins=R1:1\nGroup 4: ~unnamed | pins=R1:2\nGroup 5: ~unnamed | pins=D1:1\nGroup 6: ~unnamed | pins=D1:2\nGroup 7: ~unnamed | pins=C1:1\nGroup 8: ~unnamed | pins=C1:2" } };
        if (name === "sch_add_wire") await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`);
        if (name === "sch_add_label") await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
        if (name === "sch_add_missing_junctions") applied = true;
        if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE, verifyPersistedMutation: async () => true });
    const refused = await bridge.execute({ id: "collision", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(refused.content.length).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    expect(Buffer.byteLength(refused.content, "utf8")).toBeLessThanOrEqual(FRESH_PROVIDER_RESULT_MAX_CHARS);
    const refusedPayload = JSON.parse(refused.content) as { applied: boolean; mutated: boolean; issues: unknown[]; recommendedMoves?: unknown[]; recommendationIdentity?: { digest?: string }; targetPlacements?: unknown[]; recommendationInstruction?: string; searchEvidence?: { status?: string } };
    expect(refusedPayload).toMatchObject({ applied: false, mutated: false });
    expect(refusedPayload.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PIN_COORDINATE_COLLISION", endpoints: expect.arrayContaining(["R1:2", "C1:1"]) })]));
    const collisionIssue = refusedPayload.issues.find((issue) => (issue as { code?: unknown }).code === "PIN_COORDINATE_COLLISION") as { atMm: Record<string, unknown> };
    expect(collisionIssue.atMm).toEqual({ x: 20, y: 20 });
    expect(collisionIssue.atMm).not.toHaveProperty("angleDeg");
    expect(refusedPayload.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SYMBOL_BOUNDING_BOX_OVERLAP", endpoints: expect.arrayContaining(["R1", "C1"]) })]));
    expect(refusedPayload.recommendedMoves?.length).toBeGreaterThan(0);
    expect(refusedPayload.recommendationIdentity?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(refusedPayload.targetPlacements).toHaveLength(4);
    expect(refusedPayload.recommendationInstruction).toMatch(/fresh_apply_recommended_schematic_placement.*recommendationIdentity/iu);
    expect(refusedPayload.searchEvidence).toMatchObject({ status: "found" });
    expect(mutations).toEqual([]);
    collision = false;
    const retried = await bridge.execute({ id: "retry", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(retried.content)).toMatchObject({ applied: true, mutated: true, issues: [] });
  });

  it("enforces a multi-symbol recommendation as one identity-bound atomic placement transaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "atomic-placement", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const centers = new Map<string, { x: number; y: number }>(["J1", "R1", "D1", "C1"].map((reference) => [reference, { x: 50.8, y: 50.8 }]));
    const definitions = {
      J1: { value: "Conn", library: "Connector_Generic", symbol: "Conn_01x02", pins: [[-5.08, 0], [-5.08, 2.54]] },
      R1: { value: "1k", library: "Device", symbol: "R", pins: [[0, -3.81], [0, 3.81]] },
      D1: { value: "LED", library: "Device", symbol: "LED", pins: [[-3.81, 0], [3.81, 0]] },
      C1: { value: "100n", library: "Device", symbol: "C", pins: [[0, -3.81], [0, 3.81]] },
    } as const;
    let moveCalls = 0;
    let failMoveCall: number | undefined;
    const symbols = (): string => `Symbols (4 total):\n${[...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) => {
      const definition = definitions[reference as keyof typeof definitions];
      return `- ${reference} ${definition.value} ${definition.library}:${definition.symbol} @ (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) rot=0 unit=1`;
    }).join("\n")}`;
    const boxes = (): string => boxReadback([...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) =>
      `${reference} ${definitions[reference as keyof typeof definitions].value} ${point.x.toFixed(2)} ${point.y.toFixed(2)} ${(point.x - 10.16).toFixed(2)} ${(point.y - 7.62).toFixed(2)} ${(point.x + 10.16).toFixed(2)} ${(point.y + 7.62).toFixed(2)}`,
    ).join("\n"));
    const pinText = (reference: string): string => {
      const point = centers.get(reference)!;
      return definitions[reference as keyof typeof definitions].pins.map(([dx, dy], index) => `- Pin ${index + 1}: (${(point.x + dx).toFixed(2)}, ${(point.y + dy).toFixed(2)}) mm`).join("\n");
    };
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: symbols() } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: boxes() } };
        if (name === "sch_get_pin_positions") {
          const reference = Object.entries(definitions).find(([, definition]) => definition.symbol === args.symbol_name)?.[0];
          return { content: [], structuredContent: { result: pinText(reference!) } };
        }
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristineLedGraph } };
        if (name === "sch_move_symbol") {
          moveCalls += 1;
          if (moveCalls === failMoveCall) return { isError: true, content: [{ type: "text", text: "move rejected" }] };
          const reference = String(args.reference);
          centers.set(reference, { x: Number(args.x_mm), y: Number(args.y_mm) });
          await appendSchematicForm(fresh.schematicPath, `(text "moved-${reference}-${moveCalls}" (at 1 1 0))`);
          return { content: [], structuredContent: { result: "The schematic was updated." } };
        }
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE, verifyPersistedMutation: async () => true });

    const recommendation = JSON.parse((await bridge.execute({ id: "recommend", name: "fresh_apply_contract_connectivity", arguments: {} })).content) as {
      recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string }; recommendedMoves: { reference: string; xMm: number; yMm: number; rotationDeg: number }[]; targetPlacements: unknown[];
      searchEvidence: { rotationPolicy: string; configurationsEvaluated: number; segmentChecks: number };
    };
    expect(recommendation.recommendedMoves.length).toBeGreaterThanOrEqual(2);
    expect(recommendation.recommendedMoves.every((move) => move.rotationDeg === 0)).toBe(true);
    expect(recommendation.targetPlacements).toHaveLength(4);
    expect(recommendation.searchEvidence).toMatchObject({ rotationPolicy: "current-only" });
    expect(recommendation.searchEvidence.configurationsEvaluated).toBeGreaterThan(125);
    expect(recommendation.searchEvidence.configurationsEvaluated).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxConfigurations);
    expect(recommendation.searchEvidence.segmentChecks).toBeLessThanOrEqual(FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxSegmentChecks);
    await expect(bridge.execute({ id: "raw-partial", name: "sch_move_symbol", arguments: { reference: recommendation.recommendedMoves[0]!.reference, x_mm: recommendation.recommendedMoves[0]!.xMm, y_mm: recommendation.recommendedMoves[0]!.yMm } })).rejects.toThrow(/complete host placement recommendation is pending/iu);
    expect(moveCalls).toBe(0);
    await expect(bridge.execute({ id: "substitute", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: { ...recommendation.recommendationIdentity, digest: "f".repeat(64) } } })).rejects.toThrow(/does not exactly match/iu);
    expect(moveCalls).toBe(0);
    const firstBaseline = await readFile(fresh.schematicPath, "utf8");
    const concurrentRaw = await Promise.allSettled([
      bridge.execute({ id: "atomic", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: recommendation.recommendationIdentity } }),
      bridge.execute({ id: "same-batch-raw", name: "sch_move_symbol", arguments: { reference: "C1", x_mm: 25.4, y_mm: 25.4 } }),
    ]);
    expect(concurrentRaw[0]).toMatchObject({ status: "fulfilled", value: { content: expect.stringContaining('"mutated":true') } });
    expect(concurrentRaw[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL/iu) }) });
    expect(moveCalls).toBe(recommendation.recommendedMoves.length);
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(firstBaseline);

    centers.forEach((_point, reference) => centers.set(reference, { x: 50.8, y: 50.8 }));
    moveCalls = 0;
    const hostRaceRecommendation = JSON.parse((await bridge.execute({ id: "recommend-host-race", name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string }; recommendedMoves: unknown[] };
    const hostRaceBaseline = await readFile(fresh.schematicPath, "utf8");
    const concurrentHost = await Promise.allSettled([
      bridge.execute({ id: "atomic-host-race", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: hostRaceRecommendation.recommendationIdentity } }),
      bridge.execute({ id: "queued-host", name: "fresh_apply_contract_connectivity", arguments: {} }),
    ]);
    expect(concurrentHost[0]).toMatchObject({ status: "fulfilled", value: { content: expect.stringContaining('"mutated":true') } });
    expect(concurrentHost[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL/iu) }) });
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(hostRaceBaseline);

    centers.forEach((_point, reference) => centers.set(reference, { x: 50.8, y: 50.8 }));
    moveCalls = 0;
    const committedRecommendation = JSON.parse((await bridge.execute({ id: "recommend-commit", name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string }; recommendedMoves: unknown[] };
    await bridge.execute({ id: "atomic-commit", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: committedRecommendation.recommendationIdentity } });
    await expect(bridge.internal.saveAfterMutation({ id: "save-atomic", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    await bridge.internal.execute({ id: "readback-atomic", name: "sch_get_connectivity_graph", arguments: {} });
    await expect(bridge.execute({ id: "replay", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: committedRecommendation.recommendationIdentity } })).rejects.toThrow(/stale, replayed, or unbound/iu);

    // A fresh pending plan whose second sidecar move fails restores exact disk
    // bytes and terminates, because the sidecar's in-memory reload is unproven.
    const failureBaseline = await readFile(fresh.schematicPath, "utf8");
    centers.forEach((_point, reference) => centers.set(reference, { x: 50.8, y: 50.8 }));
    moveCalls = 0;
    const retryRecommendation = JSON.parse((await bridge.execute({ id: "recommend-failure", name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string }; recommendedMoves: unknown[] };
    expect(retryRecommendation.recommendedMoves.length).toBeGreaterThanOrEqual(2);
    failMoveCall = 2;
    await expect(bridge.execute({ id: "atomic-failure", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: retryRecommendation.recommendationIdentity } })).rejects.toThrow(/FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(failureBaseline);
  });

  it("invalidates a stale recommendation before any atomic placement mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "stale-placement", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    let stale = false;
    let moves = 0;
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: stale ? planarSymbols.replace("J1 Conn Connector_Generic:Conn_01x02 @ (10, 20)", "J1 Conn Connector_Generic:Conn_01x02 @ (12.54, 20)") : planarSymbols.replace("C1 100n Device:C @ (40, 20)", "C1 100n Device:C @ (20, 20)") } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: stale ? planarBoxes.replace("J1 Conn 10 20 9 10 11 30", "J1 Conn 12.54 20 11.54 10 13.54 30") : boxReadback("J1 Conn 10 20 9 10 11 30\nR1 1k 20 15 19 10 21 20\nD1 LED 30 25 29 20 31 30\nC1 100n 20 20 19 19 21 30") } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name, args.symbol_name === "C" && !stale) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristineLedGraph } };
        if (name === "sch_move_symbol") moves += 1;
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const recommendation = JSON.parse((await bridge.execute({ id: "recommend-stale", name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string } };
    stale = true;
    const result = await bridge.execute({ id: "apply-stale", name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: recommendation.recommendationIdentity } });
    expect(JSON.parse(result.content)).toMatchObject({ applied: false, mutated: false, issues: [expect.objectContaining({ code: "STALE_PLACEMENT_RECOMMENDATION" })] });
    expect(moves).toBe(0);
  });

  it.each([
    ["wire", "(wire (pts (xy 1 1) (xy 2 1)))"],
    ["label", "(label \"DRIFT\" (at 1 1 0))"],
    ["junction", "(junction (at 1 1) (diameter 0) (color 0 0 0 0))"],
    ["no-connect", "(no_connect (at 1 1))"],
    ["property", "(property \"Value\" \"drift\" (at 1 1 0))"],
  ] as const)("binds a recommendation to exact source bytes and rejects %s drift before mutation", async (_kind, driftForm) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "source-drift", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    let moves = 0;
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols.replace("C1 100n Device:C @ (40, 20)", "C1 100n Device:C @ (20, 20)") } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: boxReadback("J1 Conn 10 20 9 10 11 30\nR1 1k 20 15 19 10 21 20\nD1 LED 30 25 29 20 31 30\nC1 100n 20 20 19 19 21 30") } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name, args.symbol_name === "C") } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristineLedGraph } };
        if (name === "sch_move_symbol") moves += 1;
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const recommendation = JSON.parse((await bridge.execute({ id: `recommend-${_kind}`, name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string }; startingSchematicSha256: string };
    expect(recommendation.startingSchematicSha256).toMatch(/^[a-f0-9]{64}$/u);
    await appendSchematicForm(fresh.schematicPath, driftForm);
    const result = await bridge.execute({ id: `apply-${_kind}`, name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: recommendation.recommendationIdentity } });
    expect(JSON.parse(result.content)).toMatchObject({ applied: false, mutated: false, issues: [expect.objectContaining({ code: "STALE_PLACEMENT_RECOMMENDATION" })] });
    expect(moves).toBe(0);
  });

  it.each(["save-mcp-error", "fingerprint-false", "fingerprint-throw", "readback-error"] as const)("restores the pre-placement bytes when atomic placement commit hits %s", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, mode), name: "placement-save", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const baseline = await readFile(fresh.schematicPath, "utf8");
    const centers = new Map([
      ["J1", { x: 50.8, y: 25.4 }], ["R1", { x: 50.8, y: 25.4 }],
      ["D1", { x: 76.2, y: 50.8 }], ["C1", { x: 101.6, y: 76.2 }],
    ]);
    const symbolInfo = {
      J1: ["Conn", "Connector_Generic", "Conn_01x02"], R1: ["1k", "Device", "R"],
      D1: ["LED", "Device", "LED"], C1: ["100n", "Device", "C"],
    } as const;
    let failReadback = false;
    const symbols = (): string => `Symbols (4 total):\n${[...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) => {
      const [value, library, symbol] = symbolInfo[reference as keyof typeof symbolInfo];
      return `- ${reference} ${value} ${library}:${symbol} @ (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) rot=0 unit=1`;
    }).join("\n")}`;
    const boxes = (): string => boxReadback([...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) =>
      `${reference} x ${point.x.toFixed(2)} ${point.y.toFixed(2)} ${(point.x - 10.16).toFixed(2)} ${(point.y - 7.62).toFixed(2)} ${(point.x + 10.16).toFixed(2)} ${(point.y + 7.62).toFixed(2)}`,
    ).join("\n"));
    const pinsFor = (symbol: unknown): string => {
      const reference = Object.entries(symbolInfo).find(([, info]) => info[2] === symbol)![0];
      const point = centers.get(reference)!;
      const offsets = reference === "J1" ? [[-5.08, 0], [-5.08, 2.54]] : reference === "D1" ? [[-3.81, 0], [3.81, 0]] : [[0, -3.81], [0, 3.81]];
      return offsets.map(([dx, dy], index) => `- Pin ${index + 1}: (${(point.x + dx!).toFixed(2)}, ${(point.y + dy!).toFixed(2)}) mm`).join("\n");
    };
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc", "pcb_save"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: symbols() } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: boxes() } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: pinsFor(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return failReadback
          ? { isError: true, content: [{ type: "text", text: "readback rejected" }] }
          : { content: [], structuredContent: { result: pristineLedGraph } };
        if (name === "sch_move_symbol") {
          centers.set(String(args.reference), { x: Number(args.x_mm), y: Number(args.y_mm) });
          await appendSchematicForm(fresh.schematicPath, `(text "atomic-move" (at 1 1 0))`);
        }
        if (name === "pcb_save" && mode === "save-mcp-error") return { isError: true, content: [{ type: "text", text: "save rejected" }] };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, {
      freshProject: fresh,
      freshConnectivityContract: LED_INDICATOR_EXAMPLE,
      capturePersistedMutationBaseline: async () => "before-placement",
      verifyPersistedMutation: async () => {
        if (mode === "fingerprint-throw") throw new Error("fingerprint failed");
        return mode !== "fingerprint-false";
      },
    });
    const recommendation = JSON.parse((await bridge.execute({ id: `recommend-${mode}`, name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string } };
    await bridge.execute({ id: `atomic-${mode}`, name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: recommendation.recommendationIdentity } });
    const saved = await bridge.internal.saveAfterMutation({ id: `save-${mode}`, name: "pcb_save", arguments: {} });
    if (mode === "readback-error") {
      expect(saved.isError).not.toBe(true);
      failReadback = true;
      await expect(bridge.internal.execute({ id: "mandatory-readback", name: "sch_get_connectivity_graph", arguments: {} })).rejects.toThrow(/FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL/iu);
    } else {
      expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("FRESH_CONNECTIVITY_PLACEMENT") });
    }
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
  });

  it.each(["value", "footprint", "missing-footprint"] as const)("rolls back atomic placement when post-move %s metadata drifts", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, mode), name: "placement-metadata", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const baseline = await readFile(fresh.schematicPath, "utf8");
    const centers = new Map([
      ["J1", { x: 50.8, y: 25.4 }], ["R1", { x: 50.8, y: 25.4 }],
      ["D1", { x: 76.2, y: 50.8 }], ["C1", { x: 101.6, y: 76.2 }],
    ]);
    const symbolInfo = {
      J1: { value: "Conn_01x02", library: "Connector_Generic", symbol: "Conn_01x02", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
      R1: { value: "1k", library: "Device", symbol: "R", footprint: "Resistor_SMD:R_0603_1608Metric" },
      D1: { value: "LED", library: "Device", symbol: "LED", footprint: "LED_SMD:LED_0603_1608Metric" },
      C1: { value: "100nF", library: "Device", symbol: "C", footprint: "Capacitor_SMD:C_0603_1608Metric" },
    } as const;
    let moved = false;
    const symbols = (): string => `Symbols (4 total):\n${[...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) => {
      const info = symbolInfo[reference as keyof typeof symbolInfo];
      const value = moved && reference === "J1" && mode === "value" ? "DRIFT" : info.value;
      const footprint = moved && reference === "J1" && mode === "footprint" ? "Connector_PinHeader_2.54mm:Wrong" : info.footprint;
      const suffix = moved && reference === "J1" && mode === "missing-footprint" ? "" : ` footprint=${footprint}`;
      return `- ${reference} ${value} ${info.library}:${info.symbol} @ (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) rot=0 unit=1${suffix}`;
    }).join("\n")}`;
    const boxes = (): string => boxReadback([...centers].sort(([left], [right]) => left.localeCompare(right)).map(([reference, point]) =>
      `${reference} x ${point.x.toFixed(2)} ${point.y.toFixed(2)} ${(point.x - 10.16).toFixed(2)} ${(point.y - 7.62).toFixed(2)} ${(point.x + 10.16).toFixed(2)} ${(point.y + 7.62).toFixed(2)}`,
    ).join("\n"));
    const pinsFor = (symbol: unknown): string => {
      const reference = Object.entries(symbolInfo).find(([, info]) => info.symbol === symbol)![0];
      const point = centers.get(reference)!;
      const offsets = reference === "J1" ? [[-5.08, 0], [-5.08, 2.54]] : reference === "D1" ? [[-3.81, 0], [3.81, 0]] : [[0, -3.81], [0, 3.81]];
      return offsets.map(([dx, dy], index) => `- Pin ${index + 1}: (${(point.x + dx!).toFixed(2)}, ${(point.y + dy!).toFixed(2)}) mm`).join("\n");
    };
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: symbols() } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: boxes() } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: pinsFor(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristineLedGraph } };
        if (name === "sch_move_symbol") {
          centers.set(String(args.reference), { x: Number(args.x_mm), y: Number(args.y_mm) });
          moved = true;
          await appendSchematicForm(fresh.schematicPath, `(text "metadata-drift" (at 1 1 0))`);
        }
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const recommendation = JSON.parse((await bridge.execute({ id: `recommend-${mode}`, name: "fresh_apply_contract_connectivity", arguments: {} })).content) as { recommendationIdentity: { algorithm: string; digest: string; schemaVersion: string; canonicalizationVersion: string } };
    await expect(bridge.execute({ id: `atomic-${mode}`, name: "fresh_apply_recommended_schematic_placement", arguments: { recommendationIdentity: recommendation.recommendationIdentity } })).rejects.toThrow(/FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
  });

  it("locks the LED-proof3 angle metadata leak to a pre-mutation historical result", async () => {
    const report = JSON.parse(await readFile(new URL("../fixtures/fresh-project/angle-metadata-leak.report.json", import.meta.url), "utf8")) as {
      summary: string;
      harness: { operations: { iteration: number; name: string; result?: { content?: string } }[] };
    };
    expect(report.summary).toContain('Unrecognized key: "angleDeg"');
    const operation = report.harness.operations.find((entry) => entry.name === "fresh_apply_contract_connectivity");
    expect(operation).toBeDefined();
    const historical = JSON.parse(operation!.result!.content!) as { applied: boolean; mutated: boolean; issues: { code: string; atMm?: Record<string, unknown> }[] };
    expect(historical).toMatchObject({ applied: false, mutated: false });
    expect(historical.issues.find((issue) => issue.code === "PIN_COORDINATE_COLLISION")?.atMm).toMatchObject({ angleDeg: 270 });
    const mutationNames = new Set(["sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions"]);
    expect(report.harness.operations.filter((entry) => entry.iteration === operation!.iteration && mutationNames.has(entry.name))).toEqual([]);
  });

  it("refuses an endpoint escape corridor that crosses an unrelated contract pin before mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "blockedplan", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const mutations: string[] = [];
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (["sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions"].includes(name)) mutations.push(name);
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: boxReadback("J1 Conn 10 20 9 10 11 30\nR1 1k 20 15 19 10 21 20\nD1 LED 30 25 29 20 31 30\nC1 100n 40 15 39 0 41 30") } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: args.symbol_name === "LED" ? "- Pin 1: (40, 5) mm\n- Pin 2: (30, 20) mm" : planarPinReadback(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristineLedGraph } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const result = await bridge.execute({ id: "blocked-plan", name: "fresh_apply_contract_connectivity", arguments: {} });
    const payload = JSON.parse(result.content) as { applied: boolean; mutated: boolean; issues: unknown[] };
    expect(payload).toMatchObject({ applied: false, mutated: false });
    expect(payload.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NO_PROVEN_COLLISION_FREE_WIRE_PLAN" })]));
    expect(payload.issues.filter((issue) => (issue as { code?: unknown }).code === "NO_PROVEN_COLLISION_FREE_WIRE_PLAN").length).toBeGreaterThanOrEqual(2);
    expect(mutations).toEqual([]);
  });

  it("restores the exact disk preimage and terminates after post-mutation readback or ERC failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const makeBridge = async (mode: "readback" | "erc") => {
      const fresh = await prepareFreshProject({ outputDir: path.join(root, mode), name: mode, resume: false });
      await writeFile(fresh.schematicPath, embeddedLedSchematic());
      let applied = false;
      const baseline = await readFile(fresh.schematicPath, "utf8");
      const bridge = createKicadHarnessTools({
        ...fakePrivatePorts,
        listTools: () => ["kicad_set_project", "sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
        callTool: async (name, args = {}) => {
          if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
          if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: planarBoxes } };
          if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name) } };
          if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: applied
            ? mode === "readback" ? "Group 1: +5V | pins=J1:1, R1:1, C1:1, D1:1\nGroup 2: LED_A | pins=R1:2, D1:2\nGroup 3: GND | pins=J1:2, C1:2"
              : "Group 1: +5V | pins=C1:1, J1:1, R1:1\nGroup 2: GND | pins=C1:2, D1:1, J1:2\nGroup 3: LED_A | pins=D1:2, R1:2"
            : "Group 1: ~unnamed | pins=J1:1\nGroup 2: ~unnamed | pins=J1:2\nGroup 3: ~unnamed | pins=R1:1\nGroup 4: ~unnamed | pins=R1:2\nGroup 5: ~unnamed | pins=D1:1\nGroup 6: ~unnamed | pins=D1:2\nGroup 7: ~unnamed | pins=C1:1\nGroup 8: ~unnamed | pins=C1:2" } };
          if (name === "sch_add_wire") await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`);
          if (name === "sch_add_label") await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
          if (name === "sch_add_missing_junctions") applied = true;
          if (name === "kicad_set_project") applied = false;
          if (name === "run_erc") return { content: [], structuredContent: { status: "failed", findings: [{ message: "pin conflict" }], metadata: { violation_count: 1 } } };
          return { content: [], structuredContent: { result: "ok" } };
        },
      }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
      return { bridge, fresh, baseline };
    };
    const wrong = await makeBridge("readback");
    await expect(wrong.bridge.execute({ id: "wrong", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL.*NET_ENDPOINT_MISMATCH/iu);
    await expect(readFile(wrong.fresh.schematicPath, "utf8")).resolves.toBe(wrong.baseline);
    const erc = await makeBridge("erc");
    await expect(erc.bridge.execute({ id: "erc", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL.*ERC_NOT_CLEAN/iu);
    await expect(readFile(erc.fresh.schematicPath, "utf8")).resolves.toBe(erc.baseline);
  });

  it.each(["second-wire-error", "semantic-warning", "wrong-persisted-segment", "label-warning", "junction-warning"] as const)("atomically restores a partial schematic after %s", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "partial", resume: false });
    await writeFile(fresh.schematicPath, embeddedLedSchematic());
    const baseline = await readFile(fresh.schematicPath, "utf8");
    let wireCalls = 0;
    let labelCalls = 0;
    const pristine = "Group 1: ~unnamed | pins=J1:1\nGroup 2: ~unnamed | pins=J1:2\nGroup 3: ~unnamed | pins=R1:1\nGroup 4: ~unnamed | pins=R1:2\nGroup 5: ~unnamed | pins=D1:1\nGroup 6: ~unnamed | pins=D1:2\nGroup 7: ~unnamed | pins=C1:1\nGroup 8: ~unnamed | pins=C1:2";
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name, args = {}) => {
        if (name === "sch_get_symbols") return { content: [], structuredContent: { result: planarSymbols } };
        if (name === "sch_get_bounding_boxes") return { content: [], structuredContent: { result: planarBoxes } };
        if (name === "sch_get_pin_positions") return { content: [], structuredContent: { result: planarPinReadback(args.symbol_name) } };
        if (name === "sch_get_connectivity_graph") return { content: [], structuredContent: { result: pristine } };
        if (name === "sch_add_wire") {
          wireCalls += 1;
          if (mode === "second-wire-error" && wireCalls === 2) return { isError: true, content: [{ type: "text", text: "wire rejected" }] };
          const wrong = mode === "wrong-persisted-segment" && wireCalls === 1;
          await appendSchematicForm(fresh.schematicPath, `(wire (pts (xy ${wrong ? "999" : String(args.x1_mm)} ${String(args.y1_mm)}) (xy ${String(args.x2_mm)} ${String(args.y2_mm)})))`);
          return { content: [], structuredContent: { result: mode === "semantic-warning" && wireCalls === 1 ? "WARNING: obstacle_bypass_failed" : "The schematic was updated." } };
        }
        if (name === "sch_add_label") {
          labelCalls += 1;
          await appendSchematicForm(fresh.schematicPath, `(label "${String(args.name)}" (at ${String(args.x_mm)} ${String(args.y_mm)} 0))`);
          if (mode === "label-warning" && labelCalls === 1) return { content: [], structuredContent: { result: "WARNING: label placement uncertain" } };
        }
        if (name === "sch_add_missing_junctions" && mode === "junction-warning") return { content: [], structuredContent: { result: "WARNING: junction insertion uncertain" } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    await expect(bridge.execute({ id: mode, name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(fresh.schematicPath, "utf8")).resolves.toBe(baseline);
    if (["second-wire-error", "semantic-warning", "wrong-persisted-segment"].includes(mode)) {
      expect(wireCalls).toBe(mode === "second-wire-error" ? 2 : 1);
      expect(labelCalls).toBe(0);
    } else expect(labelCalls).toBe(mode === "label-warning" ? 1 : 3);
  });

  it("returns a non-mutating issue when an embedded contract library definition is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const fresh = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "missing-lib", resume: false });
    const bridge = createKicadHarnessTools({
      ...fakePrivatePorts,
      listTools: () => ["sch_get_symbols", "sch_get_connectivity_graph", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc"].map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name) => name === "sch_get_symbols"
        ? { content: [], structuredContent: { result: "" } }
        : { content: [], structuredContent: { status: "clean", findings: [] } },
    }, { freshProject: fresh, freshConnectivityContract: LED_INDICATOR_EXAMPLE });
    const result = await bridge.execute({ id: "missing-lib", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(result.content)).toMatchObject({ applied: false, mutated: false, issues: expect.arrayContaining([expect.objectContaining({ code: "MISSING_EMBEDDED_LIBRARY_SYMBOL" })]) });
  });

  it("releases only a standalone non-mutating compound baseline and preserves an earlier real mutation baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const makeBridge = async (name: string) => {
      const fresh = await prepareFreshProject({ outputDir: path.join(root, name), name, resume: false });
      let fingerprint = `${name}-initial`;
      const captures: string[] = [];
      const verifies: (string | undefined)[] = [];
      const bridge = createKicadHarnessTools({
        ...fakePrivatePorts,
        listTools: () => [...new Set([...KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, "pcb_save"])].map((tool) => ({ name: tool, permission: "write" as const, inputSchema: { type: "object" } })),
        callTool: async (tool) => {
          if (tool === "sch_get_symbols") return { content: [], structuredContent: { result: "" } };
          if (tool === "sch_add_symbol") fingerprint = `${name}-after-real`;
          return { content: [], structuredContent: { result: "ok" } };
        },
      }, {
        freshProject: fresh,
        freshConnectivityContract: LED_INDICATOR_EXAMPLE,
        capturePersistedMutationBaseline: async () => { captures.push(fingerprint); return fingerprint; },
        verifyPersistedMutation: async (baseline) => { verifies.push(baseline); return baseline !== fingerprint; },
      });
      return { bridge, captures, verifies };
    };

    const standalone = await makeBridge("standalone");
    const early = await standalone.bridge.execute({ id: "early", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(early.content)).toMatchObject({ applied: false, mutated: false });
    await standalone.bridge.execute({ id: "real", name: "sch_add_symbol", arguments: { library: "Device", symbol_name: "R", x_mm: 1, y_mm: 1, reference: "R1", value: "1k" } });
    await expect(standalone.bridge.internal.saveAfterMutation({ id: "save-real", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(standalone.captures).toEqual(["standalone-initial", "standalone-initial"]);
    expect(standalone.verifies).toEqual(["standalone-initial"]);

    const batched = await makeBridge("batched");
    await batched.bridge.execute({ id: "real-first", name: "sch_add_symbol", arguments: { library: "Device", symbol_name: "R", x_mm: 1, y_mm: 1, reference: "R1", value: "1k" } });
    const nonMutating = await batched.bridge.execute({ id: "early-second", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(nonMutating.content)).toMatchObject({ applied: false, mutated: false });
    await expect(batched.bridge.internal.saveAfterMutation({ id: "save-batch", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(batched.captures).toEqual(["batched-initial"]);
    expect(batched.verifies).toEqual(["batched-initial"]);
  });

  it("parses new-project only as a mutually exclusive prepare/resume path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-")); owned.add(root);
    const output = path.join(root, "output");
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--output-dir", output, "--prepare"])).resolves.toMatchObject({ newProjectName: "canary", mode: "prepare" });
    await expect(parsePcbAgentCliArgs(["--new-project", "canary", "--output-dir", output, "--checkpoint-open"])).resolves.toMatchObject({ newProjectName: "canary", mode: "checkpoint-open" });
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--output-dir", output, "--iterations", "12", "--prepare"])).resolves.toMatchObject({ iterations: 12 });
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--output-dir", output, "--iterations", "24", "--prepare"])).resolves.toMatchObject({ iterations: 24 });
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--output-dir", output, "--iterations", "25", "--prepare"])).rejects.toThrow(/1 through 24/u);
    await expect(parsePcbAgentCliArgs(["--workflow", "copied_project", "--prompt", "x", "--model", "m", "--project-dir", root, "--output-dir", output, "--iterations", "6"])).rejects.toThrow(/1 through 5/u);
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--project-dir", root, "--output-dir", output, "--prepare"])).rejects.toThrow(/exactly one/i);
    await expect(parsePcbAgentCliArgs(["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m", "--new-project", "canary", "--output-dir", output])).rejects.toThrow(/requires --prepare/i);
  });
});
