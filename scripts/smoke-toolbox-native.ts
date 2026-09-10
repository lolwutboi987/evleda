/** Real native smoke on an isolated copy, using the same host startup as stdio.
 * With --edit, briefly moves the first footprint 0.25 mm, verifies saved bytes,
 * then restores its original placement. This is not a PCB design-quality test.
 */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentIdentity } from "../src/core/canonical.js";
import { nativeProjectFingerprint } from "../src/cli/pcb-agent.js";
import { parseFreshPcbSource } from "../src/harness/fresh-kicad-parser.js";
import { createNativeToolbox, parseNativeToolboxArgs } from "../src/mcp/toolbox-native-main.js";

const options = parseNativeToolboxArgs(process.argv.slice(2));
if (options === undefined) throw new Error("Pass the native toolbox host arguments; see pnpm mcp:toolbox:native --help.");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), source: options.projectDir,
  output: options.outputDir, scope: "Native copied-project MCP operation smoke; not board acceptance or manufacturing approval." };
const original = await nativeProjectFingerprint(options.projectDir);
let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
let client: Client | undefined;
try {
  process.stdout.write("Native startup...\n");
  toolbox = await createNativeToolbox(options);
  client = new Client({ name: "evleda-native-smoke", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  report.status = await client.callTool({ name: "evleda_toolbox_status", arguments: {} });
  report.tools = await client.listTools();
  report.footprintsBefore = await client.callTool({ name: "pcb_get_footprints", arguments: {} });
  process.stdout.write("Native read completed.\n");
  if (options.edit) {
    const pcb = path.join(options.outputDir, "project", options.board);
    const before = await readFile(pcb, "utf8");
    const selected = parseFreshPcbSource(before).footprints[0];
    if (selected === undefined) throw new Error("Smoke edit requires at least one footprint in the copied fixture.");
    const call = async (x: number, label: string) => {
      const result = await client!.callTool({ name: "pcb_move_footprint", arguments: {
        reference: selected.reference, x_mm: x, y_mm: selected.at.y, rotation_deg: selected.rotationDeg,
      } });
      report[label] = result;
      if (result.isError) throw new Error(`Native ${label} returned an error; inspect the retained report.`);
      const saved = await readFile(pcb, "utf8");
      const observed = parseFreshPcbSource(saved).footprints.find(item => item.reference === selected.reference);
      if (observed === undefined || Math.abs(observed.at.x - x) > 1e-6 || Math.abs(observed.at.y - selected.at.y) > 1e-6
        || Math.abs(observed.rotationDeg - selected.rotationDeg) > 1e-6) throw new Error(`Native ${label} was not observed in saved PCB placement.`);
      report[`${label}SavedIdentity`] = contentIdentity(saved);
      return saved;
    };
    const moved = await call(selected.at.x + 0.25, "move");
    if (moved === before) throw new Error("Native move did not change saved PCB bytes.");
    process.stdout.write("Native edit and save verified. Restoring fixture placement...\n");
    await call(selected.at.x, "restore");
    report.placementRestored = true;
  }
  report.validation = await client.callTool({ name: "evleda_validate_design", arguments: {} }, { timeout: 120_000 });
  report.operationCycleCompleted = true;
  process.stdout.write("Native validation collection returned. Closing owned processes...\n");
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error); process.exitCode = 1;
} finally {
  try { await toolbox?.close(); report.nativeCleanupConfirmed = toolbox === undefined ? null : true; }
  catch (error) { report.cleanupError = error instanceof Error ? error.stack ?? error.message : String(error); process.exitCode = 1; }
  await client?.close().catch(() => undefined);
  report.sourceUnchanged = original === await nativeProjectFingerprint(options.projectDir);
  if (!report.sourceUnchanged) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(options.outputDir, "native-toolbox-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ operationCycleCompleted: report.operationCycleCompleted ?? false,
    nativeCleanupConfirmed: report.nativeCleanupConfirmed ?? null, sourceUnchanged: report.sourceUnchanged,
    error: report.error, cleanupError: report.cleanupError, report: path.join(options.outputDir, "native-toolbox-smoke.json") }, null, 2)}\n`);
}
