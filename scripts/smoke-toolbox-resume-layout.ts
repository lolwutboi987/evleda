/** Real resume + compact divider layout proof through the public MCP tools. */
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import { parseFreshPcbSource } from "../src/harness/fresh-kicad-parser.js";

const options = parseNativeToolboxArgs(process.argv.slice(2));
if (options?.fresh === undefined || !options.resume || !options.edit) throw new Error("Layout proof requires --new-project <saved-name> --resume --edit and the existing host profile/roots.");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), operations: [],
  scope: "Native resume, placement and 45-degree routing integration proof; no manufacturing approval." };
let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
let client: Client | undefined;
const unpack = (result: CallToolResult): Record<string, unknown> => {
  const outer = result.structuredContent as Record<string, unknown> | undefined;
  const nested = outer?.result as { content?: string } | undefined;
  if (nested?.content !== undefined) { try { return JSON.parse(nested.content); } catch { return { text: nested.content }; } }
  return outer ?? {};
};
try {
  const started = performance.now();
  process.stdout.write("Resuming authenticated native project...\n");
  toolbox = await createNativeToolbox(options); report.resumeMs = performance.now() - started;
  client = new Client({ name: "evleda-resume-layout-proof", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    process.stdout.write(`${name}\n`); const start = performance.now();
    const result = await client!.callTool({ name, arguments: args }, { timeout: 180_000 });
    (report.operations as unknown[]).push({ name, arguments: args, durationMs: performance.now() - start, result });
    if (result.isError) throw new Error(`${name} failed; inspect retained evidence.`);
    return unpack(result);
  };
  const context = await call("evleda_design_context"); report.context = context;
  const contract = context.contract as { components: { reference: string }[]; nets: { name: string }[] };
  if (contract.components.map(x => x.reference).sort().join() !== "J1,R1,R2" || contract.nets.map(x => x.name).sort().join() !== "GND,VIN,VOUT") {
    throw new Error("Layout proof is restricted to the reviewed divider fixture.");
  }
  const pcbPath = path.join(options.outputDir, "project", options.board);
  const initial = parseFreshPcbSource(await readFile(pcbPath, "utf8"));
  if (initial.outlineBounds !== null || initial.segments.length !== 0 || initial.vias.length !== 0) throw new Error("Layout proof requires the checkpointed, unrouted no-outline source; it never duplicates existing geometry.");
  await call("pcb_set_board_outline", { width_mm: 30, height_mm: 20, origin_x_mm: 0, origin_y_mm: 0 });
  for (const placement of [
    { reference: "J1", x_mm: 3, y_mm: 7, rotation_deg: 0 },
    { reference: "R1", x_mm: 10, y_mm: 7.825, rotation_deg: 270 },
    { reference: "R2", x_mm: 18, y_mm: 9.475, rotation_deg: 270 },
  ]) await call("pcb_move_footprint", placement);
  const padReport = await call("fresh_get_contract_pad_positions"); report.padPositions = padReport;
  const expected = [
    ["J1", "1", "VIN", 3, 7], ["J1", "2", "VOUT", 3, 9.54], ["J1", "3", "GND", 3, 12.08],
    ["R1", "1", "VIN", 10, 7], ["R1", "2", "VOUT", 10, 8.65], ["R2", "1", "VOUT", 18, 8.65], ["R2", "2", "GND", 18, 10.3],
  ] as const;
  const pads = padReport.pads as { reference: string; pad: string; net: string; xMm: number; yMm: number; layers: string[] }[];
  if (!Array.isArray(pads) || pads.length !== expected.length) throw new Error("Unexpected native physical pad inventory; no copper added.");
  for (const [reference, pad, net, x, y] of expected) {
    const hits = pads.filter(value => value.reference === reference && value.pad === pad && value.net === net);
    if (hits.length !== 1 || Math.abs(hits[0]!.xMm - x) > 1e-6 || Math.abs(hits[0]!.yMm - y) > 1e-6 || !hits[0]!.layers.includes("F.Cu")) {
      throw new Error(`Native pad ${reference}.${pad} differs from the verified route plan; no copper added.`);
    }
  }
  const routes = [
    { net: "VIN", width: 0.5, points: [[3, 7], [10, 7]] },
    { net: "VOUT", width: 0.25, points: [[3, 9.54], [7, 9.54], [7.89, 8.65], [10, 8.65], [18, 8.65]] },
    { net: "GND", width: 0.5, points: [[3, 12.08], [14, 12.08], [15.78, 10.3], [18, 10.3]] },
  ];
  for (const route of routes) {
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1]!, b = route.points[index]!;
      await call("pcb_add_track", { x1_mm: a[0], y1_mm: a[1], x2_mm: b[0], y2_mm: b[1], layer: "F.Cu", width_mm: route.width, net_name: route.net });
    }
  }
  const saved = parseFreshPcbSource(await readFile(pcbPath, "utf8"));
  if (saved.segments.length !== 8 || saved.viaCount !== 0 || !saved.outlineSupported) throw new Error("Saved route inventory differs from planned geometry.");
  const counts: Record<string, number> = { VIN: 0, VOUT: 0, GND: 0 };
  for (const segment of saved.segments) {
    if (segment.netName === null || !Object.hasOwn(counts, segment.netName) || segment.layer !== "F.Cu"
      || Math.abs(segment.widthMm - (segment.netName === "VOUT" ? 0.25 : 0.5)) > 1e-6) throw new Error("Saved track net/layer/width differs from the required layout.");
    counts[segment.netName] = counts[segment.netName]! + 1;
  }
  if (counts.VIN !== 1 || counts.VOUT !== 4 || counts.GND !== 3 || JSON.stringify(saved.outlineBounds) !== JSON.stringify({ minX: 0, minY: 0, maxX: 30, maxY: 20 })) {
    throw new Error("Saved per-net segment counts or board dimensions differ from the required layout.");
  }
  report.practices = await call("evleda_check_board_practices");
  report.validation = await call("evleda_validate_design");
  const practices = (report.practices as { report: { turnPolicy: { violations: unknown[]; unresolvedFindings: unknown[] }; analysis: { findings: { severity: string }[] } } }).report;
  if (practices.turnPolicy.violations.length || practices.turnPolicy.unresolvedFindings.length
    || practices.analysis.findings.some(finding => finding.severity === "error")) throw new Error("PCB practice findings remain; layout is not accepted.");
  const checks = (report.validation as { checks: { name: string; result: { content: string; isError?: boolean } }[] }).checks;
  for (const name of ["run_erc", "run_drc"] as const) {
    const result = checks.find(check => check.name === name)?.result;
    const data = result === undefined ? undefined : JSON.parse(result.content);
    if (result?.isError || data?.verdict !== "PASS" || data?.status !== "clean"
      || (name === "run_erc" ? data?.metadata?.violation_count !== 0 : data?.metadata?.violations !== 0 || data?.metadata?.unconnected_items !== 0)) {
      throw new Error(`${name} did not establish zero violations/unconnected items under configured checks.`);
    }
  }
  report.layoutAndNativeChecksCompleted = true;
  report.finish = await call("evleda_finish_session");
} catch (error) { report.error = formatNativeToolboxError(error); process.exitCode = 1; }
finally {
  const cleanupStarted = performance.now();
  try { await toolbox?.close(); report.checkpointAndCleanupConfirmed = toolbox === undefined ? null : true; }
  catch (error) { report.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
  report.cleanupMs = performance.now() - cleanupStarted;
  await client?.close().catch(() => undefined); report.finishedAt = new Date().toISOString();
  const reportPath = path.join(options.outputDir, `resume-layout-proof-${randomUUID()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ layoutAndNativeChecksCompleted: report.layoutAndNativeChecksCompleted ?? false,
    checkpointAndCleanupConfirmed: report.checkpointAndCleanupConfirmed, error: report.error, cleanupError: report.cleanupError, reportPath }, null, 2)}\n`);
}
