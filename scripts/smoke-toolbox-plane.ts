/** Bounded real native V2 plane-family author/sync/finish/resume smoke. Never plane copper acceptance. */
import assert from "node:assert/strict";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { copyFile, mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import type { PcbPlaneDesignContract } from "../src/harness/pcb-design-plane-contract.js";

// Post-proof diagnostic correction: plane results distinguish physical copper from logical terminals.
// These pure assertions are replay-tested offline against retained public MCP payloads; no native rerun implied.
function assertPlanePhysicalLogicalCounts(counts: Record<string, any>): void {
  assert.equal(counts.physicalPadCount, 7);
  assert.equal(counts.logicalTerminalCount, 7);
  assert.equal(counts.numberedCopperPrimitiveCount, 7);
  assert.equal(counts.namedCopperPrimitiveCount, 7);
  assert.equal(counts.logicalNamedTerminalCount, 7);
  assert.equal(counts.noConnectCopperPrimitiveCount, 0);
  assert.equal(counts.logicalNoConnectTerminalCount, 0);
  assert.equal(counts.nonElectricalFeatureCount, 0);
  assert.equal(counts.platedFootprintHoleCount, 3);
}
function assertPlaneSyncResult(sync: Record<string, any>): void {
  assert.equal(sync.schemaVersion, "evleda.fresh-plane-sync-from-schematic-result.v1");
  assert.equal(sync.applied, true);
  assert.equal(sync.componentCount, 3);
  assertPlanePhysicalLogicalCounts(sync);
  assert.equal(sync.unresolvedMappingCount, 0);
}
function assertPlanePadPositionsResult(pads: Record<string, any>): void {
  assert.equal(pads.schemaVersion, "evleda.fresh-plane-pad-positions.v1");
  assertPlanePhysicalLogicalCounts(pads.boardCounts);
  assert.equal(pads.status, "complete-selection", "This seven-pad fixture must return the complete physical selection.");
  assert.equal(pads.pads.length, 7);
  assert.deepEqual(pads.terminals.map((terminal: any) => `${terminal.reference}:${terminal.pad}:${terminal.net}`).sort(),
    ["J1:1:VIN", "J1:2:VOUT", "J1:3:GND", "R1:1:VIN", "R1:2:VOUT", "R2:1:VOUT", "R2:2:GND"].sort());
}

const options = parseNativeToolboxArgs(process.argv.slice(2));
if (options?.fresh?.intentPath === undefined || options.resume || !options.edit) throw new Error("Use one NEW plane intent with --edit, not resume input.");
const evidence = path.join(path.dirname(options.outputDir), "evidence-01");
const expected = JSON.parse(await readFile(path.join(options.projectDir, "expected-plane-bundle.json"), "utf8"));
const fixtureName = options.fresh.name;
const project = path.join(options.outputDir, "project");
const bundlePath = path.join(options.outputDir, "toolbox-design-bundle.json");
const markerPath = path.join(options.outputDir, ".evleda-pcb-agent-fresh.json");
const checkpointPath = path.join(options.outputDir, ".evleda-pcb-agent-checkpoint.json");
const druPath = path.join(project, `${fixtureName}.kicad_dru`);
const ipcRoot = "D:/EvlEDA-IPC";
const execFileAsync = promisify(execFile);
const report: Record<string, any> = { schemaVersion: "evleda.toolbox-plane-author-sync-resume-smoke.v1", startedAt: new Date().toISOString(),
  hostPid: process.pid, commandArguments: process.argv.slice(2), scope: "V2 plane-family schematic authoring, field repair, public-MCP sync, native reads and saved-candidate close/resume only.",
  noModel: true, planeCopperCreated: false, routingPerformed: false, minimumSpokesAcceptance: false, fullBoardFinishClaim: false, operations: [], phases: [] };
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const identity = async (file: string) => contentIdentity(await readFile(file));
async function record(name: string, value: unknown): Promise<void> { await writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
async function ipcInventory() { return Promise.all((await readdir(ipcRoot)).sort().map(async name => { const item = await lstat(path.join(ipcRoot, name)); return { name, birthtimeMs: item.birthtimeMs, mtimeMs: item.mtimeMs, directory: item.isDirectory() }; })); }
async function processes(label: string) {
  const { stdout } = await execFileAsync("C:/Users/pc/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(evidence, "observe-owned-processes.ps1"), "-OwnerPid", String(process.pid)],
    { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout); await record(`${label}-processes.json`, result); return result;
}
async function snapshot(label: string) {
  const target = path.join(evidence, label); await mkdir(target);
  const manifest: unknown[] = [];
  const pending = [options!.outputDir];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name); assert.ok(!entry.isSymbolicLink(), "Do not copy aliased native evidence.");
      const relative = path.relative(options!.outputDir, source), destination = path.join(target, relative);
      if (entry.isDirectory()) { await mkdir(destination, { recursive: true }); pending.push(source); }
      else if (entry.isFile()) { const before = await identity(source); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); const copied = await identity(destination), after = await identity(source); assert.deepEqual(copied, before); assert.deepEqual(after, before); manifest.push({ relative, identity: before }); }
    }
  }
  await record(`${label}-manifest.json`, manifest); return { directory: target, files: manifest.length };
}
const parseResult = (result: CallToolResult): Record<string, any> => {
  const outer = result.structuredContent as Record<string, any> | undefined;
  if (typeof outer?.result?.content === "string") { try { return JSON.parse(outer.result.content); } catch { return { text: outer.result.content }; } }
  return outer ?? {};
};
let ordinal = 0, baselineDru: Awaited<ReturnType<typeof identity>> | undefined, savedBundle: Awaited<ReturnType<typeof identity>> | undefined;
let savedAuthoredSources: { name: string; identity: Awaited<ReturnType<typeof identity>> }[] | undefined;
const sourceBefore = await identity(options.fresh.intentPath);
const profileBefore = await identity(options.profile.path);
const ipcBefore = await ipcInventory(); report.ipcBefore = ipcBefore; report.intentBefore = sourceBefore; report.profileBefore = profileBefore;
await record("launch-claimed.json", { at: new Date().toISOString(), hostPid: process.pid, output: options.outputDir, oneFreshPhaseAndOneSavedResumeOnly: true });

async function diskAuthority(label: string) {
  const marker = await json(markerPath), checkpoint = await json(checkpointPath), bundle = await json(bundlePath), dru = await identity(druPath);
  assert.equal(marker.schemaVersion, "evleda.pcb-agent-fresh-project.v3"); assert.equal(marker.workflowKind, "plane");
  assert.equal(marker.planeBinding.family, "plane-v2"); assert.equal(checkpoint.schemaVersion, "evleda.pcb-agent-fresh-project-checkpoint.v3");
  assert.equal(bundle.schemaVersion, "evleda.pcb-design-compilation-bundle.v2"); assert.equal(bundle.contract.schemaVersion, "evleda.pcb-design-contract.v2");
  assert.equal(canonicalJson(bundle), canonicalJson(expected));
  assert.equal(canonicalJson(marker.planeBinding.contractIdentity), canonicalJson(bundle.contract.identity));
  assert.equal(marker.files.dru.sha256, dru.digest); assert.deepEqual(marker.planeBinding.expectedRulesContentIdentity, dru);
  assert.equal(checkpoint.files.dru.sha256, dru.digest); assert.equal(canonicalJson(checkpoint.planeBindingIdentity), canonicalJson(marker.planeBinding.identity));
  if (baselineDru) assert.deepEqual(dru, baselineDru); else baselineDru = dru;
  const currentBundle = await identity(bundlePath); if (savedBundle) assert.deepEqual(currentBundle, savedBundle); else savedBundle = currentBundle;
  const value = { label, marker, checkpoint, bundleIdentity: bundle.identity, bundleFileIdentity: currentBundle, dru };
  await record(`${label}-authority.json`, value); return value;
}
async function phase(label: "fresh" | "resume") {
  let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
  let client: Client | undefined;
  let finished = false;
  const outcome: Record<string, any> = { label, startedAt: new Date().toISOString() }; report.phases.push(outcome);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++ordinal, started = performance.now(); process.stdout.write(`${label}: ${name}\n`);
    try {
      const result = await client!.callTool({ name, arguments: args }, { timeout: 180_000 });
      const operation = { ordinal: id, phase: label, name, arguments: args, elapsedMs: performance.now() - started, result };
      report.operations.push(operation); await record(`operation-${String(id).padStart(3, "0")}.json`, operation);
      if (result.isError) throw new Error(`${name} returned public MCP isError; original result retained.`);
      return { parsed: parseResult(result), outer: result.structuredContent as Record<string, any> };
    } catch (error) { await record(`operation-${String(id).padStart(3, "0")}-error.json`, { phase: label, name, elapsedMs: performance.now() - started, error: formatNativeToolboxError(error) }); throw error; }
  };
  try {
    const startup = performance.now(); process.stdout.write(`${label}: native startup\n`);
    const startupOptions = label === "fresh" ? options! : { ...options!, resume: true, fresh: { name: fixtureName } };
    toolbox = await createNativeToolbox(startupOptions); outcome.startupMs = performance.now() - startup;
    client = new Client({ name: "evleda-plane-authoring-smoke", version: "1.0.0" });
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(serverWire); await client.connect(clientWire);
    const tools = (await client.listTools()).tools.map(tool => tool.name); outcome.tools = tools;
    for (const unavailable of ["pcb_add_track", "pcb_add_via", "pcb_add_zone", "pcb_add_text"]) assert.ok(!tools.includes(unavailable), `Raw plane copper/route tool unexpectedly advertised: ${unavailable}`);
    for (const required of ["evleda_design_context", "fresh_apply_contract_connectivity", "fresh_autoplace_schematic_fields", "fresh_sync_from_schematic", "fresh_get_contract_pad_positions", "evleda_finish_session"]) assert.ok(tools.includes(required), `Missing public plane authoring tool: ${required}`);
    outcome.startedProcesses = await processes(`${label}-opened`);
    outcome.status = (await call("evleda_toolbox_status")).parsed; assert.equal(outcome.status.recoveryRequired, false);
    const context = (await call("evleda_design_context")).parsed; outcome.context = context;
    assert.equal(context.family, "plane-v2");
    assert.deepEqual(context.copperAuthoring, {
      incrementalRoutes: tools.includes("fresh_get_route_items") && tools.includes("fresh_replace_route_items"),
      contractPlane: tools.includes("fresh_apply_contract_plane"),
    });
    assert.equal(context.acceptanceEvaluated, false);
    assert.equal(context.resumedFromSavedBundle, label === "resume"); assert.equal(canonicalJson(context.contract), canonicalJson(expected.contract));
    assert.equal(canonicalJson(context.bundleIdentity), canonicalJson(expected.identity));
    const contract = context.contract as PcbPlaneDesignContract;
    const gnd = contract.nets.find(net => net.name === "GND"); assert.ok(gnd); assert.deepEqual(gnd.endpoints.map(endpoint => `${endpoint.reference}:${endpoint.pin}`).sort(), ["J1:3", "R2:2"]);
    assert.equal(contract.routingConstraints.nets.find(net => net.net === "GND")?.topology, "plane");
    outcome.openAuthority = await diskAuthority(`${label}-open`);
    if (label === "fresh") {
      await call("sch_get_symbols");
      const positions = { J1: [101.6,101.6], R1: [127,101.6], R2: [127,127] } as const;
      for (const component of contract.components) {
        assert.ok(component.reference in positions); const [library,symbol_name] = component.symbolLibId.split(":");
        const position = positions[component.reference as keyof typeof positions];
        await call("sch_add_symbol", { library, symbol_name, x_mm: position[0], y_mm: position[1], reference: component.reference, value: component.value, footprint: component.footprintLibId, rotation: 0, unit: 1, snap_to_grid: true });
        assert.deepEqual(await identity(druPath), baselineDru);
      }
      let connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
      if (connectivity.applied === false && connectivity.recommendationIdentity !== undefined) {
        await call("fresh_apply_recommended_schematic_placement", { recommendationIdentity: connectivity.recommendationIdentity });
        connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
      }
      assert.equal(connectivity.applied, true); outcome.connectivity = connectivity;
      outcome.fieldRepair = (await call("fresh_autoplace_schematic_fields")).parsed;
      assert.deepEqual(await identity(druPath), baselineDru);
      const sync = await call("fresh_sync_from_schematic"); outcome.sync = sync;
      assertPlaneSyncResult(sync.parsed);
      assert.equal(canonicalJson(sync.parsed.sourceContractIdentity), canonicalJson(contract.identity));
      assert.equal(canonicalJson(sync.parsed.planeProjectBindingIdentity), canonicalJson(outcome.openAuthority.marker.planeBinding.identity));
      assert.ok(sync.outer.persistence, "Actual public MCP mutation wrapper did not consume/save plane sync.");
      outcome.graph = (await call("sch_get_connectivity_graph")).parsed;
    }
    outcome.pads = (await call("fresh_get_contract_pad_positions")).parsed;
    assertPlanePadPositionsResult(outcome.pads);
    outcome.rules = (await call("pcb_get_design_rules")).parsed;
    assert.deepEqual(await identity(druPath), baselineDru); assert.deepEqual(await identity(bundlePath), savedBundle);
    outcome.beforeFinish = await snapshot(`${label}-before-finish`);
    outcome.finish = (await call("evleda_finish_session")).parsed;
    assert.equal(outcome.finish.nativeSessionClosed, true); assert.equal(outcome.finish.checkpointPublished, true); assert.equal(outcome.finish.recoveryRequired, false);
    finished = true;
    outcome.closedStatus = (await call("evleda_toolbox_status")).parsed; assert.equal(outcome.closedStatus.cadState, "closed"); assert.equal(outcome.closedStatus.cadConnected, false);
    await toolbox.close(); await client.close(); client = undefined; toolbox = undefined;
    outcome.closedAuthority = await diskAuthority(`${label}-closed`);
    const authoredSources = await Promise.all([`${fixtureName}.kicad_pcb`,`${fixtureName}.kicad_sch`,`${fixtureName}.kicad_pro`,`${fixtureName}.kicad_dru`,"sym-lib-table","fp-lib-table"].map(async name => ({ name, identity: await identity(path.join(project,name)) })));
    if (savedAuthoredSources) assert.deepEqual(authoredSources, savedAuthoredSources, "Read-only saved-bundle resume changed authored source bytes.");
    else savedAuthoredSources = authoredSources;
    outcome.authoredSourceIdentities = authoredSources;
    const afterProcesses = await processes(`${label}-closed`); outcome.afterProcesses = afterProcesses;
    assert.equal(afterProcesses.processes.filter((entry: any) => /^(pcbnew|python|pythonw)\.exe$/i.test(entry.Name)).length, 0, "Owned editor/native Python remains after finish.");
    assert.equal((await readdir(project)).filter(name => name.endsWith(".lck")).length, 0, "Owned project locks remain.");
    assert.deepEqual(await ipcInventory(), ipcBefore, "Owned IPC was not released or an old IPC directory changed.");
    outcome.passed = true; outcome.finishedAt = new Date().toISOString();
  } catch (error) {
    outcome.error = formatNativeToolboxError(error); process.stdout.write(`${label}: ERROR ${outcome.error}\n`); process.exitCode = 1;
    if (client) { try { outcome.failureStatus = (await call("evleda_toolbox_status")).parsed; } catch (statusError) { outcome.failureStatusError = formatNativeToolboxError(statusError); } }
    try { outcome.failureSnapshot = await snapshot(`${label}-failure-preserved`); } catch (snapshotError) { outcome.snapshotError = formatNativeToolboxError(snapshotError); }
  } finally {
    if (toolbox && !finished) {
      // Only the owning API drains/settles and gracefully closes; no force kill, source rewrite or IPC deletion.
      try { if (client) { outcome.failureFinish = (await call("evleda_finish_session")).parsed; } else await toolbox.finishCad(); }
      catch (error) { outcome.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
    }
    try { await toolbox?.close(); } catch (error) { outcome.closeError = formatNativeToolboxError(error); process.exitCode = 1; }
    await client?.close().catch(error => { outcome.protocolCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
    await record(`${label}-phase.json`, outcome);
  }
  return outcome.passed === true;
}
try {
  const fresh = await phase("fresh");
  if (fresh) { report.betweenPhases = await snapshot("saved-before-resume"); report.resumePassed = await phase("resume"); }
  else report.resumeNotStarted = "Fresh phase failed; no retry/resume permitted.";
} catch (error) { report.error = formatNativeToolboxError(error); process.exitCode = 1; }
finally {
  report.intentAfter = await identity(options.fresh.intentPath); report.profileAfter = await identity(options.profile.path);
  report.sourceUnchanged = canonicalJson(report.intentAfter) === canonicalJson(sourceBefore); report.profileUnchanged = canonicalJson(report.profileAfter) === canonicalJson(profileBefore);
  report.ipcAfter = await ipcInventory(); report.ipcUnchanged = canonicalJson(report.ipcAfter) === canonicalJson(ipcBefore);
  report.finalProcesses = await processes("final");
  report.passed = report.phases.length === 2 && report.phases.every((entry: any) => entry.passed === true) && report.sourceUnchanged && report.profileUnchanged && report.ipcUnchanged;
  if (!report.passed) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); await record("result.json", report);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, sourceUnchanged: report.sourceUnchanged, profileUnchanged: report.profileUnchanged, ipcUnchanged: report.ipcUnchanged, report: path.join(evidence,"result.json"), scope: report.scope, noPlaneCopperOrAcceptanceClaim: true })}\n`);
}
