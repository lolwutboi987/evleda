import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import type { CanonicalIdentity } from "../../src/domain/types.js";
import {
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  createKicadHarnessTools,
  prepareFreshProject,
  type KicadHarnessSession,
} from "../../src/harness/index.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import type { FreshSyncBoardComparisonDiagnostic, FreshSyncFailureDiagnostic } from "../../src/harness/kicad-tools.js";
import { writeToolboxSyncDiagnostic } from "../../src/mcp/toolbox-sync-diagnostics.js";
import type { HarnessProviderTurn, HarnessToolPort, HarnessToolResult } from "../../src/harness/contracts.js";
import { runPcbAgentHarness } from "../../src/harness/pcb-agent-harness.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import {
  createGenericBundleFixture,
  createGenericDividerBundleFixture,
  genericDividerDraft,
} from "../helpers/generic-divider-bundle.js";

const owned = new Set<string>();
const capturedBoard = JSON.parse(await readFile(new URL("../fixtures/fresh-project/authored-netclass-board-serialization.json", import.meta.url), "utf8")) as { diskUtf8Base64: string; liveUtf8Base64: string };
const capturedTimestamp = JSON.parse(await readFile(new URL("../fixtures/fresh-project/authored-netclass-native-timestamp.json", import.meta.url), "utf8")) as { beforeUtf8Base64: string; beforeDate: string; afterDate: string; beforeRawSha256: string; afterRawSha256: string };
const capturedNativeBefore = Buffer.from(capturedTimestamp.beforeUtf8Base64, "base64").toString("utf8");
const capturedSync = JSON.parse(await readFile(new URL("../fixtures/fresh-project/authored-netclass-sync-response.json", import.meta.url), "utf8")) as { resultSha256: string; receivedResult: CallToolResult };
const capturedSyncText = String((capturedSync.receivedResult.structuredContent as Readonly<{ result: string }>).result);
afterEach(async () => {
  for (const directory of [...owned]) {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }
});

const IDS = Object.freeze({
  vinBad: "11111111-1111-4111-8111-111111111111",
  voutA: "22222222-2222-4222-8222-222222222222",
  voutB: "33333333-3333-4333-8333-333333333333",
  gnd: "44444444-4444-4444-8444-444444444444",
});

interface TrackSpec {
  readonly id: string;
  readonly net: "VIN" | "VOUT" | "GND";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly layer?: "F.Cu" | "B.Cu";
}

const footprint = (
  library: string,
  reference: string,
  value: string,
  x: number,
  y: number,
  pads: readonly { readonly number: string; readonly x: number; readonly y: number; readonly net: string | null; readonly layers?: readonly string[] }[],
  options: Readonly<{ readonly layer?: "F.Cu" | "B.Cu"; readonly rotation?: number }> = {},
): string => {
  const referenceOrdinal = reference === "J1" ? 1 : reference === "R1" ? 2 : reference === "R2" ? 3 : 9;
  return `  (footprint "${library}"
    (layer "${options.layer ?? "F.Cu"}")
    (uuid "aaaaaaaa-aaaa-4aaa-8aaa-${String(referenceOrdinal).padStart(12, "0")}")
    (at ${x} ${y} ${options.rotation ?? 0})
    (property "Reference" "${reference}")
    (property "Value" "${value}")
${pads.map((pad, index) => `    (pad "${pad.number}" smd rect (at ${pad.x} ${pad.y}) (size 1 1) (layers ${(pad.layers ?? ["F.Cu"]).map((layer) => `"${layer}"`).join(" ")})${pad.net === null ? "" : ` (net "${pad.net}")`} (uuid "bbbbbbbb-bbbb-4bbb-8bbb-${String(referenceOrdinal * 100 + index + 1).padStart(12, "0")}"))`).join("\n")}
  )`;
};

const populatedBoard = (
  tracks: readonly TrackSpec[] = [
    { id: IDS.vinBad, net: "VIN", x1: 2, y1: 5, x2: 6, y2: 5 },
    { id: IDS.voutA, net: "VOUT", x1: 2, y1: 7, x2: 10, y2: 7 },
    { id: IDS.voutB, net: "VOUT", x1: 10, y1: 7, x2: 18, y2: 7 },
    { id: IDS.gnd, net: "GND", x1: 2, y1: 9, x2: 18, y2: 9 },
  ],
  bareLibraries = false,
): string => `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
${footprint(bareLibraries ? "PinHeader_1x03_P2.54mm_Vertical" : "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "J1", "DIVIDER_IO", 2, 5, [
    { number: "1", x: 0, y: 0, net: "VIN" }, { number: "2", x: 0, y: 2, net: "VOUT" },
    { number: "3", x: 0, y: 4, net: "GND" },
  ])}
${footprint(bareLibraries ? "R_0603_1608Metric" : "Resistor_SMD:R_0603_1608Metric", "R1", "10k", 10, 5, [
    { number: "1", x: 0, y: 0, net: "VIN" }, { number: "2", x: 0, y: 2, net: "VOUT" },
  ])}
${footprint(bareLibraries ? "R_0603_1608Metric" : "Resistor_SMD:R_0603_1608Metric", "R2", "10k", 18, 7, [
    { number: "1", x: 0, y: 0, net: "VOUT" }, { number: "2", x: 0, y: 2.123456789, net: "GND" },
  ])}
${tracks.map((track) => `  (segment (start ${track.x1} ${track.y1}) (end ${track.x2} ${track.y2}) (width 0.25) (layer "${track.layer ?? "F.Cu"}") (net "${track.net}") (uuid "${track.id}"))`).join("\n")}
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no)
)
`;

const emptyBoard = (): string => `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no)
)
`;

const schematicSource = (): string => `(kicad_sch
  (version 20250316)
  (generator "fixture")
  (global_label "VIN" (shape passive) (at 10 10 0))
  (global_label "VOUT" (shape passive) (at 10 12.54 0))
  (global_label "GND" (shape passive) (at 10 15.08 0))
  (symbol (lib_id "Connector_Generic:Conn_01x03") (at 10 10 0)
    (property "Reference" "J1") (property "Value" "DIVIDER_IO")
    (property "Footprint" "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical"))
  (symbol (lib_id "Device:R") (at 20 10 0)
    (property "Reference" "R1") (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric"))
  (symbol (lib_id "Device:R") (at 30 10 0)
    (property "Reference" "R2") (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric"))
)
`;

const nativeNetlist = (): string => `(export
  (design (source "divider.kicad_sch") (date "2026-09-08T21:26:04"))
  (components
    (comp (ref "J1") (value "DIVIDER_IO") (footprint "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical") (libsource (lib "Connector_Generic") (part "Conn_01x03")))
    (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0603_1608Metric") (libsource (lib "Device") (part "R")))
    (comp (ref "R2") (value "10k") (footprint "Resistor_SMD:R_0603_1608Metric") (libsource (lib "Device") (part "R"))))
  (nets
    (net (code "1") (name "VIN") (node (ref "J1") (pin "1") (pintype "passive")) (node (ref "R1") (pin "1") (pintype "passive")))
    (net (code "2") (name "VOUT") (node (ref "J1") (pin "2") (pintype "passive")) (node (ref "R1") (pin "2") (pintype "passive")) (node (ref "R2") (pin "1") (pintype "passive")))
    (net (code "3") (name "GND") (node (ref "J1") (pin "3") (pintype "passive")) (node (ref "R2") (pin "2") (pintype "passive")))))
`;

const removeUuidLine = (source: string, ids: readonly string[]): string => source
  .split(/(?<=\n)/u)
  .filter((line) => !ids.some((id) => line.includes(`(uuid "${id}")`)))
  .join("");

const appendBoardItem = (source: string, item: string): string => {
  const closing = source.lastIndexOf(")");
  if (closing < 0) throw new Error("Board fixture has no root close.");
  return `${source.slice(0, closing)}  ${item}\n${source.slice(closing)}`;
};

interface MockOptions {
  readonly qualifiedSync?: boolean | "missing";
  readonly syncBoard?: string;
  readonly syncText?: string;
  readonly syncResult?: CallToolResult;
  readonly failAddTrack?: boolean;
  readonly noOpDelete?: boolean;
  readonly liveTransform?: (source: string) => string;
  readonly diskTransform?: (source: string) => string;
  readonly saveTransform?: (source: string) => string;
  readonly nativeSource?: (capture: number, schematicPath: string) => string | Promise<string>;
  readonly observeFreshSyncBoardComparison?: (diagnostic: FreshSyncBoardComparisonDiagnostic) => void;
  readonly observeFreshSyncFailureDiagnostic?: (diagnostic: FreshSyncFailureDiagnostic) => void | Promise<void>;
}

const syncSuccessText = [
  "Schematic components considered: 3", "Existing PCB footprints kept: 0", "New footprints added: 3",
  "Mismatched footprints replaced: 0", "Total pads considered: 7", "Pads with named nets: 7",
  "Pads left as <no net>: 0", "Transfer quality: CLEAN (100.0% pad coverage)",
  "Fully net-mapped refs: 3", "Partially net-mapped refs: 0", "Refs with unresolved pad nets: (none)",
  "The PCB file was updated and KiCad was asked to reload it.",
].join("\n");

function mockSession(pcbPath: string, initial: string, options: MockOptions = {}) {
  const toLive = options.liveTransform ?? ((source: string) => source);
  const toDisk = options.diskTransform ?? ((source: string) => source);
  let live = toLive(initial);
  let transactionPreimage: string | undefined;
  let newId = 0;
  const calls: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }[] = [];
  const privateCalls: { readonly name: string; readonly expectedPath: string }[] = [];
  const session: KicadHarnessSession = {
    supportsNativeRouteTransactions:()=>true,
    supportsQualifiedFootprintIdentitySync:()=>true,
    assertActivePcb: async (expectedPath) => {
      privateCalls.push({ name: "assertActivePcb", expectedPath });
      if (expectedPath !== pcbPath) throw new Error("Active PCB path mismatch.");
    },
    readActivePcbSource: async (expectedPath) => {
      privateCalls.push({ name: "readActivePcbSource", expectedPath });
      if (expectedPath !== pcbPath) throw new Error("Active PCB path mismatch.");
      return live;
    },
    listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter((name) => name !== "evleda_get_live_pcb_document").map((name) => ({
      name, permission: "write" as const, description: name, inputSchema: { type: "object", additionalProperties: true },
    })),
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      let result = "ok";
      if (name === "pcb_get_board_as_string") throw new Error("Public sanitized PCB source is not an authority port.");
      if (name === "kicad_get_project_info") return { content: [], structuredContent: { result: `Current project configuration:\n- PCB file: ${pcbPath}` } };
      if (name === "pcb_begin_commit") { transactionPreimage = live; result = "Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard."; }
      else if (name === "pcb_drop_commit") { live = transactionPreimage ?? live; transactionPreimage = undefined; result = "Transaction group discarded successfully."; }
      else if (name === "pcb_push_commit") { transactionPreimage = undefined; result = "Transaction group committed successfully."; }
      else if (name === "pcb_delete_items") {
        const ids = args.item_ids as readonly string[];
        if (options.noOpDelete) result = `Deletion of ${ids.length} item(s) staged in active transaction.`;
        else {
          const next = removeUuidLine(live, ids);
          if (next === live) result = "Failed to delete items: no matching UUID.";
          else { live = next; result = `Deletion of ${ids.length} item(s) staged in active transaction.`; }
        }
      } else if (name === "pcb_add_track") {
        if (options.failAddTrack) result = "Failed to add track: injected failure.";
        else {
          newId += 1;
          const id = `90000000-0000-4000-8000-${String(newId).padStart(12, "0")}`;
          live = appendBoardItem(live, `(segment (start ${args.x1_mm} ${args.y1_mm}) (end ${args.x2_mm} ${args.y2_mm}) (width ${args.width_mm}) (layer "${String(args.layer).replace("_", ".")}") (net "${args.net_name}") (uuid "${id}"))`);
          result = "Track staged in active transaction.";
        }
      } else if (name === "pcb_add_via") {
        newId += 1;
        const id = `91000000-0000-4000-8000-${String(newId).padStart(12, "0")}`;
        live = appendBoardItem(live, `(via (at ${args.x_mm} ${args.y_mm}) (size ${args.diameter_mm}) (drill ${args.drill_mm}) (layers "F.Cu" "B.Cu") (net "${args.net_name}") (uuid "${id}"))`);
        result = "Via staged in active transaction.";
      } else if (name === "pcb_sync_from_schematic") {
        if (options.syncBoard !== undefined) {
          live = toLive(options.syncBoard);
          await writeFile(pcbPath, toDisk(live), "utf8");
        }
        result = options.syncText ?? syncSuccessText;
        if (options.syncResult !== undefined) return structuredClone(options.syncResult);
      } else if (name === "pcb_save") {
        live = options.saveTransform?.(live) ?? live;
        await writeFile(pcbPath, toDisk(live), "utf8");
        result = "Board saved.";
      } else if (name === "pcb_revert") {
        live = toLive(await readFile(pcbPath, "utf8"));
        transactionPreimage = undefined;
        result = "Board reverted to disk.";
      }
      return { content: [], structuredContent: { result } };
    },
  };
  if (options.qualifiedSync === "missing") delete session.supportsQualifiedFootprintIdentitySync;
  else if (options.qualifiedSync === false) session.supportsQualifiedFootprintIdentitySync = () => false;
  return { session, calls, privateCalls, live: () => live };
}

async function authoringFixture(
  board = populatedBoard(),
  mockOptions: MockOptions = {},
  generic = createGenericDividerBundleFixture("Fresh board authoring host tools fixture."),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-board-authoring-"));
  owned.add(root);
  const project = await prepareFreshProject({
    outputDir: path.join(root, "output"), name: "divider", resume: false, workflowKind: "generic",
    compilationBundle: generic.bundle, compilationBundleRef: generic.reference,
  });
  await writeFile(project.pcbPath, board, "utf8");
  await writeFile(project.schematicPath, schematicSource(), "utf8");
  const mocked = mockSession(project.pcbPath, board, mockOptions);
  let nativeCaptureCount = 0;
  const bridge = createKicadHarnessTools(mocked.session, {
    freshProject: project,
    freshConnectivityContract: generic.bundle.contract,
    freshCompilationBundle: generic.bundle,
    captureFreshNativeNetlist: async () => await (mockOptions.nativeSource?.(++nativeCaptureCount, project.schematicPath) ?? nativeNetlist()),
    capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
    verifyPersistedMutation: async (baseline) => baseline !== contentIdentity(await readFile(project.pcbPath)).digest,
    ...(mockOptions.observeFreshSyncBoardComparison === undefined ? {} : { observeFreshSyncBoardComparison: mockOptions.observeFreshSyncBoardComparison }),
    ...(mockOptions.observeFreshSyncFailureDiagnostic === undefined ? {} : { observeFreshSyncFailureDiagnostic: mockOptions.observeFreshSyncFailureDiagnostic }),
  });
  return { ...generic, project, bridge, ...mocked };
}

describe("fresh generic board authoring compounds", () => {
  it.each([false, "missing"] as const)("hides and refuses fresh sync before sidecar writes when qualified identity support is %s", async (qualifiedSync) => {
    const current = await authoringFixture(emptyBoard(), { qualifiedSync, syncBoard: populatedBoard([]) });
    expect(current.bridge.tools.map((tool) => tool.name)).not.toContain("fresh_sync_from_schematic");
    await expect(current.bridge.execute({ id: "unqualified-sync", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/Unsupported KiCad harness tool/iu);
    expect(current.calls).toEqual([]);
    expect(current.privateCalls).toEqual([]);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    expect(current.live()).toBe(emptyBoard());
  });

  it("rechecks qualified identity support revoked after tool discovery before dispatch", async () => {
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]) });
    expect(current.bridge.tools.map((tool) => tool.name)).toContain("fresh_sync_from_schematic");
    current.session.supportsQualifiedFootprintIdentitySync = () => false;
    await expect(current.bridge.execute({ id: "revoked-sync", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/qualified writer/iu);
    expect(current.calls).toEqual([]);
    expect(current.privateCalls).toEqual([]);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    expect(current.live()).toBe(emptyBoard());
  });

  it("still reads uniquely bound historical bare footprint IDs without the qualified sync capability", async () => {
    const historical = populatedBoard([], true);
    const current = await authoringFixture(historical, { qualifiedSync: "missing" });
    const result = JSON.parse((await current.bridge.execute({ id: "historical-pads", name: "fresh_get_contract_pad_positions", arguments: {} })).content);
    expect(result.pads).toHaveLength(7);
    expect(result.pcbContentIdentity).toEqual(contentIdentity(historical));
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath, "utf8")).footprints.map((entry) => entry.libraryId)).toEqual([
      "PinHeader_1x03_P2.54mm_Vertical", "R_0603_1608Metric", "R_0603_1608Metric",
    ]);
    expect(current.calls).toEqual([]);
  });

  it("returns exact source-bound contract pad positions without sidecar rounding", async () => {
    const current = await authoringFixture();
    expect(current.bundle.contract.netClasses).toEqual([
      expect.objectContaining({ id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu"] }),
      expect.objectContaining({ id: "SENSE", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu"] }),
    ]);
    expect(Object.fromEntries(current.bundle.contract.nets.map((net) => [net.name, net.netClassId]))).toEqual({ VIN: "POWER", VOUT: "SENSE", GND: "POWER" });
    expect(current.bundle.acceptancePlan.rows).toHaveLength(44);
    expect(current.bundle.acceptancePlan.rows).toContainEqual(expect.objectContaining({ id: "schematic-render-clearance", kind: "schematic_render_clearance" }));
    const names = current.bridge.tools.map((tool) => tool.name);
    expect(names).toContain("fresh_get_contract_pad_positions");
    expect(names).toContain("fresh_sync_from_schematic");
    expect(names).not.toContain("pcb_sync_from_schematic");
    const result = await current.bridge.execute({ id: "pads", name: "fresh_get_contract_pad_positions", arguments: {} });
    const payload = JSON.parse(result.content) as {
      pcbContentIdentity: ReturnType<typeof contentIdentity>;
      footprintLibraryTableIdentity: ReturnType<typeof contentIdentity>;
      pads: { reference: string; pad: string; net: string | null; xMm: number; yMm: number; layers: string[] }[];
    };
    expect(payload.pads).toHaveLength(7);
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath, "utf8")).footprints.flatMap((entry) => entry.pads)).toHaveLength(7);
    expect(payload.pads).toContainEqual({ reference: "J1", pad: "1", net: "VIN", xMm: 2, yMm: 5, layers: ["F.Cu"] });
    expect(payload.pads).toContainEqual({ reference: "R2", pad: "2", net: "GND", xMm: 18, yMm: 9.123456789, layers: ["F.Cu"] });
    expect(payload.pcbContentIdentity).toEqual(contentIdentity(await readFile(current.project.pcbPath)));
    expect(payload.footprintLibraryTableIdentity).toEqual(current.project.genericBinding!.footprintLibraryTableIdentity);
    expect(current.calls).toHaveLength(0);
    await expect(current.bridge.execute({ id: "pads-extra", name: "fresh_get_contract_pad_positions", arguments: { reference: "J1" } })).rejects.toThrow();
  });

  it("applies KiCad stored footprint rotation/mirror coordinates without rounding", () => {
    const source = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
      (general) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
      ${footprint("Resistor_SMD:R_0603_1608Metric", "R9", "33k", 60, 31, [
        { number: "1", x: -0.825, y: 0, net: "USB", layers: ["B.Cu"] },
        { number: "2", x: 0.825, y: 0, net: "GND", layers: ["B.Cu"] },
      ], { layer: "B.Cu", rotation: 180 })})`.replace("(at -0.825 0)", "(at -0.825 0 37) (offset 0.1 0.2)");
    const pads = parseFreshPcbSource(source).footprints[0]!.pads;
    expect(pads[0]).toMatchObject({ at: { x: 60.825, y: 31 }, layers: ["B.Cu"] });
    expect(pads[1]).toMatchObject({ at: { x: 59.175, y: 31 }, layers: ["B.Cu"] });
  });

  it("returns source UUIDs for both tracks and vias without trusting rounded sidecar lists", async () => {
    const withVia = appendBoardItem(populatedBoard(), '(via (at 6 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "VIN") (uuid "55555555-5555-4555-8555-555555555555"))');
    const current = await authoringFixture(withVia);
    const result = JSON.parse((await current.bridge.execute({ id: "route-items", name: "fresh_get_route_items", arguments: {} })).content) as {
      items: { kind: string; id: string; net: string; at?: { xMm: number; yMm: number }; layers?: string[] }[];
    };
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "track", id: IDS.vinBad, net: "VIN",
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "via", id: "55555555-5555-4555-8555-555555555555", net: "VIN", at: { xMm: 6, yMm: 5 }, layers: ["F.Cu", "B.Cu"],
    }));
    expect(current.calls.map((entry) => entry.name)).not.toEqual(expect.arrayContaining(["pcb_get_tracks", "pcb_get_vias"]));

    const legacyIdentity = await authoringFixture(populatedBoard().replace(`(uuid "${IDS.vinBad}")`, "(tstamp ABCDEF12)"));
    const legacyItems = JSON.parse((await legacyIdentity.bridge.execute({ id: "route-tstamp", name: "fresh_get_route_items", arguments: {} })).content) as { items: { id: string }[] };
    expect(legacyItems.items).toContainEqual(expect.objectContaining({ id: "ABCDEF12" }));

    const collision = await authoringFixture(populatedBoard().replace("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", IDS.vinBad));
    await expect(collision.bridge.execute({ id: "route-collision", name: "fresh_get_route_items", arguments: {} })).rejects.toThrow(/duplicate object/iu);
    const mixedIdentity = await authoringFixture(populatedBoard().replace(`(uuid "${IDS.vinBad}")`, `(uuid "${IDS.vinBad}") (tstamp ABCDEF12)`));
    await expect(mixedIdentity.bridge.execute({ id: "route-mixed-id", name: "fresh_get_route_items", arguments: {} })).rejects.toThrow(/multiple|malformed/iu);
    const blindVia = await authoringFixture(appendBoardItem(populatedBoard(), '(via (type blind) (at 6 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "VIN") (uuid "55555555-5555-4555-8555-555555555555"))'));
    await expect(blindVia.bridge.execute({ id: "route-blind-via", name: "fresh_get_route_items", arguments: {} })).rejects.toThrow(/via .* malformed/iu);
  });

  it("forces compound sync, verifies 3 footprints/7 pads/zero unresolved mappings, reloads, and saves", async () => {
    const synced = populatedBoard([]);
    const current = await authoringFixture(emptyBoard(), { syncBoard: synced });
    const result = await current.bridge.execute({ id: "sync", name: "fresh_sync_from_schematic", arguments: {} });
    expect(JSON.parse(result.content)).toMatchObject({
      schemaVersion: "evleda.fresh-sync-from-schematic-result.v1", applied: true, mutated: true,
      componentCount: 3, padCount: 7, namedPadCount: 7, noConnectPadCount: 0, unresolvedMappingCount: 0,
      footprintLibraryTableIdentity: current.project.genericBinding!.footprintLibraryTableIdentity,
    });
    expect(current.calls.find((entry) => entry.name === "pcb_sync_from_schematic")?.args).toMatchObject({
      allow_open_board: true, use_net_names: true, replace_mismatched: true, force: false,
    });
    const saved = await current.bridge.internal.saveAfterMutation({ id: "sync-save", name: "pcb_save", arguments: {} });
    expect(saved.isError).not.toBe(true);
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath, "utf8")).footprints).toHaveLength(3);
  });

  it("terminally rolls back a claimed qualified writer that emits a bare footprint leaf", async () => {
    const before = emptyBoard();
    const bare = populatedBoard([]).replace('(footprint "Resistor_SMD:R_0603_1608Metric"', '(footprint "R_0603_1608Metric"');
    const current = await authoringFixture(before, { syncBoard: bare });
    expect(current.session.supportsQualifiedFootprintIdentitySync?.()).toBe(true);
    await expect(current.bridge.execute({ id: "lying-qualified-sync", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL: Synced PCB footprint library IDs do not exactly match the complete qualified schematic assignments/iu);
    expect(current.calls.map((entry) => entry.name)).toEqual(["pcb_sync_from_schematic", "pcb_revert"]);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(before);
    expect(current.live()).toBe(before);
  });

  it("rolls back when mandatory save drops a previously verified footprint library nickname", async () => {
    const before = emptyBoard();
    const current = await authoringFixture(before, {
      syncBoard: populatedBoard([]),
      saveTransform: (source) => source.replace('(footprint "Resistor_SMD:R_0603_1608Metric"', '(footprint "R_0603_1608Metric"'),
    });
    const synced = JSON.parse((await current.bridge.execute({ id: "qualified-before-save", name: "fresh_sync_from_schematic", arguments: {} })).content);
    expect(synced).toMatchObject({ applied: true, mutated: true });
    const saved = await current.bridge.internal.saveAfterMutation({ id: "bare-after-save", name: "pcb_save", arguments: {} });
    expect(saved).toMatchObject({ isError: true, content: expect.stringContaining("complete qualified schematic assignments") });
    expect(current.calls.map((entry) => entry.name)).toEqual(["pcb_sync_from_schematic", "pcb_save", "pcb_revert"]);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(before);
    expect(current.live()).toBe(before);
  });

  it("passes the actual sync producer result through the harness consumer, mandatory save, and independent completion gate", async () => {
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]), syncResult: capturedSync.receivedResult,
      nativeSource: (capture) => capture === 1 ? capturedNativeBefore : capturedNativeBefore.replace(`(date "${capturedTimestamp.beforeDate}")`, `(date "${capturedTimestamp.afterDate}")`),
    });
    const produced: HarnessToolResult[] = [];
    const phases: string[] = [];
    // Controlled passing validation reports exercise harness sequencing; the independent
    // completion gate still refuses unverified contract placement and routing.
    const validation: Readonly<Record<string, unknown>> = {
      run_erc: { status: "clean", findings: [], metadata: { available: true, violation_count: 0 } },
      run_drc: { status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } },
      pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 3, pads: 7, nets: 3, tracks: 1, shapes: 1 } },
      pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 3, board_bounds: [0, 0, 30, 20] },
    };
    const port: HarnessToolPort = {
      tools: current.bridge.tools,
      execute: async (call) => {
        phases.push(call.name);
        const result = await current.bridge.execute(call as never);
        produced.push(result);
        return result;
      },
      internal: {
        ...current.bridge.internal,
        saveAfterMutation: async (call) => { phases.push("save"); return await current.bridge.internal.saveAfterMutation(call); },
        execute: async (call) => {
          phases.push(call.name);
          if (!Object.hasOwn(validation, call.name)) throw new Error(`Unexpected harness validation call ${call.name}`);
          return { toolCallId: call.id, content: JSON.stringify(validation[call.name]) };
        },
      },
    };
    let completionGateCalls = 0;
    const report = await runPcbAgentHarness({
      userPrompt: "Import the exact fixture schematic, then require final contract acceptance.",
      fixedRules: ["Final contract placement and routing require independent acceptance."], projectPath: current.project.projectPath, reportPath: path.join(current.project.outputPath, "harness-report.json"),
      editsRequired: true, allowedToolNames: current.bridge.tools, maxIterations: 1,
    }, {
      provider: "fixture",
      turn: async (): Promise<HarnessProviderTurn> => ({
        message: { role: "assistant", content: "Import the schematic." }, stopReason: "tool_calls",
        toolCalls: [{ id: "producer-consumer-sync", name: "fresh_sync_from_schematic", arguments: {} }],
      }),
    }, port, {
      compoundMutationContractIdentity: createFreshConnectivityContract(current.bundle.contract).identity,
      captureValidationSource: async () => ({
        schematic: contentIdentity(await readFile(current.project.schematicPath)),
        pcb: contentIdentity(await readFile(current.project.pcbPath)),
      }),
      completionGate: async (evidence) => {
        completionGateCalls += 1;
        expect(evidence.sourceBinding?.unchanged).toBe(true);
        return { passed: false, missing: ["Contract placement and routing remain unverified."] };
      },
    });
    expect(report.status).toBe("needs_review");
    expect(report.summary).toContain("Contract placement and routing remain unverified");
    expect(completionGateCalls).toBe(1);
    expect(phases).toEqual(["fresh_sync_from_schematic", "save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
    expect(report.operations.find((operation) => operation.phase === "agent")?.result.content).toBe(produced[0]!.content);
    const sync = JSON.parse(produced[0]!.content);
    expect(sync).toHaveProperty("schematicContentIdentity");
    expect(sync).toHaveProperty("receivedSidecarResponseIdentity");
    expect(sync.nativeNetlistComparison.before.rawIdentity.digest).not.toBe(sync.nativeNetlistComparison.after.rawIdentity.digest);
    expect(sync.nativeNetlistComparison.before.comparisonIdentity).toEqual(sync.nativeNetlistComparison.after.comparisonIdentity);
    expect(sync.placementReview).toEqual({ status: "pending-final-acceptance", interimFindings: [
      "- FAIL: Overlap refs: J1/R2", "- FAIL: Connector 'J1' is 10.00 mm from the nearest edge.",
    ] });
    expect(report.operations.filter((operation) => operation.phase === "save")).toHaveLength(1);
    expect(report.validation.sourceBinding?.before.schematic).toEqual(sync.schematicContentIdentity);
    expect(report.validation.sourceBinding?.before.pcb).toEqual(sync.afterPcbContentIdentity);
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath, "utf8")).footprints).toHaveLength(3);
  });

  it("reports the exact frozen post-sync disk/live pair before mismatch rollback without exposing it to providers", async () => {
    const liveSource = populatedBoard([]);
    const diskSource = `${liveSource.replaceAll("\n", "\r\n")} `;
    const observed: FreshSyncBoardComparisonDiagnostic[] = [];
    const attemptedMutations: boolean[] = [];
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: liveSource,
      diskTransform: (source) => `${source.replaceAll("\n", "\r\n")} `,
      observeFreshSyncBoardComparison: (diagnostic) => {
        observed.push(diagnostic);
        attemptedMutations.push(Reflect.set(diagnostic, "diskSource", liveSource));
        attemptedMutations.push(Reflect.set(diagnostic.diskContentIdentity, "digest", "0".repeat(64)));
      },
    });
    const definitions = JSON.stringify(current.bridge.tools);
    expect(definitions).not.toContain("observeFreshSyncBoardComparison");
    expect(definitions).not.toContain("diskContentIdentity");
    await expect(current.bridge.execute({ id: "paired-source-mismatch", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/Reloaded live board bytes differ from the authoritative synced PCB source/iu);
    expect(observed).toHaveLength(1);
    expect(attemptedMutations).toEqual([false, false]);
    const diagnostic = observed[0]!;
    expect(Object.keys(diagnostic).sort()).toEqual(["diskContentIdentity", "diskSource", "liveContentIdentity", "liveSource"]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.diskContentIdentity)).toBe(true);
    expect(Object.isFrozen(diagnostic.liveContentIdentity)).toBe(true);
    expect(diagnostic.diskSource).toBe(diskSource);
    expect(diagnostic.diskContentIdentity).toEqual(contentIdentity(diskSource));
    expect(diagnostic.liveSource).toBe(liveSource);
    expect(diagnostic.liveContentIdentity).toEqual(contentIdentity(liveSource));
    expect(observed[0]!.diskContentIdentity.digest).toBe(contentIdentity(diskSource).digest);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    expect(current.live()).toBe(emptyBoard());
  });

  it.each([false, true])("keeps the source mismatch and exact rollback unchanged with throwing observer=%s", async (throwingObserver) => {
    let observerCalls = 0;
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]), diskTransform: (source) => `${source} `,
      ...(throwingObserver ? { observeFreshSyncBoardComparison: () => { observerCalls += 1; throw new Error("diagnostic sink failure"); } } : {}),
    });
    let failure: unknown;
    try { await current.bridge.execute({ id: "observer-mismatch", name: "fresh_sync_from_schematic", arguments: {} }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/FRESH_SYNC_ROLLED_BACK_TERMINAL: Reloaded live board bytes differ/iu);
    expect((failure as Error).message).not.toContain("diagnostic sink failure");
    expect(observerCalls).toBe(throwingObserver ? 1 : 0);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("ignores synchronous diagnostic errors when the original source comparison succeeds", async () => {
    let observerCalls = 0;
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]),
      observeFreshSyncBoardComparison: () => { observerCalls += 1; throw new Error("diagnostic sink failure"); },
    });
    const result = JSON.parse((await current.bridge.execute({ id: "observer-success", name: "fresh_sync_from_schematic", arguments: {} })).content);
    expect(result).toMatchObject({ applied: true, mutated: true, padCount: 7 });
    expect(observerCalls).toBe(1);
    expect(result).not.toHaveProperty("diskSource");
    expect(result).not.toHaveProperty("liveSource");
    await expect(current.bridge.internal.saveAfterMutation({ id: "observer-success-save", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
  });

  it("accepts the complete captured -03 import response and preserves genuine interim placement failures", async () => {
    expect(capturedSync.resultSha256).toBe("a6785e0186ea4480e5b5d34b6e7dae9d4eae7e62b4c25ce8046a8119e373b2e9");
    // The old cross-message expression spans the zero no-net count and the
    // later successful auto-placement sentence; this is not a refusal.
    expect(/no .* (?:added|replaced|sync)/iu.test(capturedSyncText.replace(/\s+/gu, " "))).toBe(true);
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]), syncResult: capturedSync.receivedResult });
    const result = JSON.parse((await current.bridge.execute({ id: "captured-full-sync", name: "fresh_sync_from_schematic", arguments: {} })).content);
    expect(result).toMatchObject({ applied: true, mutated: true, componentCount: 3, padCount: 7, namedPadCount: 7, unresolvedMappingCount: 0 });
    expect(result.receivedSidecarResponseIdentity).toEqual(contentIdentity(capturedSyncText));
    expect(result.placementReview).toEqual({ status: "pending-final-acceptance", interimFindings: [
      "- FAIL: Overlap refs: J1/R2",
      "- FAIL: Connector 'J1' is 10.00 mm from the nearest edge.",
    ] });
    expect(current.calls.find((call) => call.name === "pcb_sync_from_schematic")?.args).toMatchObject({ auto_place: true, force: false });
    await expect(current.bridge.internal.saveAfterMutation({ id: "captured-full-save", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
  });

  it.each([
    ["open-board refusal", "Refusing file-based PCB sync while a board is open in KiCad. Close the board first, or rerun with allow_open_board=True if you want KiCad to reload the updated file from disk."],
    ["pre-sync abort", "PCB sync aborted because the schematic is not ready:\n- Connectivity quality gate: FAIL"],
    ["collection abort", "PCB sync aborted:\n- Unsupported symbol"],
    ["missing assignments", "PCB sync aborted because some schematic symbols are missing footprint assignments:\n- R1"],
    ["no symbols", "No schematic symbols were found to sync."],
    ["already imported", "The PCB already contains all schematic footprint assignments."],
    ["zero mutation counts", capturedSyncText.replace("New footprints added: 3", "New footprints added: 0")],
    ["degraded transfer", capturedSyncText.replace("CLEAN (100.0% pad coverage)", "DEGRADED (85.7% pad coverage)")],
    ["poor transfer", capturedSyncText.replace("CLEAN (100.0% pad coverage)", "POOR (42.9% pad coverage)")],
    ["unknown transfer", capturedSyncText.replace("CLEAN (100.0% pad coverage)", "UNKNOWN (0.0% pad coverage)")],
    ["incomplete metrics", capturedSyncText.replace("Fully net-mapped refs: 3\n", "")],
    ["partial pads", capturedSyncText.replace("Pads with named nets: 7", "Pads with named nets: 6")],
    ["manual reload", capturedSyncText.replace("The PCB file was updated and KiCad was asked to reload it.", "The PCB file was updated. Reload it manually in KiCad if needed.")],
    ["forced gate override", capturedSyncText.replace("Force-directed auto-placement", "Pre-sync gate was overridden by force=True.\nForce-directed auto-placement")],
  ] as const)("retains terminal rollback for true %s", async (_name, syncText) => {
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]), syncText });
    await expect(current.bridge.execute({ id: "sync-semantic-negative", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL/iu);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    expect(current.live()).toBe(emptyBoard());
  });

  it("does not let the captured clean response override unchanged PCB bytes or incorrect saved pads", async () => {
    const unchangedSource = populatedBoard([]);
    const unchanged = await authoringFixture(unchangedSource, { syncBoard: unchangedSource, syncResult: capturedSync.receivedResult });
    await expect(unchanged.bridge.execute({ id: "false-changed-response", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/authoritative PCB content unchanged/iu);
    expect(await readFile(unchanged.project.pcbPath, "utf8")).toBe(unchangedSource);
    const incorrect = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]).replace('(net "VIN")', '(net "GND")'), syncResult: capturedSync.receivedResult });
    await expect(incorrect.bridge.execute({ id: "false-pad-response", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL/iu);
    expect(await readFile(incorrect.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("does not let the captured clean response override exact saved schematic source drift", async () => {
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]), syncResult: capturedSync.receivedResult,
      nativeSource: async (capture, schematicPath) => {
        if (capture === 2) await writeFile(schematicPath, `${await readFile(schematicPath, "utf8")} `);
        return nativeNetlist();
      },
    });
    await expect(current.bridge.execute({ id: "false-schematic-response", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/Exact saved schematic bytes changed/iu);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("accepts captured CRLF disk/LF live serializations and date-only native drift while retaining raw receipts", async () => {
    const current = await authoringFixture(Buffer.from(capturedBoard.diskUtf8Base64, "base64").toString("utf8"), {
      liveTransform: (source) => source.replaceAll("\r\n", "\n"),
      diskTransform: (source) => source.replaceAll("\n", "\r\n"),
      syncBoard: populatedBoard([]),
      nativeSource: (capture) => capture === 1 ? capturedNativeBefore : capturedNativeBefore.replace(`(date "${capturedTimestamp.beforeDate}")`, `(date "${capturedTimestamp.afterDate}")`),
    });
    const schematicBefore = await readFile(current.project.schematicPath);
    const result = JSON.parse((await current.bridge.execute({ id: "captured-sync", name: "fresh_sync_from_schematic", arguments: {} })).content);
    expect(result.nativeNetlistComparison).toMatchObject({
      equal: true,
      before: { rawIdentity: { digest: capturedTimestamp.beforeRawSha256 }, exportDate: capturedTimestamp.beforeDate },
      after: { rawIdentity: { digest: capturedTimestamp.afterRawSha256 }, exportDate: capturedTimestamp.afterDate },
    });
    expect(result.nativeNetlistComparison.before.comparisonIdentity).toEqual(result.nativeNetlistComparison.after.comparisonIdentity);
    expect(result.schematicContentIdentity).toEqual(contentIdentity(schematicBefore));
    expect(result.beforePcbContentIdentity.digest).toBe("893efea3b13b859ee6540594844e6390530098c302ce80874ccbc5846c94bdda");
    expect(current.calls.map((call) => call.name)).not.toEqual(expect.arrayContaining(["pcb_get_board_as_string", "kicad_get_project_info"]));
    expect(current.privateCalls.filter((call) => call.name === "readActivePcbSource")).toHaveLength(2);
    await expect(current.bridge.internal.saveAfterMutation({ id: "captured-save", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(await readFile(current.project.schematicPath)).toEqual(schematicBefore);
    expect(await readFile(current.project.pcbPath, "utf8")).toContain("\r\n");
  });

  it.each([
    ["class", (source: string) => source.replace('EVLEDA_97cfc26f5aab_C01', 'OTHER_CLASS')],
    ["source path", (source: string) => source.replace('EvlEDA-authored-netclass-sync-probe-20260908-02', 'Different-source')],
    ["pin function", (source: string) => source.replace('(pinfunction "Pin_1_1")', '(pinfunction "Changed")')],
    ["library metadata", (source: string) => source.replace('${KICAD10_SYMBOL_DIR}/Device.kicad_sym', '${KICAD10_SYMBOL_DIR}/Other.kicad_sym')],
  ] as const)("rejects native %s drift that projected parity alone does not expose", async (_name, mutate) => {
    const changed = mutate(capturedNativeBefore);
    expect(changed).not.toBe(capturedNativeBefore);
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]), nativeSource: (capture) => capture === 1 ? capturedNativeBefore : changed });
    await expect(current.bridge.execute({ id: "native-drift", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL.*native netlist changed/iu);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it.each([1, 2])("rejects exact saved schematic byte drift during native capture %s", async (faultCapture) => {
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]),
      nativeSource: async (capture, schematicPath) => {
        if (capture === faultCapture) await writeFile(schematicPath, `${await readFile(schematicPath, "utf8")} `);
        return nativeNetlist();
      },
    });
    await expect(current.bridge.execute({ id: "schematic-drift", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/Exact saved schematic bytes changed/iu);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    if (faultCapture === 1) expect(current.calls).toEqual([]);
  });

  it("does not erase a disk BOM to make the live sync preimage match", async () => {
    const before = `\uFEFF${emptyBoard()}`;
    const current = await authoringFixture(before, { liveTransform: (source) => source.replace(/^\uFEFF/u, ""), syncBoard: populatedBoard([]) });
    await expect(current.bridge.execute({ id: "bom-sync", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/FRESH_SYNC_ROLLBACK_FAILED_TERMINAL/iu);
    expect(current.calls.map((call) => call.name)).not.toContain("pcb_sync_from_schematic");
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(before);
  });

  it("reads a large source with literal paths privately without the public text cap or redaction", async () => {
    const note = `(property "Source" "C:/Private/board/${"A".repeat(70_000)}")`;
    const current = await authoringFixture(appendBoardItem(emptyBoard(), note), { syncBoard: appendBoardItem(populatedBoard([]), note) });
    await expect(current.bridge.execute({ id: "large-private-sync", name: "fresh_sync_from_schematic", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    await expect(current.bridge.internal.saveAfterMutation({ id: "large-private-save", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(await readFile(current.project.pcbPath, "utf8")).toContain(note);
    expect(current.calls.map((call) => call.name)).not.toContain("pcb_get_board_as_string");
  });

  it.each([
    ["local labels", (source: string) => source.replace('(global_label "VIN" (shape passive)', '(label "VIN"')],
    ["wrong shape", (source: string) => source.replace('(global_label "VIN" (shape passive)', '(global_label "VIN" (shape input)')],
    ["duplicate label", (source: string) => source.replace('(generator "fixture")', '(generator "fixture") (global_label "VIN" (shape passive) (at 0 0 0))')],
    ["canonical Netclass", (source: string) => source.replace('(global_label "VIN"', '(global_label "VIN" (property "Netclass" "OtherClass" (at 0 0 0))')],
    ["private Netclass", (source: string) => source.replace('(global_label "VIN"', '(global_label "VIN" (property private "Netclass" "OtherClass" (at 0 0 0))')],
    ["unsupported global property", (source: string) => source.replace('(global_label "VIN"', '(global_label "VIN" (property "Netzklasse" "OtherClass" (at 0 0 0))')],
    ["directive_label", (source: string) => source.replace('(generator "fixture")', '(generator "fixture") (directive_label "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))')],
    ["netclass_flag", (source: string) => source.replace('(generator "fixture")', '(generator "fixture") (netclass_flag "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))')],
    ["native rule_area", (source: string) => source.replace('(generator "fixture")', '(generator "fixture") (rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 0)) (stroke (width 0.15) (type default)) (fill (type none))))')],
  ] as const)("refuses sync with %s before touching the PCB", async (_name, mutate) => {
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]) });
    await writeFile(current.project.schematicPath, mutate(schematicSource()), "utf8");
    await expect(current.bridge.execute({ id: "sync-label-mismatch", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/passive global label|unsupported class sources/iu);
    expect(current.calls).toEqual([]);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("rolls back sync when unsupported schematic class metadata appears before the saved readback", async () => {
    const preimage = emptyBoard();
    const current = await authoringFixture(preimage, { syncBoard: populatedBoard([]) });
    await current.bridge.execute({ id: "sync-before-class-drift", name: "fresh_sync_from_schematic", arguments: {} });
    await writeFile(current.project.schematicPath, schematicSource().replace('(global_label "VIN"', '(global_label "VIN" (property private "Netclass" "OtherClass" (at 0 0 0))'), "utf8");
    expect(await current.bridge.internal.saveAfterMutation({ id: "sync-save-class-drift", name: "pcb_save", arguments: {} })).toMatchObject({ isError: true, content: expect.stringContaining("unsupported class sources") });
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(preimage);
  });

  it("retains the exact schematic-byte binding through the mandatory PCB save", async () => {
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]) });
    await current.bridge.execute({ id: "sync-source-bound", name: "fresh_sync_from_schematic", arguments: {} });
    await writeFile(current.project.schematicPath, `${await readFile(current.project.schematicPath, "utf8")} `);
    expect(await current.bridge.internal.saveAfterMutation({ id: "save-source-drift", name: "pcb_save", arguments: {} })).toMatchObject({ isError: true, content: expect.stringContaining("Exact saved schematic bytes changed") });
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("publishes the complete failed sync response and changed saved PCB before wrong-net rollback", async () => {
    const wrong = populatedBoard([]).replace('(net "VIN")', '(net "GND")');
    let observed: FreshSyncFailureDiagnostic | undefined;
    let publication: Awaited<ReturnType<typeof writeToolboxSyncDiagnostic>> | undefined;
    let sourceAtPublication: string | undefined;
    let callsAtPublication: string[] = [];
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: wrong, syncResult: capturedSync.receivedResult,
      observeFreshSyncFailureDiagnostic: async diagnostic => {
        observed = diagnostic;
        sourceAtPublication = await readFile(current.project.pcbPath, "utf8");
        callsAtPublication = current.calls.map(call => call.name);
        publication = await writeToolboxSyncDiagnostic(current.project.outputPath, diagnostic);
      },
    });
    await expect(current.bridge.execute({ id: "sync-first-failure", name: "fresh_sync_from_schematic", arguments: {} }))
      .rejects.toThrow(/PCB pad J1:1 .*wrong net/iu);
    expect(sourceAtPublication).toBe(wrong);
    expect(callsAtPublication).toContain("pcb_sync_from_schematic");
    expect(callsAtPublication).not.toContain("pcb_revert");
    expect(publication).toBeDefined();
    const bytes = await readFile(publication!.path);
    expect(contentIdentity(bytes)).toEqual(publication!.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(observed);
    expect(observed).toMatchObject({ phase: "primary-failure", stage: "saved-contract-pad-positions",
      beforePcb: { status: "captured", text: emptyBoard(), contentIdentity: contentIdentity(emptyBoard()) },
      savedPcb: { status: "captured", text: wrong, contentIdentity: contentIdentity(wrong) },
      savedPcbAtFailure: { status: "captured", text: wrong, contentIdentity: contentIdentity(wrong) },
      schematicInput: { status: "captured", text: schematicSource(), contentIdentity: contentIdentity(schematicSource()) },
      nativeNetlistBefore: { status: "captured", text: nativeNetlist(), contentIdentity: contentIdentity(nativeNetlist()) },
      nativeNetlistAfter: { status: "unavailable" }, livePcb: { status: "unavailable" },
      nativeResponseJson: { status: "captured", text: JSON.stringify(capturedSync.receivedResult), contentIdentity: contentIdentity(JSON.stringify(capturedSync.receivedResult)) } });
    expect(observed!.primary).toMatchObject({ status: "captured", text: expect.stringContaining("PCB pad J1:1") });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed!.savedPcb)).toBe(true);
    expect(JSON.stringify(current.bridge.tools)).not.toContain("observeFreshSyncFailureDiagnostic");
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    expect(current.live()).toBe(emptyBoard());
  });

  it.each(["parse", "response"] as const)("retains changed saved source after early %s failure", async kind => {
    const source = kind === "parse" ? populatedBoard([]).slice(0, -2) : populatedBoard([]);
    const observed: FreshSyncFailureDiagnostic[] = [];
    const current = await authoringFixture(emptyBoard(), { syncBoard: source,
      ...(kind === "response" ? { syncText: "The PCB already contains all schematic footprint assignments." } : {}),
      observeFreshSyncFailureDiagnostic: diagnostic => { observed.push(diagnostic); },
    });
    await expect(current.bridge.execute({ id: "sync-early-failure", name: "fresh_sync_from_schematic", arguments: {} }))
      .rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL/);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ stage: kind === "parse" ? "saved-pcb-parse" : "native-response-validation",
      savedPcbAtFailure: { status: "captured", text: source, contentIdentity: contentIdentity(source) } });
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it.each([false, true])("preserves primary wrong-net failure and native call count with failing diagnostic sink=%s", async fails => {
    const wrong = populatedBoard([]).replace('(net "VIN")', '(net "GND")');
    let count = 0;
    const current = await authoringFixture(emptyBoard(), { syncBoard: wrong,
      ...(fails ? { observeFreshSyncFailureDiagnostic: async () => { count++; throw new Error("private diagnostic publication failed"); } } : {}),
    });
    const error = await current.bridge.execute({ id: "sync-sink-failure", name: "fresh_sync_from_schematic", arguments: {} }).catch(error => error) as Error;
    expect(error.message).toMatch(/FRESH_SYNC_ROLLED_BACK_TERMINAL: PCB pad J1:1 .*wrong net/);
    expect(error.message).not.toContain("publication failed");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/PCB pad J1:1 .*wrong net/);
    expect(count).toBe(fails ? 1 : 0);
    expect(current.calls.map(call => call.name)).toEqual(["pcb_sync_from_schematic", "pcb_revert"]);
    expect(current.privateCalls.filter(call => call.name === "readActivePcbSource")).toHaveLength(2);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("does not publish failure diagnostics for successful sync", async () => {
    let count = 0;
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]),
      observeFreshSyncFailureDiagnostic: () => { count++; },
    });
    await current.bridge.execute({ id: "sync-no-diagnostic", name: "fresh_sync_from_schematic", arguments: {} });
    expect(count).toBe(0);
  });

  it("retains already-observed malformed live bytes without another native probe", async () => {
    const valid = populatedBoard([]), malformed = valid.slice(0, -2);
    const observed: FreshSyncFailureDiagnostic[] = [];
    const current = await authoringFixture(emptyBoard(), { syncBoard: valid,
      liveTransform: source => source === valid ? malformed : source,
      diskTransform: source => source === malformed ? valid : source,
      observeFreshSyncFailureDiagnostic: diagnostic => { observed.push(diagnostic); },
    });
    await expect(current.bridge.execute({ id: "sync-live-parse", name: "fresh_sync_from_schematic", arguments: {} }))
      .rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL/);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ stage: "live-pcb-capture", savedPcb: { status: "captured", text: valid },
      livePcb: { status: "captured", text: malformed, contentIdentity: contentIdentity(malformed) } });
    expect(current.privateCalls.filter(call => call.name === "readActivePcbSource")).toHaveLength(3);
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("records unsafe saved source as unavailable and preserves the first cause when rollback also fails", async () => {
    const observed: FreshSyncFailureDiagnostic[] = [];
    const current = await authoringFixture(emptyBoard(), { syncBoard: populatedBoard([]),
      syncText: "The PCB already contains all schematic footprint assignments.",
      observeFreshSyncFailureDiagnostic: diagnostic => { observed.push(diagnostic); },
    });
    const originalCall = current.session.callTool;
    current.session.callTool = async (name, args) => {
      const response = await originalCall(name, args);
      if (name === "pcb_sync_from_schematic") {
        await rm(current.project.pcbPath);
        await mkdir(current.project.pcbPath);
      }
      return response;
    };
    const error = await current.bridge.execute({ id: "sync-unavailable-source", name: "fresh_sync_from_schematic", arguments: {} }).catch(error => error) as Error;
    expect(error.message).toMatch(/FRESH_SYNC_ROLLBACK_FAILED_TERMINAL: Fresh sync returned refusal or no-change text/);
    expect((error.cause as Error).message).toContain("Fresh sync returned refusal or no-change text");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ stage: "native-response-validation",
      savedPcbAtFailure: { status: "unavailable", reason: expect.stringContaining("physical regular file") } });
  });

  it("bounds a stalled failure observer and still restores the native preimage", async () => {
    let entered!: () => void;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    const current = await authoringFixture(emptyBoard(), {
      syncBoard: populatedBoard([]).replace('(net "VIN")', '(net "GND")'),
      observeFreshSyncFailureDiagnostic: () => { entered(); return new Promise<void>(() => {}); },
    });
    vi.useFakeTimers();
    try {
      const completion = current.bridge.execute({ id: "sync-stalled-diagnostic", name: "fresh_sync_from_schematic", arguments: {} }).catch(error => error) as Promise<Error>;
      await observing;
      expect(current.calls.map(call => call.name)).not.toContain("pcb_revert");
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await completion).message).toMatch(/FRESH_SYNC_ROLLED_BACK_TERMINAL: PCB pad J1:1 .*wrong net/);
      expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
    } finally { vi.useRealTimers(); }
  });

  it("distinguishes the ordinary saved observation from later failure-time source drift", async () => {
    const synced = populatedBoard([]), drifted = synced.replace('(generator "pcbnew")', '(generator "changed")');
    const changedNetlist = nativeNetlist().replace('(name "VIN")', '(name "OTHER")');
    const observed: FreshSyncFailureDiagnostic[] = [];
    const current = await authoringFixture(emptyBoard(), { syncBoard: synced,
      nativeSource: async (capture, schematicPath) => {
        if (capture === 1) return nativeNetlist();
        await writeFile(schematicPath.replace(/\.kicad_sch$/u, ".kicad_pcb"), drifted, "utf8");
        return changedNetlist;
      },
      observeFreshSyncFailureDiagnostic: diagnostic => { observed.push(diagnostic); },
    });
    await expect(current.bridge.execute({ id: "sync-late-drift", name: "fresh_sync_from_schematic", arguments: {} }))
      .rejects.toThrow(/Schematic\/native netlist changed during PCB synchronization/);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ stage: "post-sync-schematic-native-parity",
      savedPcb: { status: "captured", text: synced, contentIdentity: contentIdentity(synced) },
      savedPcbAtFailure: { status: "captured", text: drifted, contentIdentity: contentIdentity(drifted) },
      nativeNetlistAfter: { status: "captured", text: changedNetlist, contentIdentity: contentIdentity(changedNetlist) } });
    expect(await readFile(current.project.pcbPath, "utf8")).toBe(emptyBoard());
  });

  it("treats sync refusal/no-change and false clean metrics as corrective terminal failures with exact rollback", async () => {
    const preimage = emptyBoard();
    const noChange = await authoringFixture(preimage, { syncText: "The PCB already contains all schematic footprint assignments." });
    await expect(noChange.bridge.execute({ id: "sync-noop", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(noChange.project.pcbPath, "utf8")).resolves.toBe(preimage);
    expect(noChange.calls.map((entry) => entry.name)).toContain("pcb_revert");

    const wrong = populatedBoard([]).replace('(net "VIN")', '(net "GND")');
    const mismatch = await authoringFixture(preimage, { syncBoard: wrong });
    await expect(mismatch.bridge.execute({ id: "sync-wrong", name: "fresh_sync_from_schematic", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(mismatch.project.pcbPath, "utf8")).resolves.toBe(preimage);
  });

  it("atomically replaces only selected current track UUIDs on one contract net and verifies the saved route", async () => {
    const current = await authoringFixture();
    const readback = await current.bridge.execute({ id: "routes", name: "fresh_get_route_items", arguments: {} });
    const selection = JSON.parse(readback.content) as { identity: CanonicalIdentity; items: { id: string; net: string; kind: string }[] };
    expect(selection.items).toHaveLength(4);
    const replacement = await current.bridge.execute({
      id: "replace", name: "fresh_replace_route_items", arguments: {
        selectionIdentity: selection.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad],
        tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
      },
    });
    expect(JSON.parse(replacement.content)).toMatchObject({ applied: true, mutated: true, net: "VIN", deletedItemIds: [IDS.vinBad], addedTrackCount: 1, addedViaCount: 0 });
    expect(current.calls.map((entry) => entry.name)).toEqual(expect.arrayContaining(["pcb_begin_commit", "pcb_delete_items", "pcb_add_track", "pcb_push_commit"]));
    expect(current.calls.map((entry) => entry.name)).not.toContain("pcb_get_board_as_string");
    expect(current.privateCalls.filter((entry) => entry.name === "readActivePcbSource")).toHaveLength(2);
    const saved = await current.bridge.internal.saveAfterMutation({ id: "route-save", name: "pcb_save", arguments: {} });
    expect(saved.isError).not.toBe(true);
    const source = await readFile(current.project.pcbPath, "utf8");
    expect(source).not.toContain(IDS.vinBad);
    expect(source).toContain('(start 2 5) (end 10 5) (width 0.5)');
  });

  it("rejects disconnected islands, connected cycles, and the bound adjacent-parallel hairpin envelope", async () => {
    const cases = [
      {
        name: "island",
        tracks: [
          { x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" },
          { x1Mm: 20, y1Mm: 12, x2Mm: 22, y2Mm: 12, layer: "F.Cu" },
          { x1Mm: 22, y1Mm: 12, x2Mm: 21, y2Mm: 13, layer: "F.Cu" },
          { x1Mm: 21, y1Mm: 13, x2Mm: 20, y2Mm: 12, layer: "F.Cu" },
        ],
        expected: /disconnected copper island/iu,
      },
      {
        name: "cycle",
        tracks: [
          { x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" },
          { x1Mm: 10, y1Mm: 5, x2Mm: 12, y2Mm: 7, layer: "F.Cu" },
          { x1Mm: 12, y1Mm: 7, x2Mm: 14, y2Mm: 5, layer: "F.Cu" },
          { x1Mm: 14, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" },
        ],
        expected: /copper cycle/iu,
      },
      {
        name: "hairpin",
        net: "VOUT",
        deleteItemIds: [IDS.voutA, IDS.voutB],
        tracks: [
          { x1Mm: 2, y1Mm: 7, x2Mm: 6, y2Mm: 7, layer: "F.Cu" },
          { x1Mm: 6, y1Mm: 7, x2Mm: 5.65, y2Mm: 7.35, layer: "F.Cu" },
          { x1Mm: 5.65, y1Mm: 7.35, x2Mm: 2, y2Mm: 7.35, layer: "F.Cu" },
        ],
        expected: /hairpin proximity envelope/iu,
      },
    ] as const;
    for (const entry of cases) {
      const current = await authoringFixture();
      const preimage = await readFile(current.project.pcbPath, "utf8");
      const read = JSON.parse((await current.bridge.execute({ id: `read-${entry.name}`, name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
      await expect(current.bridge.execute({ id: entry.name, name: "fresh_replace_route_items", arguments: {
        selectionIdentity: read.identity as never,
        net: "net" in entry ? entry.net : "VIN",
        deleteItemIds: "deleteItemIds" in entry ? [...entry.deleteItemIds] : [IDS.vinBad],
        tracks: entry.tracks.map((track) => ({ ...track })),
        vias: [],
      } })).rejects.toThrow(entry.expected);
      await expect(readFile(current.project.pcbPath, "utf8")).resolves.toBe(preimage);
      expect(current.live()).toBe(preimage);
    }
  });

  it("keeps coincident F/B endpoints disconnected without a via, accepts an explicit permitted via, and enforces zero-via contracts", async () => {
    const viaDraft = structuredClone(genericDividerDraft()) as unknown as {
      netClasses: Array<{ allowedLayers: Array<"F.Cu" | "B.Cu"> }>;
      routingConstraints: {
        viaPolicy: { mode: "forbidden"; maxTotal: number } | { mode: "bounded"; maxTotal: number; diameterMm: number; drillMm: number; minimumAnnularRingMm: number };
        nets: Array<{ preferredLayer: "F.Cu" | "B.Cu" | "either"; maxVias: number }>;
      };
    };
    for (const netClass of viaDraft.netClasses) netClass.allowedLayers = ["F.Cu", "B.Cu"];
    viaDraft.routingConstraints.viaPolicy = { mode: "bounded", maxTotal: 3, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 };
    for (const route of viaDraft.routingConstraints.nets) { route.preferredLayer = "either"; route.maxVias = 1; }
    const viaGeneric = createGenericBundleFixture(viaDraft, "Layer-aware permitted-via route fixture.");
    const viaBoard = populatedBoard().replace(
      '(layers "F.Cu") (net "VIN") (uuid "bbbbbbbb-bbbb-4bbb-8bbb-000000000201")',
      '(layers "B.Cu") (net "VIN") (uuid "bbbbbbbb-bbbb-4bbb-8bbb-000000000201")',
    );
    const replacementTracks = [
      { x1Mm: 2, y1Mm: 5, x2Mm: 6, y2Mm: 5, layer: "F.Cu" as const },
      { x1Mm: 6, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "B.Cu" as const },
    ];

    const missingVia = await authoringFixture(viaBoard, {}, viaGeneric);
    const missingRead = JSON.parse((await missingVia.bridge.execute({ id: "read-no-via", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(missingVia.bridge.execute({ id: "replace-no-via", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: missingRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad], tracks: replacementTracks, vias: [],
    } })).rejects.toThrow(/dangling|disconnected/iu);

    const joined = await authoringFixture(viaBoard, {}, viaGeneric);
    const joinedRead = JSON.parse((await joined.bridge.execute({ id: "read-with-via", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(joined.bridge.execute({ id: "replace-with-via", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: joinedRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad], tracks: replacementTracks, vias: [{ xMm: 6, yMm: 5 }],
    } })).resolves.not.toMatchObject({ isError: true });
    await expect(joined.bridge.internal.saveAfterMutation({ id: "save-with-via", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });

    const zeroVia = await authoringFixture();
    const zeroRead = JSON.parse((await zeroVia.bridge.execute({ id: "read-zero-via", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(zeroVia.bridge.execute({ id: "replace-zero-via", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: zeroRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad],
      tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [{ xMm: 6, yMm: 5 }],
    } })).rejects.toThrow(/vias are forbidden/iu);
    expect(zeroVia.calls.map((entry) => entry.name)).not.toContain("pcb_begin_commit");
  });

  it("rejects A/B contract or bundle authority and remains valid after an A-to-B-to-A constructor sequence", async () => {
    const current = await authoringFixture();
    const alternateDraft = structuredClone(genericDividerDraft());
    alternateDraft.netClasses[0]!.traceWidthMm = 0.6;
    const alternate = createGenericBundleFixture(alternateDraft, "Distinct authoring authority B.");
    const common = {
      freshProject: current.project,
      captureFreshNativeNetlist: async () => nativeNetlist(),
    };
    expect(() => createKicadHarnessTools(current.session, {
      ...common, freshConnectivityContract: alternate.bundle.contract, freshCompilationBundle: current.bundle,
    })).toThrow(/contract|authority|identity/iu);
    expect(() => createKicadHarnessTools(current.session, {
      ...common, freshConnectivityContract: alternate.bundle.contract, freshCompilationBundle: alternate.bundle,
    })).toThrow(/marker-bound|identity|authority/iu);
    expect(() => createKicadHarnessTools(current.session, {
      ...common, freshConnectivityContract: current.bundle.contract, freshCompilationBundle: current.bundle,
    })).not.toThrow();
    expect(current.calls).toHaveLength(0);

    await writeFile(current.project.markerPath, `${await readFile(current.project.markerPath, "utf8")} `, "utf8");
    await expect(current.bridge.execute({ id: "marker-drift", name: "fresh_get_contract_pad_positions", arguments: {} })).rejects.toThrow(/marker/iu);
    expect(current.calls).toHaveLength(0);
  });

  it("rejects stale, cross-net, unknown, and extra-field route deletion requests before mutation", async () => {
    const stale = await authoringFixture();
    const staleRead = JSON.parse((await stale.bridge.execute({ id: "read-stale", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await writeFile(stale.project.pcbPath, `${await readFile(stale.project.pcbPath, "utf8")} `, "utf8");
    await expect(stale.bridge.execute({ id: "stale", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: staleRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad], tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
    } })).rejects.toThrow(/changed|stale/iu);
    expect(stale.calls.map((entry) => entry.name)).not.toContain("pcb_begin_commit");

    for (const [name, net, id, extra] of [
      ["cross", "VIN", IDS.gnd, {}],
      ["unknown", "VIN", "99999999-9999-4999-8999-999999999999", {}],
      ["footprint", "VIN", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", {}],
      ["pad", "VIN", "bbbbbbbb-bbbb-4bbb-8bbb-000000000101", {}],
      ["extra", "VIN", IDS.vinBad, { arbitrary: true }],
    ] as const) {
      const current = await authoringFixture();
      const read = JSON.parse((await current.bridge.execute({ id: `read-${name}`, name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
      await expect(current.bridge.execute({ id: name, name: "fresh_replace_route_items", arguments: {
        selectionIdentity: read.identity as never, net, deleteItemIds: [id], tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [], ...extra,
      } })).rejects.toThrow();
      expect(current.calls.map((entry) => entry.name)).not.toContain("pcb_begin_commit");
    }
  });

  it("rolls back delete/add failures and forbids a free-space tee on a multi-endpoint net", async () => {
    const failure = await authoringFixture(populatedBoard(), { failAddTrack: true });
    const failurePreimage = await readFile(failure.project.pcbPath, "utf8");
    const failureRead = JSON.parse((await failure.bridge.execute({ id: "read-fail", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(failure.bridge.execute({ id: "replace-fail", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: failureRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad], tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
    } })).rejects.toThrow(/ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(failure.project.pcbPath, "utf8")).resolves.toBe(failurePreimage);
    expect(failure.live()).toBe(failurePreimage);
    expect(failure.calls.map((entry) => entry.name)).toContain("pcb_drop_commit");

    const falseSuccess = await authoringFixture(populatedBoard(), { noOpDelete: true });
    const falseSuccessPreimage = await readFile(falseSuccess.project.pcbPath, "utf8");
    const falseSuccessRead = JSON.parse((await falseSuccess.bridge.execute({ id: "read-false", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(falseSuccess.bridge.execute({ id: "replace-false", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: falseSuccessRead.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad], tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
    } })).rejects.toThrow(/remains in live readback|ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(falseSuccess.project.pcbPath, "utf8")).resolves.toBe(falseSuccessPreimage);
    expect(falseSuccess.live()).toBe(falseSuccessPreimage);

    const tee = await authoringFixture();
    const teePreimage = await readFile(tee.project.pcbPath, "utf8");
    const teeRead = JSON.parse((await tee.bridge.execute({ id: "read-tee", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(tee.bridge.execute({ id: "replace-tee", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: teeRead.identity as never, net: "VOUT", deleteItemIds: [IDS.voutA, IDS.voutB],
      tracks: [
        { x1Mm: 2, y1Mm: 7, x2Mm: 6, y2Mm: 7, layer: "F.Cu" },
        { x1Mm: 6, y1Mm: 7, x2Mm: 10, y2Mm: 7, layer: "F.Cu" },
        { x1Mm: 6, y1Mm: 7, x2Mm: 18, y2Mm: 7, layer: "F.Cu" },
      ], vias: [],
    } })).rejects.toThrow(/free-space tee|ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(tee.project.pcbPath, "utf8")).resolves.toBe(teePreimage);
    expect(tee.live()).toBe(teePreimage);
  });

  it("requires the host save immediately after a successful compound board mutation", async () => {
    const current = await authoringFixture();
    const preimage = await readFile(current.project.pcbPath, "utf8");
    const read = JSON.parse((await current.bridge.execute({ id: "read-exclusive", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await current.bridge.execute({ id: "replace-exclusive", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: read.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad],
      tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
    } });
    await expect(current.bridge.execute({ id: "bypass-save", name: "fresh_get_contract_pad_positions", arguments: {} })).rejects.toThrow(/FRESH_BOARD_COMPOUND_ROLLED_BACK_TERMINAL/iu);
    await expect(readFile(current.project.pcbPath, "utf8")).resolves.toBe(preimage);
    expect(current.live()).toBe(preimage);
  });

  it("uses private LF live source against CRLF disk preimages for route replacement and save", async () => {
    const current = await authoringFixture(populatedBoard().replaceAll("\n", "\r\n"), {
      liveTransform: (source) => source.replaceAll("\r\n", "\n"),
      diskTransform: (source) => source.replaceAll("\n", "\r\n"),
    });
    const read = JSON.parse((await current.bridge.execute({ id: "crlf-routes", name: "fresh_get_route_items", arguments: {} })).content) as { identity: CanonicalIdentity };
    await expect(current.bridge.execute({ id: "crlf-replace", name: "fresh_replace_route_items", arguments: {
      selectionIdentity: read.identity as never, net: "VIN", deleteItemIds: [IDS.vinBad],
      tracks: [{ x1Mm: 2, y1Mm: 5, x2Mm: 10, y2Mm: 5, layer: "F.Cu" }], vias: [],
    } })).resolves.not.toMatchObject({ isError: true });
    await expect(current.bridge.internal.saveAfterMutation({ id: "crlf-route-save", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(await readFile(current.project.pcbPath, "utf8")).toContain("\r\n");
    expect(current.calls.map((call) => call.name)).not.toEqual(expect.arrayContaining(["pcb_get_board_as_string", "kicad_get_project_info"]));
    expect(current.privateCalls.every((call) => call.expectedPath === current.project.pcbPath)).toBe(true);
  });
});
