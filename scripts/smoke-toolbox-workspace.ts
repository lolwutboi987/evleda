/** Real workspace STDIO proof. Drafts travel over MCP; native use is explicit. */
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parseToolboxWorkspaceArgs } from "../src/mcp/toolbox-workspace-main.js";
import { formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";

const { values } = parseArgs({ strict: true, options: { profile: { type: "string" }, "profile-sha256": { type: "string" },
  "profile-bytes": { type: "string" }, "workspace-root": { type: "string" }, fixture: { type: "string" },
  "report-dir": { type: "string" }, "exercise-native": { type: "boolean", default: false }, "resume-project": { type: "string" } } });
if (!values.fixture || !values["report-dir"]) throw new Error("Pass --fixture and --report-dir plus host workspace/profile arguments.");
const serverArgs = ["--profile", values.profile!, "--profile-sha256", values["profile-sha256"]!, "--profile-bytes", values["profile-bytes"]!,
  "--workspace-root", values["workspace-root"]!, ...(values["exercise-native"] ? ["--edit"] : [])];
const options = parseToolboxWorkspaceArgs(serverArgs)!;
const repository = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(values["report-dir"], `workspace-proof-${randomUUID()}`); await mkdir(output, { recursive: true });
const draft = JSON.parse(await readFile(path.resolve(values.fixture), "utf8"));
const family = draft.schemaVersion === "evleda.pcb-design-intent-draft.v2" ? "plane-v2" : "routed-v1";
const projectName = family === "plane-v2" ? "workspace-plane-divider" : "workspace-divider";
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && ["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())) environment[key] = value;
const transport = new StdioClientTransport({ command: process.execPath, cwd: repository, env: environment, stderr: "pipe",
  args: ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href, path.join(repository, "src/mcp/toolbox-workspace-main.ts"), ...serverArgs] });
let stderr = ""; transport.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-32_000); });
const client = new Client({ name: "evleda-workspace-stdio-proof", version: "1" }, { versionNegotiation: { mode: "legacy" } });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), operations: [], family,
  scope: "Destination qualification of real STDIO workspace draft discovery/clarification/create/retry, optional native authoring/endpoint inspection and persisted-ID resume. This intentionally unrouted lifecycle fixture does not replace the transferred complete-board proof or establish application installation or design acceptance." };
let projectId: string | undefined, connected = false;
const body = (value: CallToolResult): Record<string, unknown> => {
  const outer = value.structuredContent as Record<string, unknown> | undefined;
  const nested = outer?.result as { content?: string } | undefined;
  return nested?.content === undefined ? outer ?? {} : JSON.parse(nested.content);
};
async function call(name: string, args: Record<string, unknown> = {}) {
  process.stdout.write(`${name}\n`); const started = performance.now();
  const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
  const operations = report.operations as unknown[];
  const operation = { name, arguments: args, durationMs: performance.now() - started, result };
  operations.push(operation);
  await writeFile(path.join(output, `operation-${String(operations.length).padStart(3, "0")}.json`), `${JSON.stringify(operation, null, 2)}\n`, { flag: "wx" });
  if (result.isError) throw new Error(`${name} failed; inspect retained workspace report.`);
  return body(result);
}
async function sourceSnapshot(opened: Record<string, unknown>) {
  assert.equal(typeof opened.projectPath, "string");
  assert.equal(typeof opened.outputPath, "string");
  assert.equal(typeof opened.name, "string");
  const projectPath = opened.projectPath as string, outputPath = opened.outputPath as string, name = opened.name as string;
  const sources = await Promise.all([`${name}.kicad_pcb`, `${name}.kicad_sch`, `${name}.kicad_pro`,
    ...(family === "plane-v2" ? [`${name}.kicad_dru`] : []), "sym-lib-table", "fp-lib-table"]
    .map(async filename => ({ filename, identity: contentIdentity(await readFile(path.join(projectPath, filename))) })));
  const bundle = JSON.parse(await readFile(path.join(outputPath, "toolbox-design-bundle.json"), "utf8"));
  if (family === "plane-v2") {
    assert.equal(bundle.schemaVersion, "evleda.pcb-design-compilation-bundle.v2");
    assert.equal(bundle.contract.schemaVersion, "evleda.pcb-design-contract.v2");
    const marker = JSON.parse(await readFile(path.join(outputPath, ".evleda-pcb-agent-fresh.json"), "utf8"));
    const checkpoint = JSON.parse(await readFile(path.join(outputPath, ".evleda-pcb-agent-checkpoint.json"), "utf8"));
    assert.equal(marker.schemaVersion, "evleda.pcb-agent-fresh-project.v3");
    assert.equal(checkpoint.schemaVersion, "evleda.pcb-agent-fresh-project-checkpoint.v3");
    const dru = sources.find(source => source.filename.endsWith(".kicad_dru"))!.identity;
    assert.equal(marker.files.dru.sha256, dru.digest);
    assert.equal(checkpoint.files.dru.sha256, dru.digest);
  }
  return { sources, bundleIdentity: bundle.identity };
}
async function inspectPlaneEndpoints(opened: Record<string, unknown>, label: string) {
  const endpoint = await call("evleda_check_endpoint_connectivity");
  assert.equal(endpoint.sourceUnchanged, true);
  assert.equal(endpoint.sourceBefore, endpoint.sourceAfter);
  assert.equal(endpoint.recoveryRequired, false);
  const summary = endpoint.report as Record<string, unknown>;
  assert.equal(summary.schemaVersion, "evleda.toolbox-endpoint-connectivity.v1");
  assert.equal(summary.family, "plane-v2");
  assert.equal(summary.acceptanceEvaluated, false);
  assert.equal(summary.fabricationAuthorized, false);
  // No copper is authored by this workspace lifecycle proof. Placed pads must
  // report all three nets disconnected, rather than upgrading creation to ready hardware.
  assert.equal(summary.status, "disconnected");
  const nets = summary.nets as { net: string; status: string }[];
  assert.deepEqual(nets.map(net => net.net).sort(), ["GND", "VIN", "VOUT"]);
  assert.ok(nets.every(net => net.status === "disconnected"));
  const diagnostic = endpoint.diagnostic as { filename: string; identity: unknown };
  assert.match(diagnostic.filename, /^endpoint-connectivity-[a-f0-9-]+\.json$/u);
  assert.equal(canonicalJson(contentIdentity(await readFile(path.join(opened.outputPath as string, ".evleda-mcp-output", diagnostic.filename)))), canonicalJson(diagnostic.identity));
  report[label] = endpoint;
}
async function capturePreviews() {
  const previews = [];
  for (const view of ["top", "assembly"] as const) {
    const metadata = await call("evleda_render_board", { view });
    const raw = (report.operations as { result: CallToolResult }[]).at(-1)!.result;
    const images = raw.content.filter(item => item.type === "image");
    const links = raw.content.filter(item => item.type === "resource_link");
    assert.equal(images.length, 1); assert.equal(links.length, 1);
    const png = Buffer.from(images[0]!.data, "base64");
    assert.equal(images[0]!.mimeType, "image/png");
    const pngIdentity = contentIdentity(png);
    assert.equal(canonicalJson(pngIdentity), canonicalJson((metadata.png as { identity: unknown }).identity));
    assert.equal(metadata.sourceUnchanged, true); assert.equal(metadata.sourceBefore, metadata.sourceAfter);
    const resource = await client.readResource({ uri: links[0]!.uri });
    assert.equal(resource.contents.length, 1);
    const svg = resource.contents[0]!; assert.ok("text" in svg);
    const svgIdentity = contentIdentity(svg.text);
    assert.equal(svgIdentity.digest, (metadata.pcbSvg as { sha256: string }).sha256);
    assert.equal(svgIdentity.size, (metadata.pcbSvg as { sizeBytes: number }).sizeBytes);
    const pngPath = path.join(output, `restart-${view}.png`), svgPath = path.join(output, `restart-${view}.svg`);
    await writeFile(pngPath, png, { flag: "wx" }); await writeFile(svgPath, svg.text, { flag: "wx" });
    previews.push({ view, pngPath, svgPath, pngIdentity, svgIdentity });
  }
  report.previews = previews;
}
try {
  const started = performance.now(); await client.connect(transport, { timeout: 30_000 }); connected = true;
  report.connectMs = performance.now() - started;
  const initial = await call("evleda_workspace_status");
  if (initial.nativeState !== "absent" || initial.activeProject !== null) throw new Error("Idle startup unexpectedly bound a native project.");
  const initialTools = await client.listTools(); report.initialTools = initialTools;
  if (initialTools.tools.some(tool => tool.name === "sch_add_symbol")) throw new Error("Idle server advertised unattached CAD tools.");
  report.schema = await call("evleda_design_schema", { family });
  if (family === "plane-v2") {
    const schema = report.schema as Record<string, unknown>;
    assert.equal(schema.family, family);
    assert.ok((schema.supportedFamilies as string[]).includes(family));
  }
  report.library = await call("evleda_inspect_library", { kind: "symbol", libraryId: "Device:R" });
  if (values["resume-project"] !== undefined) {
    const projects = await call("evleda_list_projects");
    if (!(projects.projects as { projectId: string }[]).some(project => project.projectId === values["resume-project"])) throw new Error("Requested restart project is absent from the persisted catalog.");
    projectId = values["resume-project"];
    const resumed = await call("evleda_resume_project", { projectId });
    if (resumed.status !== "opened" || resumed.resumed !== true) throw new Error("Fresh connection could not resume its saved project.");
    const beforeResumeReads = await sourceSnapshot(resumed);
    report.resumedPads = await call("fresh_get_contract_pad_positions");
    report.stackup = await call("evleda_read_stackup");
    if (family === "plane-v2") await inspectPlaneEndpoints(resumed, "restartEndpointConnectivity");
    await capturePreviews();
    await call("evleda_close_project", { projectId }); projectId = undefined;
    const afterResumeReads = await sourceSnapshot(resumed);
    assert.deepEqual(afterResumeReads, beforeResumeReads);
    report.sourceUnchangedThroughRestartReads = true;
    report.authoredSources = afterResumeReads;
    report.restartResumeCompleted = true;
  } else {
  const incomplete = structuredClone(draft); incomplete.netClasses[0].traceWidthMm = null;
  const clarification = await call("evleda_submit_design", { name: projectName, originalPrompt: "Build the reviewed divider integration fixture.", draft: incomplete });
  if (clarification.status !== "needs_clarification" || clarification.projectCreated !== false) throw new Error("Missing width did not return in-band clarification.");
  const empty = await call("evleda_list_projects");
  if (empty.total !== 0) throw new Error("This proof requires an empty workspace, and clarification must not allocate a project.");
  const ready = await call("evleda_submit_design", { name: projectName, originalPrompt: "Build the reviewed divider integration fixture.", draft });
  if (ready.status !== "ready" || typeof ready.draftId !== "string" || ready.projectCreated !== false) throw new Error("Complete draft was not ready without filesystem allocation.");
  report.draftId = ready.draftId;
  if (values["exercise-native"]) {
    projectId = ready.draftId;
    const opened = await call("evleda_create_project", { draftId: projectId });
    if (opened.status !== "opened" || opened.projectId !== projectId) throw new Error("Native project did not open from its in-band draft ID.");
    const repeated = await call("evleda_create_project", { draftId: projectId });
    if (repeated.status !== "already_created" || repeated.active !== true) throw new Error("Creation retry was not idempotent.");
    const attachedTools = await client.listTools(); report.attachedTools = attachedTools;
    if (!attachedTools.tools.some(tool => tool.name === "sch_add_symbol") || !attachedTools.tools.some(tool => tool.name === "evleda_read_stackup")) throw new Error("Attached CAD/stackup tools were not discoverable.");
    const context = await call("evleda_design_context");
    if (family === "plane-v2") {
      assert.equal(context.family, family);
      assert.equal(canonicalJson(context.bundleIdentity), canonicalJson(ready.bundleIdentity));
      assert.equal(context.acceptanceEvaluated, false);
      for (const name of ["fresh_apply_contract_plane", "fresh_replace_route_items", "evleda_check_endpoint_connectivity"]) {
        assert.ok(attachedTools.tools.some(tool => tool.name === name), `V2 workspace missing ${name}`);
      }
    }
    const contract = context.contract as { components: { reference: string; symbolLibId: string; footprintLibId: string; value: string }[] };
    if (contract.components.map(component => component.reference).sort().join() !== "J1,R1,R2") throw new Error("Authoring proof only handles the reviewed divider fixture.");
    const positions = { J1: [101.6, 101.6], R1: [127, 101.6], R2: [127, 127] } as const;
    for (const component of contract.components) {
      const [library, symbol_name] = component.symbolLibId.split(":"); const at = positions[component.reference as keyof typeof positions];
      await call("sch_add_symbol", { library, symbol_name, reference: component.reference, value: component.value,
        footprint: component.footprintLibId, x_mm: at[0], y_mm: at[1], rotation: 0, unit: 1, snap_to_grid: true });
    }
    let connectivity = await call("fresh_apply_contract_connectivity");
    if (connectivity.applied === false && connectivity.recommendationIdentity !== undefined) {
      await call("fresh_apply_recommended_schematic_placement", { recommendationIdentity: connectivity.recommendationIdentity });
      connectivity = await call("fresh_apply_contract_connectivity");
    }
    if (connectivity.applied !== true) throw new Error("Contract connectivity was not applied.");
    await call("fresh_autoplace_schematic_fields"); await call("fresh_sync_from_schematic");
    report.pads = await call("fresh_get_contract_pad_positions");
    if (family === "plane-v2") {
      const pads = report.pads as { schemaVersion: string; boardCounts: { physicalPadCount: number; logicalTerminalCount: number } };
      assert.equal(pads.schemaVersion, "evleda.fresh-plane-pad-positions.v1");
      assert.equal(pads.boardCounts.physicalPadCount, 7);
      assert.equal(pads.boardCounts.logicalTerminalCount, 7);
      await call("pcb_set_board_outline", { width_mm: 30, height_mm: 20, origin_x_mm: 0, origin_y_mm: 0 });
      for (const placement of [{ reference: "J1", x_mm: 3, y_mm: 7, rotation_deg: 0 },
        { reference: "R1", x_mm: 10, y_mm: 7.825, rotation_deg: 270 }, { reference: "R2", x_mm: 18, y_mm: 9.475, rotation_deg: 0 }]) {
        await call("pcb_move_footprint", placement);
      }
      await inspectPlaneEndpoints(opened, "freshEndpointConnectivity");
    }
    const stackup = await call("evleda_read_stackup"); report.stackup = stackup;
    if ((stackup.stackup as { status?: string }).status !== "missing" || stackup.impedanceValidation !== "not_performed") throw new Error("Blank-template stackup was incorrectly inferred or validated.");
    const closed = await call("evleda_close_project", { projectId });
    if (closed.status !== "closed") throw new Error("Workspace close did not confirm its lifecycle.");
    const savedSources = await sourceSnapshot(opened);
    assert.equal(canonicalJson(savedSources.bundleIdentity), canonicalJson(ready.bundleIdentity));
    const inactive = await call("evleda_workspace_status");
    if (inactive.activeProject !== null || inactive.nativeState !== "absent") throw new Error("Closed workspace still holds an active binding.");
    if ((await client.listTools()).tools.some(tool => tool.name === "sch_add_symbol")) throw new Error("Detached CAD tool remains advertised.");
    const resumed = await call("evleda_resume_project", { projectId });
    if (resumed.status !== "opened" || resumed.resumed !== true) throw new Error("Same-connection resume did not reopen its saved bundle.");
    report.resumedPads = await call("fresh_get_contract_pad_positions");
    if (family === "plane-v2") await inspectPlaneEndpoints(resumed, "resumedEndpointConnectivity");
    await call("evleda_close_project", { projectId }); projectId = undefined;
    const resumedSources = await sourceSnapshot(resumed);
    assert.deepEqual(resumedSources, savedSources);
    report.sourceUnchangedThroughResume = true;
    report.authoredSources = resumedSources;
    const projects = await call("evleda_list_projects");
    if (projects.total !== 1) throw new Error("Create/retry/resume did not retain exactly one workspace allocation.");
    report.nativeWorkflowCompleted = true;
  }
  }
  report.completed = true;
} catch (error) { report.error = formatNativeToolboxError(error); process.exitCode = 1; }
finally {
  if (connected && projectId !== undefined) {
    try { report.cleanup = await client.callTool({ name: "evleda_close_project", arguments: { projectId } }, { timeout: 180_000 }); }
    catch (error) { report.cleanupError = formatNativeToolboxError(error); }
  }
  await client.close().catch(error => { report.clientCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
  await transport.close().catch(error => { report.transportCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
  report.stderr = stderr; report.finishedAt = new Date().toISOString();
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`); await writeFile(path.join(output, "report.json"), bytes, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ completed: report.completed ?? false, nativeWorkflowCompleted: report.nativeWorkflowCompleted ?? false, restartResumeCompleted: report.restartResumeCompleted ?? false,
    connectMs: report.connectMs, error: report.error, reportPath: path.join(output, "report.json"), reportIdentity: contentIdentity(bytes) })}\n`);
}
