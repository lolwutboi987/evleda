/** Real native schematic-authoring/sync integration smoke, not board acceptance. */
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import { contentIdentity } from "../src/core/canonical.js";
import type { PcbDesignContract } from "../src/harness/pcb-design-contract.js";

const options = parseNativeToolboxArgs(process.argv.slice(2));
if (options?.fresh?.intentPath === undefined || options.resume || !options.edit) throw new Error("Fresh smoke requires new-project intent arguments and --edit, not resume.");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(),
  scope: "Fresh native preparation, schematic authoring and PCB sync only; no routing or finished-board claim.", operations: [] };
let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
let client: Client | undefined;
const original = contentIdentity(await readFile(options.fresh.intentPath));
report.intentSourceBefore = original;
const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const outer = result.structuredContent as Record<string, unknown> | undefined;
  const nested = outer?.result as { content?: string } | undefined;
  if (typeof nested?.content === "string") {
    try { return JSON.parse(nested.content) as Record<string, unknown>; } catch { return { text: nested.content }; }
  }
  return outer ?? {};
};
try {
  process.stdout.write("Fresh native preparation and startup...\n");
  const startupStarted = performance.now();
  toolbox = await createNativeToolbox(options);
  report.startupMs = performance.now() - startupStarted;
  client = new Client({ name: "evleda-fresh-native-smoke", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    process.stdout.write(`${name}\n`);
    const started = performance.now();
    const result = await client!.callTool({ name, arguments: args }, { timeout: 180_000 });
    (report.operations as unknown[]).push({ name, arguments: args, durationMs: performance.now() - started, result });
    if (result.isError) throw new Error(`${name} returned an error; inspect retained operation evidence.`);
    return parseResult(result);
  };
  report.status = await call("evleda_toolbox_status");
  const context = await call("evleda_design_context");
  const contract = context.contract as PcbDesignContract;
  if (contract.components.length !== 3 || contract.components.some(component => !["J1", "R1", "R2"].includes(component.reference))) {
    throw new Error("This authoring smoke is restricted to the existing three-component divider fixture.");
  }
  report.initialSymbols = await call("sch_get_symbols");
  const positions = { J1: [101.6, 101.6], R1: [127, 101.6], R2: [127, 127] } as const;
  for (const component of contract.components) {
    const [library, symbol_name] = component.symbolLibId.split(":");
    const position = positions[component.reference as keyof typeof positions];
    await call("sch_add_symbol", { library: library!, symbol_name: symbol_name!, x_mm: position[0], y_mm: position[1],
      reference: component.reference, value: component.value, footprint: component.footprintLibId, rotation: 0, unit: 1, snap_to_grid: true });
  }
  let connectivity = await call("fresh_apply_contract_connectivity");
  if (connectivity.applied === false && connectivity.recommendationIdentity !== undefined) {
    await call("fresh_apply_recommended_schematic_placement", { recommendationIdentity: connectivity.recommendationIdentity });
    connectivity = await call("fresh_apply_contract_connectivity");
  }
  if (connectivity.applied !== true) throw new Error("Fresh connectivity was not applied; no PCB sync attempted.");
  await call("fresh_autoplace_schematic_fields");
  report.sync = await call("fresh_sync_from_schematic");
  report.padPositions = await call("fresh_get_contract_pad_positions");
  report.practices = await call("evleda_check_board_practices");
  report.authoringAndSyncCompleted = true;
} catch (error) {
  report.error = formatNativeToolboxError(error); process.exitCode = 1;
} finally {
  if (toolbox !== undefined) {
    try {
      const beforeClose = path.join(options.outputDir, "source-before-close");
      await mkdir(beforeClose);
      for (const extension of ["kicad_pcb", "kicad_sch", "kicad_pro"] as const) {
        const name = `${options.fresh.name}.${extension}`;
        await copyFile(path.join(options.outputDir, "project", name), path.join(beforeClose, name));
      }
    } catch (error) { report.diagnosticSnapshotError = formatNativeToolboxError(error); }
  }
  const cleanupStarted = performance.now();
  try { await toolbox?.close(); report.nativeCleanupConfirmed = toolbox === undefined ? null : true; }
  catch (error) { report.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
  report.cleanupMs = performance.now() - cleanupStarted;
  await client?.close().catch(() => undefined);
  report.intentSourceAfter = contentIdentity(await readFile(options.fresh.intentPath));
  report.sourceUnchanged = JSON.stringify(original) === JSON.stringify(report.intentSourceAfter);
  if (!report.sourceUnchanged) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(options.outputDir, "fresh-native-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ authoringAndSyncCompleted: report.authoringAndSyncCompleted ?? false,
    nativeCleanupConfirmed: report.nativeCleanupConfirmed, error: report.error, cleanupError: report.cleanupError,
    report: path.join(options.outputDir, "fresh-native-smoke.json") }, null, 2)}\n`);
}
