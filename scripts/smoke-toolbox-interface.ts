/** One NEW synthetic native interface proof, followed by one read-only saved-bundle reopen.
 * Invoke with --run-root <new-absolute-directory>. No retries, forced process kills, or reused proof directories.
 */
import assert from "node:assert/strict";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import { loadKicadToolboxFreshProfile } from "../src/mcp/toolbox-fresh-profile.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../src/harness/pcb-design-plane-bundle.js";
import { parseFreshPcbSource, parseFreshPcbReferenceGeometry } from "../src/harness/fresh-kicad-parser.js";
import { INTERFACE_FIXTURE_FOOTPRINT, INTERFACE_FIXTURE_ID, INTERFACE_FIXTURE_MATERIAL, INTERFACE_FIXTURE_NAME,
  INTERFACE_FIXTURE_PROMPT, INTERFACE_FIXTURE_SYMBOL, assertInterfaceGeometry, assertInterfacePads,
  assertInterfacePhysicalCounts, exactFixtureNm, interfaceFixtureDraft, interfaceFixtureRoutes } from "./smoke-toolbox-interface-fixture.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_PROFILE = Object.freeze({ path: path.resolve(repo, "../working-profiles/toolbox-native-doc6-interface-destination-02.json"),
  contentIdentity: { algorithm: "sha256" as const, digest: "d9ea4bd6e1450a143ec7585a26844cbf79d8ab4c6f729d9755277b79f10f2946", size: 7452 } });
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const identity = async (file: string) => contentIdentity(await readFile(file));
const execFileAsync = promisify(execFile);
const powershell = path.join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const same = (left: unknown, right: unknown, message = "Canonical identities or values differ") => assert.equal(canonicalJson(left), canonicalJson(right), message);
const parseResult = (result: CallToolResult): Record<string, any> => {
  const outer = result.structuredContent as Record<string, any> | undefined;
  if (typeof outer?.result?.content === "string") return JSON.parse(outer.result.content);
  assert.ok(outer !== undefined, "Public tool must return structured content"); return outer;
};

/** Source tree snapshot present for this driver; this is not an import-coverage or distribution-build claim. */
async function implementationManifest() {
  const manifest: { file: string; identity: Awaited<ReturnType<typeof identity>> }[] = [];
  for (const root of [path.join(repo, "src"), path.join(repo, "third_party/kicad-transline-core")]) {
    const pending = [root];
    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), "Implementation manifest cannot follow source aliases");
        const file = path.join(current, entry.name);
        if (entry.isDirectory() && !["build", "node_modules", ".git"].includes(entry.name)) pending.push(file);
        else if (entry.isFile() && /\.(?:ts|cpp|h|hpp|json|ps1)$/u.test(entry.name)) manifest.push({ file: path.relative(repo, file), identity: await identity(file) });
      }
    }
  }
  for (const file of ["scripts/smoke-toolbox-interface.ts", "scripts/smoke-toolbox-interface-fixture.ts", "package.json", "pnpm-lock.yaml"])
    manifest.push({ file, identity: await identity(path.join(repo, file)) });
  return manifest.sort((a, b) => a.file.localeCompare(b.file));
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { "run-root": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { process.stdout.write("Usage: pnpm exec tsx scripts/smoke-toolbox-interface.ts --run-root <new-absolute-directory>\nThis starts owned native KiCad sessions. Uses the exact reviewed profile02 pin; never reuse a proof directory.\n"); return; }
  assert.ok(values["run-root"] && path.isAbsolute(values["run-root"]), "Supply one new absolute --run-root");
  const runRoot = path.resolve(values["run-root"]);
  assert.ok(runRoot !== path.parse(runRoot).root && !repo.toLowerCase().startsWith(`${runRoot.toLowerCase()}${path.sep}`) && runRoot.toLowerCase() !== repo.toLowerCase());
  await mkdir(runRoot); // Atomic ownership claim; existing paths fail closed, including empty paths from a previous attempt.
  const input = path.join(runRoot, "input"), output = path.join(runRoot, "output"), evidence = path.join(runRoot, "evidence");
  await mkdir(input); await mkdir(output); await mkdir(evidence);
  const record = async (name: string, value: unknown) => writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  const retainFailureDiagnostic = async (name: string, value: unknown, owner: Record<string, any>) => {
    try { await record(name, value); }
    catch (error) { (owner.diagnosticWriteErrors ??= []).push({ name, error: formatNativeToolboxError(error) }); }
  };
  const report: Record<string, any> = { schemaVersion: "evleda.toolbox-native-interface-proof.v1", startedAt: new Date().toISOString(), hostPid: process.pid,
    runRoot, input, output, evidence, profile: PINNED_PROFILE, scope: INTERFACE_FIXTURE_PROMPT, noModel: true, nativeAttempted: false,
    boardAccepted: false, interfaceAccepted: false, fabricationAuthorized: false, operations: [], phases: [] };
  await record("ownership.json", { runRoot, input, output, evidence, hostPid: process.pid, startedAt: report.startedAt, profile: PINNED_PROFILE });
  const project = path.join(output, "project"), pcbPath = path.join(project, `${INTERFACE_FIXTURE_NAME}.kicad_pcb`);
  const druPath = path.join(project, `${INTERFACE_FIXTURE_NAME}.kicad_dru`), bundlePath = path.join(output, "toolbox-design-bundle.json");
  const intentPath = path.join(input, "interface-intent.json");
  let ordinal = 0, ipcRoot: string | undefined, ipcBefore: unknown, sourceManifest: unknown, intentIdentity: unknown, bundleFileIdentity: unknown;
  let baselineDru: unknown, expected: ReturnType<typeof createPcbPlaneCompilationBundle> | undefined;
  let baselineStackupIdentity: unknown, savedInterface: Record<string, any> | undefined, savedSourceIdentities: unknown;
  let options: NonNullable<ReturnType<typeof parseNativeToolboxArgs>>;
  const ipcInventory = async () => Promise.all((await readdir(ipcRoot!)).sort().map(async name => {
    const item = await lstat(path.join(ipcRoot!, name));
    return { name, birthtimeMs: item.birthtimeMs, mtimeMs: item.mtimeMs, directory: item.isDirectory() };
  }));
  const processInventory = async (label: string) => {
    const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ownerProbe=${process.pid}; $allProbe=@(Get-CimInstance Win32_Process); $idsProbe=@($ownerProbe); do{$childrenProbe=@($allProbe | Where-Object {$_.ParentProcessId -in $idsProbe -and $_.ProcessId -notin $idsProbe});$idsProbe+=@($childrenProbe.ProcessId)}while($childrenProbe.Count); [ordered]@{ownerPid=$ownerProbe;processes=@($allProbe | Where-Object {$_.ProcessId -in $idsProbe -and $_.ProcessId -ne $PID} | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath)} | ConvertTo-Json -Depth 5`],
    { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout); await record(`${label}-processes.json`, result); return result;
  };
  const sourceIdentities = () => Promise.all([`${INTERFACE_FIXTURE_NAME}.kicad_pcb`, `${INTERFACE_FIXTURE_NAME}.kicad_sch`,
    `${INTERFACE_FIXTURE_NAME}.kicad_pro`, `${INTERFACE_FIXTURE_NAME}.kicad_dru`, "sym-lib-table", "fp-lib-table"]
    .map(async name => ({ name, identity: await identity(path.join(project, name)) })));
  async function snapshot(label: string) {
    const target = path.join(evidence, label); await mkdir(target);
    const manifest: unknown[] = [], pending = [output];
    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), "Evidence snapshot does not follow source aliases");
        const source = path.join(current, entry.name), relative = path.relative(output, source), destination = path.join(target, relative);
        if (entry.isDirectory()) { await mkdir(destination, { recursive: true }); pending.push(source); }
        else if (entry.isFile()) {
          const before = await identity(source); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination);
          same(await identity(destination), before); same(await identity(source), before); manifest.push({ relative, identity: before });
        }
      }
    }
    await record(`${label}-manifest.json`, manifest); return { directory: target, files: manifest.length };
  }
  async function diskAuthority(label: string) {
    const marker = await readJson(path.join(output, ".evleda-pcb-agent-fresh.json"));
    const checkpoint = await readJson(path.join(output, ".evleda-pcb-agent-checkpoint.json"));
    const bundle = await readJson(bundlePath), dru = await identity(druPath), bundleFile = await identity(bundlePath);
    assert.equal(marker.schemaVersion, "evleda.pcb-agent-fresh-project.v3"); assert.equal(marker.workflowKind, "plane");
    assert.equal(marker.planeBinding.family, "plane-v2"); assert.equal(checkpoint.schemaVersion, "evleda.pcb-agent-fresh-project-checkpoint.v3");
    same(bundle, expected); same(marker.planeBinding.contractIdentity, expected!.contract.identity);
    same(marker.planeBinding.expectedRulesContentIdentity, dru); assert.equal(marker.files.dru.sha256, dru.digest);
    assert.equal(checkpoint.files.dru.sha256, dru.digest); same(checkpoint.planeBindingIdentity, marker.planeBinding.identity);
    if (baselineDru === undefined) baselineDru = dru; else same(dru, baselineDru, "Original generated DRU changed");
    if (bundleFileIdentity === undefined) bundleFileIdentity = bundleFile; else same(bundleFile, bundleFileIdentity, "Bound requirements changed");
    const result = { marker, checkpoint, bundleFile, dru }; await record(`${label}-authority.json`, result); return result;
  }
  async function phase(label: "fresh" | "resume") {
    const outcome: Record<string, any> = { label, startedAt: new Date().toISOString() }; report.phases.push(outcome);
    let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined, client: Client | undefined, finished = false;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const id = ++ordinal, started = performance.now(); process.stdout.write(`${label}: ${name}\n`);
      try {
        const raw = await client!.callTool({ name, arguments: args }, { timeout: 180_000 });
        const operation = { ordinal: id, phase: label, name, arguments: args, elapsedMs: performance.now() - started, result: raw };
        report.operations.push(operation);
        const filename = `operation-${String(id).padStart(3, "0")}.json`;
        if (raw.isError) {
          await retainFailureDiagnostic(filename, operation, outcome);
          throw new Error(`${name} returned public MCP isError; original result retained`, { cause: raw });
        }
        await record(filename, operation);
        return { raw, parsed: parseResult(raw), outer: raw.structuredContent as Record<string, any> };
      } catch (error) {
        await retainFailureDiagnostic(`operation-${String(id).padStart(3, "0")}-error.json`, { name, error: formatNativeToolboxError(error) }, outcome);
        throw error;
      }
    };
    async function checkInterface(stage: "before-routing" | "after-routing" | "reopened") {
      const before = await identity(pcbPath), result = (await call("evleda_check_interface", { interfaceId: INTERFACE_FIXTURE_ID })).outer;
      const assessment = result.report;
      assert.equal(result.sourceUnchanged, true); assert.equal(result.sourceBefore, result.sourceAfter); assert.equal(typeof result.sourceBefore, "string");
      assert.equal(assessment.schemaVersion, "evleda.toolbox-interface-assessment.v1"); assert.equal(assessment.interfaceId, INTERFACE_FIXTURE_ID);
      same(assessment.sourceIdentity, before); same(await identity(pcbPath), before); same(assessment.bundleIdentity, expected!.identity);
      same(assessment.contractIdentity, expected!.contract.identity); same(assessment.verificationPlanIdentity, expected!.verificationPlan.identity);
      assert.match(result.diagnostic.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u);
      same(await identity(path.join(output, ".evleda-mcp-output", result.diagnostic.filename)), result.diagnostic.identity);
      assert.equal(assessment.sourceInventory.status, "complete"); assert.equal(assessment.sourceInventory.projectionComplete, true);
      assert.equal(assessment.construction.status, "matched_saved_declaration");
      const construction = assessment.construction.observed;
      for (const [name, value] of Object.entries({ boardThicknessNm: 270_000, frontCopperThicknessNm: 35_000, backCopperThicknessNm: 35_000,
        dielectricThicknessNm: 200_000, frontMaskThicknessNm: 0, backMaskThicknessNm: 0, dielectricMaterial: INTERFACE_FIXTURE_MATERIAL,
        relativePermittivity: 4.2, lossTangent: 0.02, surfaceFinish: "None" })) assert.equal(construction[name], value, name);
      assert.deepEqual(construction.copperLayerOrder, ["F.Cu", "B.Cu"]); assert.ok(construction.stackupSourceIdentity);
      if (baselineStackupIdentity === undefined) baselineStackupIdentity = construction.stackupSourceIdentity;
      else same(construction.stackupSourceIdentity, baselineStackupIdentity, "Native authoring or reopen changed bound saved stackup");
      assert.equal(assessment.construction.physicalConstruction, "not_verified"); assert.equal(assessment.construction.assertionAuthority, "bound_caller_assertions");
      assert.equal(assessment.nativeReachability, "not_evaluated"); assert.equal(assessment.libraryMembership, "not_verified");
      assert.equal(assessment.boardAccepted, false); assert.equal(assessment.interfaceAccepted, false); assert.equal(assessment.fabricationAuthorized, false);
      assert.ok(assessment.unevaluatedRows.length > 0); assert.equal(assessment.impedance.targetOhm, 90); assert.equal(assessment.impedance.absoluteToleranceOhm, 10);
      assert.equal(assessment.impedance.frequencyHz, 100_000_000); assert.equal(assessment.impedance.status, "unassessed");
      assert.equal(assessment.impedance.completeRouteModelCoverage, false);
      if (stage === "before-routing") {
        assert.equal(assessment.geometry.selected.tracks.length, 0); assert.equal(assessment.geometry.selected.pads.length, 4);
        for (const member of ["positive", "negative"]) assert.equal(assessment.geometry.routes[member].status, "incomplete");
        assert.notEqual(assessment.geometry.checks.topology.status, "pass"); assert.equal(assessment.impedance.intervals.length, 0);
      } else {
        assertInterfaceGeometry(assessment.geometry); assert.equal(assessment.impedance.intervals.length, 1);
        const interval = assessment.impedance.intervals[0]; assert.equal(interval.status, "within_tolerance");
        assert.equal(interval.positiveWidthNm, 400_000); assert.equal(interval.negativeWidthNm, 400_000); assert.equal(interval.numericalGapNm, 300_000);
        assert.equal(interval.numericalLengthNm, 13_700_000); assert.equal(interval.applicability.status, "conditional_model_only");
        assert.ok(Number.isFinite(interval.calculatedDifferentialOhm)); assert.ok(Math.abs(interval.calculatedDifferentialOhm - 90) <= 10);
        assert.ok(interval.calculation); assert.equal(assessment.referenceRequirements.declarationStatus, "matched_saved_zone");
        assert.equal(assessment.referenceRequirements.savedFillCachePresent, true); assert.equal(assessment.referenceRequirements.fillFreshness, "not_verified");
        assert.equal(assessment.referenceRequirements.wholeRouteCoverage, "not_evaluated");
        if (savedInterface === undefined) savedInterface = assessment;
        else for (const field of ["sourceIdentity", "bundleIdentity", "contractIdentity", "verificationPlanIdentity", "requirementIdentity", "geometry", "construction", "impedance"])
          same(assessment[field], savedInterface[field], `Read-only reopen changed ${field}`);
      }
      await record(`${label}-${stage}-interface.json`, result); return result;
    }
    try {
      same(await implementationManifest(), sourceManifest, "Implementation changed after proof preflight");
      const startupOptions = label === "fresh" ? options : { ...options, edit: false, resume: true, fresh: { name: INTERFACE_FIXTURE_NAME } };
      report.nativeAttempted = true; toolbox = await createNativeToolbox(startupOptions);
      client = new Client({ name: "evleda-interface-proof", version: "1.0.0" });
      const [clientWire, serverWire] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(serverWire); await client.connect(clientWire);
      outcome.openedProcesses = await processInventory(`${label}-opened`);
      const names = (await client.listTools()).tools.map(tool => tool.name); outcome.tools = names;
      for (const name of ["evleda_design_context", "evleda_check_interface", "fresh_get_contract_pad_positions", "fresh_get_route_items",
        "evleda_check_endpoint_connectivity", "evleda_validate_design", "evleda_check_board_practices", "evleda_render_board", "evleda_check_plane_acceptance", "evleda_finish_session"])
        assert.ok(names.includes(name), `Missing required public tool ${name}`);
      if (label === "resume") for (const name of ["fresh_replace_route_items", "fresh_apply_contract_plane", "pcb_move_footprint"]) assert.ok(!names.includes(name));
      outcome.status = (await call("evleda_toolbox_status")).parsed; assert.equal(outcome.status.recoveryRequired, false);
      const context = (await call("evleda_design_context")).parsed; outcome.context = context;
      assert.equal(context.family, "plane-v2"); assert.equal(context.resumedFromSavedBundle, label === "resume"); assert.equal(context.acceptanceEvaluated, false);
      same(context.contract, expected!.contract); same(context.bundleIdentity, expected!.identity);
      const authority = await diskAuthority(`${label}-open`);
      if (label === "fresh") {
        for (const component of expected!.contract.components) {
          const [library, symbol_name] = component.symbolLibId.split(":");
          await call("sch_add_symbol", { library, symbol_name, x_mm: component.reference === "J1" ? 101.6 : 152.4, y_mm: 101.6,
            reference: component.reference, value: component.value, footprint: component.footprintLibId, rotation: 0, unit: 1, snap_to_grid: true });
        }
        let connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
        if (connectivity.applied === false && connectivity.recommendationIdentity !== undefined) {
          await call("fresh_apply_recommended_schematic_placement", { recommendationIdentity: connectivity.recommendationIdentity });
          connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
        }
        assert.equal(connectivity.applied, true); outcome.schematicConnectivity = connectivity;
        await call("fresh_autoplace_schematic_fields"); const sync = await call("fresh_sync_from_schematic");
        assert.equal(sync.parsed.schemaVersion, "evleda.fresh-plane-sync-from-schematic-result.v1"); assert.equal(sync.parsed.applied, true);
        assert.equal(sync.parsed.componentCount, 2); assert.equal(sync.parsed.unresolvedMappingCount, 0); assertInterfacePhysicalCounts(sync.parsed);
        same(sync.parsed.sourceContractIdentity, expected!.contract.identity); same(sync.parsed.planeProjectBindingIdentity, authority.marker.planeBinding.identity);
        assert.ok(sync.outer.persistence); outcome.sync = sync.parsed;
        outcome.graph = (await call("sch_get_connectivity_graph")).parsed;
        const initialPads = (await call("fresh_get_contract_pad_positions")).parsed; assertInterfacePads(initialPads, false);
        const blank = parseFreshPcbSource(await readFile(pcbPath, "utf8")); assert.equal(blank.segments.length, 0); assert.equal(blank.vias.length, 0);
        await call("pcb_set_board_outline", { width_mm: 30, height_mm: 20, origin_x_mm: 0, origin_y_mm: 0 });
        for (const [reference, x_mm] of [["J1", 5], ["J2", 25]] as const) await call("pcb_move_footprint", { reference, x_mm, y_mm: 10, rotation_deg: 0 });
        outcome.placedPads = (await call("fresh_get_contract_pad_positions")).parsed; assertInterfacePads(outcome.placedPads, true);
        outcome.beforeRouting = await checkInterface("before-routing");
        outcome.endpointBeforeRouting = (await call("evleda_check_endpoint_connectivity")).outer;
        assert.equal(outcome.endpointBeforeRouting.sourceUnchanged, true); assert.notEqual(outcome.endpointBeforeRouting.report.status, "connected");
        for (const route of interfaceFixtureRoutes(outcome.placedPads)) {
          const selection = (await call("fresh_get_route_items")).parsed;
          assert.equal(selection.schemaVersion, "evleda.fresh-plane-route-selection.v1");
          const result = await call("fresh_replace_route_items", { selectionIdentity: selection.identity, net: route.net,
            deleteItemIds: [], tracks: route.tracks, vias: route.vias });
          assert.equal(result.parsed.applied, true); assert.equal(result.parsed.addedTrackCount, route.tracks.length);
          assert.equal(result.parsed.addedViaCount, route.vias.length); assert.ok(result.outer.persistence); same(await identity(druPath), baselineDru);
        }
        const plane = await call("fresh_apply_contract_plane", { planeId: "GND_PLANE" });
        assert.equal(plane.parsed.operation, "create"); assert.equal(plane.parsed.applied, true); assert.ok(plane.outer.persistence);
        outcome.plane = plane.parsed;
      }
      const pads = (await call("fresh_get_contract_pad_positions")).parsed; assertInterfacePads(pads, true);
      const planned = interfaceFixtureRoutes(pads), savedSource = await readFile(pcbPath, "utf8"), board = parseFreshPcbSource(savedSource);
      const geometry = parseFreshPcbReferenceGeometry(savedSource);
      assert.equal(board.outlineSupported, true); assert.deepEqual(board.outlineBounds, { minX: 0, minY: 0, maxX: 30, maxY: 20 });
      assert.equal(board.footprints.length, 2); assert.equal(board.segments.length, 12); assert.equal(board.vias.length, 2);
      for (const footprint of board.footprints) assert.equal(footprint.libraryId, INTERFACE_FIXTURE_FOOTPRINT);
      const trackKey = (net: string, layer: string, widthMm: number, a: number[], b: number[]) => canonicalJson({ net, layer,
        widthNm: exactFixtureNm(widthMm), ends: [a.map(exactFixtureNm), b.map(exactFixtureNm)].sort() });
      assert.deepEqual(board.segments.map(segment => trackKey(segment.netName!, segment.layer, segment.widthMm, [segment.start.x, segment.start.y], [segment.end.x, segment.end.y])).sort(),
        planned.flatMap(route => route.tracks.map(track => trackKey(route.net, track.layer, route.net === "GND" ? 0.5 : 0.4, [track.x1Mm, track.y1Mm], [track.x2Mm, track.y2Mm]))).sort());
      assert.deepEqual(board.vias.map(via => ({ net: via.netName, xNm: exactFixtureNm(via.at.x), yNm: exactFixtureNm(via.at.y),
        diameterNm: exactFixtureNm(via.diameterMm), drillNm: exactFixtureNm(via.drillMm), layers: via.layers })).sort((a, b) => a.xNm - b.xNm),
      [4_125_000, 24_125_000].map(xNm => ({ net: "GND", xNm, yNm: 12_500_000, diameterNm: 600_000, drillNm: 300_000, layers: ["F.Cu", "B.Cu"] })));
      assert.equal(geometry.zones.length, 1); assert.equal(geometry.zones[0]!.netName, "GND"); assert.deepEqual(geometry.zones[0]!.layers, ["B.Cu"]);
      assert.equal(geometry.zones[0]!.filledCachePresent, true); outcome.savedPcbIdentity = contentIdentity(savedSource);
      outcome.routeItems = (await call("fresh_get_route_items")).parsed; assert.equal(outcome.routeItems.items.length, 14);
      outcome.interface = await checkInterface(label === "fresh" ? "after-routing" : "reopened");
      const sortByUuid = <T extends { uuid: string }>(items: readonly T[]) => [...items].sort((a, b) => a.uuid.localeCompare(b.uuid));
      same(sortByUuid(outcome.interface.report.geometry.selected.tracks), sortByUuid(geometry.segments.filter(segment => segment.netName === "DP" || segment.netName === "DN")
        .map(segment => ({ uuid: segment.uuid, net: segment.netName, layer: segment.layer, widthNm: segment.widthNm,
          start: { xNm: segment.startNm.x, yNm: segment.startNm.y }, end: { xNm: segment.endNm.x, yNm: segment.endNm.y }, sourceIdentity: segment.sourceIdentity }))),
      "Public assessed track primitives differ from the exact saved-source primitive identities");
      same(sortByUuid(outcome.interface.report.geometry.selected.pads), sortByUuid(pads.pads.filter((pad: any) => pad.net === "DP" || pad.net === "DN").map((pad: any) => {
        const physical = board.footprints.flatMap(footprint => footprint.pads).find(sourcePad => sourcePad.physical.id === pad.physical.id);
        assert.ok(physical, "Public native pad UUID is absent from the saved source");
        return { uuid: pad.physical.id, reference: pad.reference, pad: pad.pad, net: pad.net, layers: ["F.Cu"],
          center: { xNm: exactFixtureNm(pad.xMm), yNm: exactFixtureNm(pad.yMm) }, sourceIdentity: contentIdentity(physical.physical.source) };
      })), "Public assessment pads differ from the exact native-validated physical pad IDs and integer-nanometre centers");
      outcome.endpoint = (await call("evleda_check_endpoint_connectivity")).outer;
      assert.equal(outcome.endpoint.sourceUnchanged, true); assert.equal(outcome.endpoint.report.status, "connected");
      assert.deepEqual(outcome.endpoint.report.nets.map((net: any) => net.net).sort(), ["DN", "DP", "GND"]);
      for (const net of outcome.endpoint.report.nets) { assert.equal(net.status, "connected"); assert.equal(net.logicalEndpointReachability.status, "reachable"); assert.equal(net.everyEligiblePhysicalMemberReachable, true); }
      outcome.practices = (await call("evleda_check_board_practices")).outer; assert.equal(outcome.practices.sourceUnchanged, true);
      assert.deepEqual(outcome.practices.report.turnPolicy.violations, []); assert.deepEqual(outcome.practices.report.turnPolicy.unresolvedFindings, []);
      assert.equal(outcome.practices.report.checks.electricalSuitability, "unverified");
      assert.equal(outcome.practices.report.checks.manufacturingReadiness, "unverified");
      outcome.validation = (await call("evleda_validate_design")).outer; assert.equal(outcome.validation.sourceUnchanged, true);
      for (const name of ["run_erc", "run_drc"]) {
        const checks = outcome.validation.checks.filter((check: any) => check.name === name); assert.equal(checks.length, 1); assert.ok(!checks[0].result.isError);
        const verdict = JSON.parse(checks[0].result.content); assert.equal(verdict.verdict, "PASS"); assert.equal(verdict.status, "clean");
        assert.equal(verdict.metadata.available, true);
        if (name === "run_erc") assert.equal(verdict.metadata.violation_count, 0);
        else for (const field of ["violations", "unconnected_items", "courtyard_issues"]) assert.equal(verdict.metadata[field], 0);
      }
      // This independent tool retains the complete native parity collections. Its partial acceptance report stays partial.
      outcome.planeAcceptance = (await call("evleda_check_plane_acceptance")).outer;
      assert.equal(outcome.planeAcceptance.sourceUnchanged, true); assert.equal(outcome.planeAcceptance.report.accepted, false);
      assert.equal(outcome.planeAcceptance.report.fabricationAuthorized, false);
      const acceptance = outcome.planeAcceptance.report;
      assert.ok(!acceptance.rows.some((row: any) => row.status === "fail"), `Native acceptance reported a known failure: ${JSON.stringify(acceptance.rows.filter((row: any) => row.status === "fail"))}`);
      assert.equal(acceptance.interfaces.length, 1); const interfaceAcceptance = acceptance.interfaces[0];
      assert.equal(interfaceAcceptance.interfaceId, INTERFACE_FIXTURE_ID);
      same(interfaceAcceptance.requirementIdentity, outcome.interface.report.requirementIdentity);
      same(interfaceAcceptance.sourceIdentity, outcome.interface.report.sourceIdentity); same(interfaceAcceptance.geometry, outcome.interface.report.geometry);
      for (const field of ["construction", "topology", "termination"]) assert.equal(interfaceAcceptance.acceptance[field].status, "verified");
      assert.equal(interfaceAcceptance.acceptance.impedance.status, "unknown");
      for (const id of ["interface-construction", `interface-topology:${INTERFACE_FIXTURE_ID}`, `interface-termination:${INTERFACE_FIXTURE_ID}`]) {
        const rows = acceptance.rows.filter((row: any) => row.id === id); assert.equal(rows.length, 1); assert.equal(rows[0].status, "pass");
      }
      if (label === "fresh") {
        assert.ok(outcome.planeAcceptance.report.savedEvidenceIdentity);
        for (const field of ["schematicParity", "violations", "unconnectedItems"]) assert.deepEqual(outcome.planeAcceptance.report.nativeChecks.drc[field], []);
      } else {
        // Reopen does not invent a fresh fill certificate. Fresh parity is retained against the same authored source identities.
        assert.equal(outcome.planeAcceptance.report.savedEvidenceIdentity, null); assert.equal(outcome.planeAcceptance.report.nativeChecks, null);
        for (const field of ["authority", "sourceScope", "nativeInventory"]) assert.equal(acceptance[field].status, "unknown");
        assert.deepEqual(acceptance.planes, []); assert.deepEqual(acceptance.references, []);
        assert.ok(acceptance.rows.filter((row: any) => !row.kind.startsWith("interface_")).every((row: any) => row.status === "unknown"));
        assert.equal(interfaceAcceptance.acceptance.pairGeometry.status, "unknown");
        assert.equal(interfaceAcceptance.acceptance.referenceCoverage.status, "unknown");
        assert.deepEqual(interfaceAcceptance.acceptance.referenceCoverage.referenceRowIds, []);
        for (const id of [`interface-geometry:${INTERFACE_FIXTURE_ID}`, `interface-impedance:${INTERFACE_FIXTURE_ID}`]) {
          const rows = acceptance.rows.filter((row: any) => row.id === id); assert.equal(rows.length, 1); assert.equal(rows[0].status, "unknown");
        }
      }
      outcome.previews = [];
      for (const view of ["top", "assembly"] as const) {
        const rendered = await call("evleda_render_board", { view }), images = rendered.raw.content.filter(item => item.type === "image");
        const resources = rendered.raw.content.filter(item => item.type === "resource_link");
        assert.equal(images.length, 1); assert.equal(resources.length, 1); const pngImage = images[0]!, resource = resources[0]!;
        assert.equal(pngImage.mimeType, "image/png"); const png = Buffer.from(pngImage.data, "base64");
        assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); same(contentIdentity(png), rendered.outer.png.identity);
        assert.equal(rendered.outer.sourceUnchanged, true); assert.equal(rendered.outer.sourceBefore, rendered.outer.sourceAfter);
        const response = await client.readResource({ uri: resource.uri }), svg = response.contents[0];
        assert.equal(response.contents.length, 1); assert.ok(svg && "text" in svg); assert.equal(svg.mimeType, "image/svg+xml");
        const svgIdentity = contentIdentity(svg.text); assert.equal(svgIdentity.digest, rendered.outer.pcbSvg.sha256); assert.equal(svgIdentity.size, rendered.outer.pcbSvg.sizeBytes);
        assert.equal(resource.uri, `evleda://pcb-preview/${svgIdentity.digest}/${view}`);
        await writeFile(path.join(evidence, `${label}-${view}.png`), png, { flag: "wx" }); await writeFile(path.join(evidence, `${label}-${view}.svg`), svg.text, { flag: "wx" });
        outcome.previews.push({ view, pngIdentity: contentIdentity(png), svgIdentity });
      }
      same(await identity(druPath), baselineDru); same(await identity(bundlePath), bundleFileIdentity);
      same(await identity(pcbPath), outcome.savedPcbIdentity, "Read-only checks/previews changed saved PCB");
      outcome.beforeFinish = await snapshot(`${label}-before-finish`);
      outcome.finish = (await call("evleda_finish_session")).parsed;
      assert.equal(outcome.finish.nativeSessionClosed, true); assert.equal(outcome.finish.checkpointPublished, true); assert.equal(outcome.finish.recoveryRequired, false);
      finished = true; const status = (await call("evleda_toolbox_status")).parsed;
      assert.equal(status.cadState, "closed"); assert.equal(status.cadConnected, false);
      await toolbox.close(); await client.close(); toolbox = undefined; client = undefined;
      outcome.closedAuthority = await diskAuthority(`${label}-closed`);
      same(await identity(pcbPath), outcome.savedPcbIdentity, "Normal owned close changed assessed PCB bytes");
      const sources = await sourceIdentities(); if (savedSourceIdentities === undefined) savedSourceIdentities = sources;
      else same(sources, savedSourceIdentities, "Read-only reopen changed authored sources"); outcome.sourceIdentities = sources;
      const processes = await processInventory(`${label}-closed`); outcome.closedProcesses = processes;
      assert.equal(processes.processes.filter((entry: any) => /^(pcbnew|python|pythonw)\.exe$/iu.test(entry.Name)).length, 0, "Owned native process remains after normal finish");
      assert.equal((await readdir(project)).filter(name => name.endsWith(".lck")).length, 0); same(await ipcInventory(), ipcBefore, "IPC inventory changed after normal owned close");
      same(await implementationManifest(), sourceManifest, "Implementation changed during proof"); outcome.passed = true;
    } catch (error) {
      outcome.error = formatNativeToolboxError(error); outcome.passed = false; process.exitCode = 1;
      // Preserve the first failure and raw output BEFORE any cleanup call or further public inspection.
      await retainFailureDiagnostic(`${label}-first-failure.json`, { error: outcome.error, at: new Date().toISOString(), lastOperationOrdinal: ordinal }, outcome);
      try { outcome.failureSnapshot = await snapshot(`${label}-failure-before-cleanup`); } catch (error) { outcome.failureSnapshotError = formatNativeToolboxError(error); }
      try { outcome.failureProcesses = await processInventory(`${label}-failure-before-cleanup`); } catch (error) { outcome.failureProcessesError = formatNativeToolboxError(error); }
    } finally {
      if (toolbox && !finished) {
        // Native session owns actual process handles. Only its API drains and closes them; never PID-kill or delete IPC.
        try { if (client) outcome.failureFinish = (await call("evleda_finish_session")).parsed; else await toolbox.finishCad(); }
        catch (error) { outcome.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
      }
      try { await toolbox?.close(); } catch (error) { outcome.closeError = formatNativeToolboxError(error); process.exitCode = 1; }
      try { await client?.close(); } catch (error) { outcome.protocolCloseError = formatNativeToolboxError(error); process.exitCode = 1; }
      outcome.finishedAt = new Date().toISOString();
      try { await record(`${label}-phase.json`, outcome); }
      catch (error) { outcome.passed = false; (outcome.diagnosticWriteErrors ??= []).push({ name: `${label}-phase.json`, error: formatNativeToolboxError(error) }); process.exitCode = 1; }
    }
    return outcome.passed === true;
  }
  try {
    same(await identity(PINNED_PROFILE.path), PINNED_PROFILE.contentIdentity, "Reviewed profile bytes changed");
    const profile = await readJson(PINNED_PROFILE.path); ipcRoot = profile.kicadMcpRuntime.ipcSocketParentRoot;
    assert.ok(typeof ipcRoot === "string" && path.isAbsolute(ipcRoot)); ipcBefore = await ipcInventory(); report.ipcBefore = ipcBefore;
    const design = await loadKicadToolboxFreshProfile(PINNED_PROFILE);
    const dependencies = { ...design.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(design.deepRuleSelectionOptions) };
    const pairInspection = dependencies.libraryResolver.inspectPair!(INTERFACE_FIXTURE_SYMBOL, INTERFACE_FIXTURE_FOOTPRINT);
    assert.ok(pairInspection?.exactPinPadMatch, "Actual approved stock resolver must establish exact pin/pad matching");
    await record("stock-pair-inspection.json", pairInspection);
    const draft = interfaceFixtureDraft(), compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    await record("compilation.json", compilation); assert.equal(compilation.disposition, "ready", "Synthetic fixture must compile without weakening requirements");
    expected = createPcbPlaneCompilationBundle({ originalPrompt: INTERFACE_FIXTURE_PROMPT, compilation }, dependencies);
    await writeFile(intentPath, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
    await writeFile(path.join(input, "expected-interface-bundle.json"), `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
    intentIdentity = await identity(intentPath); sourceManifest = await implementationManifest(); await record("implementation-manifest.json", sourceManifest);
    options = parseNativeToolboxArgs(["--profile", PINNED_PROFILE.path, "--profile-sha256", PINNED_PROFILE.contentIdentity.digest,
      "--profile-bytes", String(PINNED_PROFILE.contentIdentity.size), "--project-dir", input, "--output-dir", output,
      "--new-project", INTERFACE_FIXTURE_NAME, "--intent", intentPath, "--prompt", INTERFACE_FIXTURE_PROMPT, "--edit"])!;
    await record("preflight.json", { options, profileIdentity: PINNED_PROFILE.contentIdentity, intentIdentity, bundleIdentity: expected.identity,
      callerAssertedRequirements: expected.contract.interfaceRequirements, nativeStarted: false });
    if (await phase("fresh")) { report.beforeResume = await snapshot("saved-before-resume"); await phase("resume"); }
    else report.resumeNotStarted = "Fresh proof failed; no retry, new session, or requirement relaxation attempted.";
  } catch (error) {
    report.error = formatNativeToolboxError(error); process.exitCode = 1;
    await retainFailureDiagnostic("driver-first-failure.json", { error: report.error, at: new Date().toISOString(), nativeAttempted: report.nativeAttempted }, report);
    try { report.failureSnapshot = await snapshot("driver-failure-before-cleanup"); } catch (error) { report.failureSnapshotError = formatNativeToolboxError(error); }
  } finally {
    try {
      report.profileUnchanged = canonicalJson(await identity(PINNED_PROFILE.path)) === canonicalJson(PINNED_PROFILE.contentIdentity);
      report.intentUnchanged = intentIdentity !== undefined && canonicalJson(await identity(intentPath)) === canonicalJson(intentIdentity);
      report.implementationUnchanged = sourceManifest !== undefined && canonicalJson(await implementationManifest()) === canonicalJson(sourceManifest);
      report.ipcAfter = ipcRoot === undefined ? null : await ipcInventory(); report.ipcUnchanged = ipcBefore !== undefined && canonicalJson(report.ipcAfter) === canonicalJson(ipcBefore);
      report.finalProcesses = await processInventory("final");
    } catch (error) { report.finalInspectionError = formatNativeToolboxError(error); }
    report.passed = report.phases.length === 2 && report.phases.every((phase: any) => phase.passed === true)
      && report.profileUnchanged && report.intentUnchanged && report.implementationUnchanged && report.ipcUnchanged && !report.finalInspectionError;
    if (!report.passed) process.exitCode = 1; report.finishedAt = new Date().toISOString();
    try { await record("result.json", report); }
    catch (error) { report.passed = false; process.exitCode = 1; process.stderr.write(`Result publication failed after retained primary error: ${report.error ?? report.phases.find((phase: any) => phase.error)?.error ?? "none"}\n${formatNativeToolboxError(error)}\n`); }
    process.stdout.write(`${JSON.stringify({ passed: report.passed, report: path.join(evidence, "result.json"), nativeAttempted: report.nativeAttempted,
      boardAccepted: false, interfaceAccepted: false, fabricationAuthorized: false })}\n`);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${formatNativeToolboxError(error)}\n`); process.exitCode = 1; });
}
