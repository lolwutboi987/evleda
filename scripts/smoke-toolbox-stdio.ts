/** Real local stdio client proof; does not claim a ChatGPT UI/account connection. */
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import { parseFreshPcbSource, parseFreshPcbTextItems } from "../src/harness/fresh-kicad-parser.js";
import { nativeProjectFingerprint } from "../src/cli/pcb-agent.js";
import { freshBoardSerializationsEqual } from "../src/harness/fresh-board-serialization.js";

const nativeArgs = process.argv.slice(2);
const options = parseNativeToolboxArgs(nativeArgs);
if (options === undefined || options.fresh !== undefined && !options.resume || options.fresh === undefined && options.edit) {
  throw new Error("Stdio proof requires a fresh --resume project or a read-only copied project with its host profile.");
}
const repository = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(options.outputDir, `stdio-proof-${randomUUID()}`);
const pcbPath = path.join(options.outputDir, "project", options.board);
const beforeBytes = await readFile(options.fresh === undefined ? path.join(options.projectDir, options.board) : pcbPath);
const originalProject = options.fresh === undefined ? await nativeProjectFingerprint(options.projectDir) : null;
const before = parseFreshPcbSource(beforeBytes.toString("utf8"));
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), pcbBefore: contentIdentity(beforeBytes), operations: [],
  scope: "Real native stdio MCP handshake, preview resources/images, optional bounded labels, checks and explicit finish. Not a ChatGPT UI deployment or manufacturing approval." };
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && ["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())) environment[key] = value;
}
const transport = new StdioClientTransport({ command: process.execPath,
  args: ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href, path.join(repository, "src/mcp/toolbox-native-main.ts"), ...nativeArgs],
  cwd: repository, env: environment, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-32_000); });
const client = new Client({ name: "evleda-real-stdio-proof", version: "1.0.0" }, { versionNegotiation: { mode: "legacy" } });
let connected = false, finished = false;
const recordResult = (result: CallToolResult) => ({ ...result, content: result.content.map(item => item.type === "image"
  ? { type: "image", mimeType: item.mimeType, receivedIdentity: contentIdentity(Buffer.from(item.data, "base64")) }
  : item) });
async function call(name: string, args: Record<string, unknown> = {}) {
  process.stdout.write(`${name}\n`); const started = performance.now();
  const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
  (report.operations as unknown[]).push({ name, arguments: args, durationMs: performance.now() - started, result: recordResult(result) });
  if (result.isError) throw new Error(`${name} returned an error; inspect the retained stdio report.`);
  return result;
}
try {
  process.stdout.write("Connecting real native stdio server (180-second startup budget)...\n");
  const started = performance.now(); await client.connect(transport, { timeout: 180_000 }); connected = true;
  report.connectMs = performance.now() - started;
  await mkdir(output);
  await writeFile(path.join(output, "source-before-operations.kicad_pcb"), beforeBytes, { flag: "wx" });
  const status = await call("evleda_toolbox_status");
  if ((status.structuredContent as Record<string, unknown> | undefined)?.cadConnected !== true) throw new Error("Native stdio connection is not bound to its active PCB.");
  const tools = await client.listTools(); report.tools = tools;
  if (tools.tools.some(tool => tool.name === "evleda_transmission_line")) {
    const calculation = await call("evleda_transmission_line", { model: "coupled_microstrip", operation: "synthesize", fixed: "width", targetOhm: 90,
      parameters: { EPSILONR: 4.2, H: 0.0002, T: 0.000035, PHYS_WIDTH: 0.0003, PHYS_S: 0.0002,
        PHYS_LEN: 0.01, FREQUENCY: 1e9, SIGMA: 5.8e7, MURC: 1, H_T: 1, ROUGH: 0, TAND: 0.02 } });
    const value = calculation.structuredContent as { status?: string; boardVerificationPerformed?: boolean; targetResidualOhm?: number } | undefined;
    if (value?.status !== "calculated" || value.boardVerificationPerformed !== false || typeof value.targetResidualOhm !== "number"
      || Math.abs(value.targetResidualOhm) > 0.0002) throw new Error("Optional calculator did not return its expected explicit-input analytical result.");
    report.calculatorFixture = { unrelatedSyntheticCrossSection: true, notBoardStackupOrImpedanceEvidence: true, result: recordResult(calculation) };
  }
  const expectedLabels = [{ text: "VIN", x_mm: 5, y_mm: 6.1 }, { text: "VOUT", x_mm: 5, y_mm: 8.8 }, { text: "GND", x_mm: 5, y_mm: 11.4 }] as const;
  if (options.edit) {
    if (before.footprints.map(item => item.reference).sort().join() !== "J1,R1,R2" || before.segments.length !== 8
      || parseFreshPcbTextItems(beforeBytes.toString("utf8")).length !== 0) throw new Error("Label smoke requires the routed three-component divider without preexisting board text.");
    for (const label of expectedLabels) {
      await call("pcb_add_text", { ...label, layer: "F_SilkS", size_mm: 0.8, rotation_deg: 0, bold: false, italic: false });
    }
    const savedSource = await readFile(pcbPath, "utf8");
    const savedLabels = parseFreshPcbTextItems(savedSource);
    // A reopened native save can spell -90-degree footprint-child angles as
    // 270. Compare all remaining source through the audited lexical comparator,
    // not raw numeric spellings in the parsed geometry projection.
    let withoutLabels = savedSource;
    for (const label of [...savedLabels].sort((a, b) => b.start - a.start)) withoutLabels = withoutLabels.slice(0, label.start) + withoutLabels.slice(label.end);
    if (!freshBoardSerializationsEqual(beforeBytes.toString("utf8"), withoutLabels)) throw new Error("Adding labels changed preexisting board content beyond audited native serialization.");
    report.preexistingBoardContentPreserved = true;
    if (savedLabels.length !== expectedLabels.length || new Set(savedLabels.map(item => item.id)).size !== expectedLabels.length) throw new Error("Saved board does not contain exactly three distinct label items.");
    for (const expected of expectedLabels) {
      const matches = savedLabels.filter(item => item.text === expected.text);
      const label = matches[0], presentation = label?.presentation;
      if (matches.length !== 1 || label?.id === null || label?.supported !== true || label.layer !== "F.SilkS"
        || presentation?.at?.x !== expected.x_mm || presentation.at.y !== expected.y_mm
        || (presentation.rotationDeg ?? 0) !== 0 || presentation.fontSizeMm?.x !== 0.8 || presentation.fontSizeMm.y !== 0.8
        || presentation.hidden || presentation.bold || presentation.italic
        || presentation.justify?.length !== 2 || !presentation.justify.includes("left") || !presentation.justify.includes("bottom")) {
        throw new Error(`Saved ${expected.text} label differs from its requested position/presentation.`);
      }
    }
    report.savedLabels = savedLabels;
  }
  for (const view of ["top", "assembly"] as const) {
    const result = await call("evleda_render_board", { view });
    const images = result.content.filter(item => item.type === "image"), resources = result.content.filter(item => item.type === "resource_link");
    const image = images[0], resource = resources[0];
    if (images.length !== 1 || resources.length !== 1 || image?.type !== "image" || resource?.type !== "resource_link"
      || image.mimeType !== "image/png" || resource.mimeType !== "image/svg+xml") throw new Error("Stdio preview omitted its one PNG image or native SVG resource.");
    const metadata = result.structuredContent as { resourceUri?: string; sourceUnchanged?: boolean; sourceBefore?: string; sourceAfter?: string;
      pcbSvg?: { sha256?: string; sizeBytes?: number }; png?: { identity?: unknown; width?: number; height?: number; sourceSvgSha256?: string; mimeType?: string } } | undefined;
    const png = Buffer.from(image.data, "base64");
    if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("Preview image is not PNG.");
    if (metadata?.png?.mimeType !== "image/png" || canonicalJson(contentIdentity(png)) !== canonicalJson(metadata.png.identity)
      || png.readUInt32BE(16) !== metadata.png.width || png.readUInt32BE(20) !== metadata.png.height
      || metadata.png.sourceSvgSha256 !== metadata.pcbSvg?.sha256 || metadata.resourceUri !== resource.uri
      || metadata.sourceUnchanged !== true || typeof metadata.sourceBefore !== "string" || metadata.sourceBefore !== metadata.sourceAfter) {
      throw new Error("Received PNG or source binding differs from the exact returned preview metadata.");
    }
    await writeFile(path.join(output, `received-${view}.png`), png, { flag: "wx" });
    const svg = await client.readResource({ uri: resource.uri });
    const content = svg.contents[0];
    if (svg.contents.length !== 1 || content === undefined || !("text" in content) || content.mimeType !== "image/svg+xml" || content.uri !== resource.uri) throw new Error("Native SVG resource was not readable over stdio.");
    const svgIdentity = contentIdentity(Buffer.from(content.text, "utf8"));
    if (svgIdentity.digest !== metadata.pcbSvg?.sha256 || svgIdentity.size !== metadata.pcbSvg?.sizeBytes
      || resource.uri !== `evleda://pcb-preview/${svgIdentity.digest}/${view}`) throw new Error("Received SVG differs from its exact returned metadata/resource identity.");
    await writeFile(path.join(output, `received-${view}.svg`), content.text, { flag: "wx" });
  }
  const practiceResult = await call("evleda_check_board_practices"); report.practices = recordResult(practiceResult);
  const practiceData = practiceResult.structuredContent as { sourceUnchanged?: boolean; report?: {
    turnPolicy?: { violations?: unknown[]; unresolvedFindings?: unknown[] }; analysis?: { findings?: { severity: string }[] } } } | undefined;
  const practice = practiceData?.report;
  if (practiceData?.sourceUnchanged !== true || !Array.isArray(practice?.turnPolicy?.violations) || practice.turnPolicy.violations.length !== 0
    || !Array.isArray(practice.turnPolicy.unresolvedFindings) || practice.turnPolicy.unresolvedFindings.length !== 0
    || (options.fresh !== undefined && !Array.isArray(practice.analysis?.findings))
    || practice.analysis?.findings?.some(finding => finding.severity === "error")) {
    throw new Error("Board practices did not establish zero turn violations/unresolved findings/errors.");
  }
  const validationResult = await call("evleda_validate_design"); report.validation = recordResult(validationResult);
  const validation = validationResult.structuredContent as { sourceUnchanged?: boolean; checks?: { name: string; result: { content: string; isError?: boolean } }[] } | undefined;
  if (validation?.sourceUnchanged !== true || !Array.isArray(validation.checks)) throw new Error("Native checks lack unchanged-source validation evidence.");
  for (const name of ["run_erc", "run_drc"] as const) {
    const matches = validation.checks.filter(check => check.name === name);
    const result = matches[0]?.result;
    const data = result === undefined ? undefined : JSON.parse(result.content);
    if (matches.length !== 1 || result?.isError || data?.verdict !== "PASS" || data?.status !== "clean"
      || (name === "run_erc" ? data?.metadata?.violation_count !== 0 : data?.metadata?.violations !== 0 || data?.metadata?.unconnected_items !== 0)) {
      throw new Error(`${name} did not establish zero violations/unconnected items under configured checks.`);
    }
  }
  const finish = await call("evleda_finish_session"); report.finish = finish.structuredContent;
  const finishData = finish.structuredContent as Record<string, unknown> | undefined;
  finished = finishData?.nativeSessionClosed === true && finishData?.recoveryRequired === false
    && finishData?.checkpointPublished === (options.fresh !== undefined);
  if (!finished) throw new Error("Stdio finish did not confirm native closure and the expected checkpoint disposition.");
  report.stdioWorkflowCompleted = true;
} catch (error) { report.error = formatNativeToolboxError(error); process.exitCode = 1; }
finally {
  if (connected && !finished) {
    try { report.cleanupFinish = recordResult(await client.callTool({ name: "evleda_finish_session", arguments: {} }, { timeout: 180_000 })); }
    catch (error) { report.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
  }
  await client.close().catch(error => { report.clientCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
  await transport.close().catch(error => { report.transportCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
  if (originalProject !== null) {
    report.originalProjectBefore = originalProject;
    report.originalProjectAfter = await nativeProjectFingerprint(options.projectDir);
    report.originalProjectUnchanged = originalProject === report.originalProjectAfter;
    if (!report.originalProjectUnchanged) process.exitCode = 1;
  }
  await mkdir(output, { recursive: true });
  report.stderr = stderr; report.pcbAfter = contentIdentity(await readFile(pcbPath)); report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ stdioWorkflowCompleted: report.stdioWorkflowCompleted ?? false, error: report.error, output }, null, 2)}\n`);
}
