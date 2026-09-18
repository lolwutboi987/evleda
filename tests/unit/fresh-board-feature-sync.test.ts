import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument } from "../../src/harness/fresh-kicad-parser.js";
import { prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import { planeCompoundMutationState } from "../../src/mcp/toolbox-plane-results.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import { boardFeatureFixture, electricalBoard, holeId } from "../helpers/board-feature-fixture.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { createFreshBoardFeatureState } from "../../src/harness/fresh-board-features.js";

const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unsafe cleanup"); await rm(root, { recursive: true, force: true }); } });
const sync = { id: "sync", name: "fresh_sync_from_schematic" as const, arguments: {} };
const save = { id: "save", name: "pcb_save" as const, arguments: {} };
const outlined = (source: string) => source.replace(/\)\s*$/u, `(gr_rect (start 0 0) (end 30 20)
  (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "22222222-2222-4222-8222-222222222222"))\n)\n`);
async function fixture(fault?: "drop" | "number" | "move" | "exclude" | "source-drift" | "save", withOutline = false) {
  const f = boardFeatureFixture(); owned.push(f.root);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(f.root, "kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  const input = { draft: f.draft, originalPrompt: "Source-bound NPTH first-sync fixture", outputDir: path.join(f.root, "output"), name: "features",
    dependencies: f.dependencies, expectedKicadCli, createKicadCliAdapter };
  const result = await prepareKicadToolboxPlaneProject(input); if (result.status !== "prepared") throw new Error(JSON.stringify(result.compilation.issues));
  const preparation = result.preparation, { bundle, project } = preparation;
  let live = await readFile(project.pcbPath, "utf8"), syncCalls = 0;
  if (withOutline) { live = outlined(live).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"); await writeFile(project.pcbPath, live); }
  let physicalReads = 0;
  let resyncChange: ((source: string) => string) | undefined;
  const initial = live, staged: string[] = [], calls: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  const schematic = `(kicad_sch (version 20250316) (generator "fixture") ${bundle.contract.nets.map(net => `(global_label "${net.name}" (shape passive) (at 10 10 0))`).join(" ")}
    ${bundle.contract.components.map(c => `(symbol (lib_id "${c.symbolLibId}") (at 20 20 0) (unit 1) (property "Reference" "${c.reference}") (property "Value" "${c.value}") (property "Footprint" "${c.footprintLibId}"))`).join(" ")})`;
  const netlist = `(export (design (source "features.kicad_sch") (date "2026-09-17T10:00:00")) (components ${bundle.contract.components.map(c => {
    const [lib, part] = c.symbolLibId.split(":"); return `(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "${lib}") (part "${part}")))`;
  }).join(" ")}) (nets ${bundle.contract.nets.map((net, i) => `(net (code "${i+1}") (name "${net.name}") ${net.endpoints.map(p => `(node (ref "${p.reference}") (pin "${p.pin}") (pintype "passive"))`).join(" ")})`).join(" ")}))`;
  await writeFile(project.schematicPath, schematic);
  const session: KicadHarnessSession = {
    supportsQualifiedFootprintIdentitySync: () => true,
    listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const, inputSchema: { type: "object", additionalProperties: true } })),
    assertActivePcb: async expected => { if (expected !== project.pcbPath) throw new Error("wrong board"); },
    readActivePcbSource: async () => live,
    readLivePcbPadSnapshot: async ids => {
      physicalReads++;
      const generated = await nativePadObservationFixture(live), payload = structuredClone(generated.observation.rawSnapshot) as Record<string, any>;
      const document = { type: "DOCTYPE_PCB", board_filename: path.basename(project.pcbPath), project: { name: project.name, path: path.dirname(project.pcbPath) } };
      payload.documentBefore = document; payload.documentAfter = document; payload.enabledLayers.request.board = document;
      payload.footprintInventory.request.header.document = document; payload.padstackPresence.request.board = document;
      const queries = new Map<string, any>(payload.connectivity.map((q: any) => [q.sourcePrimitiveId, q]));
      payload.connectivity = ids.map(id => { const q = structuredClone(queries.get(id)); q.request.header.document = document; return q; });
      return { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    },
    callTool: async (name, args = {}) => {
      calls.push({ name, args }); let result = "ok";
      if (name === "pcb_sync_from_schematic") {
        syncCalls++;
        if (syncCalls > 1) {
          if (resyncChange !== undefined) { live = resyncChange(live); await writeFile(project.pcbPath, live); }
          return { content: [], structuredContent: { result: "The PCB already contains all schematic footprint assignments." } };
        }
        staged.push(await readFile(project.pcbPath, "utf8"));
        live = electricalBoard(bundle, staged[0]);
        if (fault === "number") live = live.replace('(pad ""', '(pad "1"');
        if (fault === "move") live = live.replace('(at 3 3)', '(at 3.1 3)');
        if (fault === "exclude") live = live.replace('attr board_only', 'attr');
        if (fault === "drop") { const fp = parseFreshPcbSourceDocument(live).children.find(node => node.name === "footprint" && node.values[0]?.value === holeId)!; live = live.slice(0, fp.start) + live.slice(fp.end); }
        await writeFile(project.pcbPath, live);
        if (fault === "source-drift") await writeFile(f.holePath, (await readFile(f.holePath, "utf8")) + "\n");
        result = ["Schematic components considered: 3", "New footprints added: 3", "Mismatched footprints replaced: 0", "Total pads considered: 7", "Pads with named nets: 7", "Pads left as <no net>: 0", "Transfer quality: CLEAN (100.0% pad coverage)", "Fully net-mapped refs: 3", "Partially net-mapped refs: 0", "Refs with unresolved pad nets: (none)", "The PCB file was updated and KiCad was asked to reload it."].join("\n");
      }
      if (name === "pcb_save") {
        if (fault === "save") return { isError: true, content: [{ type: "text", text: "Native save failed in the offline fixture." }] };
        await writeFile(project.pcbPath, live); result = "Board saved.";
      }
      if (name === "pcb_revert") { live = await readFile(project.pcbPath, "utf8"); result = "Board reverted to last saved state. All unsaved changes have been discarded."; }
      return { content: [], structuredContent: { result } };
    },
  };
  const pins = bundle.libraryBinding.footprints.map(fp => ({ reference: fp.reference, libraryId: fp.libraryId, sourceIdentity: f.resolver.inspectFootprint(fp.libraryId)!.sourceIdentity }));
  const bridge = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
    freshBoardFeatureState: preparation.boardFeatureState,
    freshLibraryResolver: f.resolver, freshPhysicalFootprintResolver: f.resolver, freshPhysicalFootprintSourcePins: pins,
    captureFreshNativeNetlist: async () => netlist,
    capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
    verifyPersistedMutation: async baseline => baseline !== contentIdentity(await readFile(project.pcbPath)).digest });
  const lifecycle = createPlaneToolboxCheckpointLifecycle({ project, preparation, session: session as unknown as KicadMcpSession });
  return { f, input, preparation, bridge, project, session, lifecycle, initial, staged, calls, live: () => live,
    physicalReads: () => physicalReads,
    changeOnResync: (change: (source: string) => string) => { resyncChange = change; } };
}
describe("board-only NPTH source-bound sync and existing checkpoint", () => {
  it("preserves the native contract outline through first feature staging, sync, save and resume", async () => {
    const f = await fixture(undefined, true);
    const outline = (source: string) => { const node = parseFreshPcbSourceDocument(source).children.find(n => n.name === "gr_rect")!; return source.slice(node.start, node.end); };
    const response = JSON.parse((await f.bridge.execute(sync)).content);
    expect(response).toMatchObject({ componentCount: 3, physicalPadCount: 9, nonElectricalFeatureCount: 2 });
    expect(outline(f.staged[0]!)).toBe(outline(f.initial));
    expect(parseFreshPcbSource(f.staged[0]!).footprints.map(fp => fp.reference)).toEqual(["H1", "H2"]);
    expect((await f.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    const saved = await readFile(f.project.pcbPath, "utf8"); expect(outline(saved)).toBe(outline(f.initial));
    expect(() => f.preparation.boardFeatureState!.verify(f.initial, f.f.resolver)).toThrow(/missing board feature/);
    const hole = parseFreshPcbSourceDocument(saved).children.find(node => node.name === "footprint" && node.values[0]?.value === holeId)!;
    expect(() => f.preparation.boardFeatureState!.verify(saved.slice(0, hole.start) + saved.slice(hole.end), f.f.resolver)).toThrow(/missing board feature/);
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.input);
    expect(() => resumed.boardFeatureState!.verify(saved, f.f.resolver)).not.toThrow();
    expect(() => resumed.boardFeatureState!.verify(f.initial, f.f.resolver)).toThrow(/missing board feature/);
  });
  it("resumes a checkpoint-proven outline-only board without consuming initial feature authority", async () => {
    const f = await fixture(undefined, true);
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.input);
    expect(() => resumed.boardFeatureState!.verify(f.initial, f.f.resolver)).not.toThrow();
    expect(() => createFreshBoardFeatureState(resumed.bundle, resumed.preparedSourceAuthority, "a".repeat(64), f.initial)).toThrow(/checkpoint identity/);
    expect(f.physicalReads()).toBe(0);
  });
  it("rejects non-contract geometry and settings before feature staging", async () => {
    const f = await fixture(undefined, true), state = f.preparation.boardFeatureState!;
    const inject = (form: string) => f.initial.replace(/\)\s*$/u, `${form}\n)\n`);
    for (const source of [
      f.initial.replace('(end 30 20)', '(end 30.000000000000000001 20)'),
      f.initial.replace('(start 0 0)', '(start 1 0)'),
      f.initial.replace('(layer "Edge.Cuts")', '(layer "F.Cu")'),
      f.initial.replace('(fill no)', '(fill yes)'),
      f.initial.replace('(thickness 1.6)', '(thickness 1.7)'),
      f.initial.replace('(end 30 20)', '(end 30)'),
      outlined(f.initial), inject('(segment (start 1 1) (end 2 1) (width 0.2) (layer "F.Cu") (net 0))'),
      inject('(zone (net 0) (layer "F.Cu"))'), inject('(unknown_geometry 1)'),
    ]) expect(() => state.verify(source, f.f.resolver)).toThrow();
    expect(f.staged).toHaveLength(0);
  });
  it.each(["drop", "move", "save"] as const)("retains outline-only authority and exact rollback after %s failure", async fault => {
    const f = await fixture(fault, true);
    if (fault === "save") { await f.bridge.execute(sync); expect((await f.bridge.internal.saveAfterMutation(save)).isError).toBe(true); }
    else await expect(f.bridge.execute(sync)).rejects.toThrow(/ROLLED_BACK_TERMINAL/);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.initial); expect(f.live()).toBe(f.initial);
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.input);
    expect(() => resumed.boardFeatureState!.verify(f.initial, f.f.resolver)).not.toThrow();
  });
  it("stages all bound holes atomically, retains raw native inventory, saves, checkpoints and resumes", async () => {
    const f = await fixture(), response = JSON.parse((await f.bridge.execute(sync)).content);
    expect(response).toMatchObject({ componentCount: 3, physicalPadCount: 9, logicalTerminalCount: 7, nonElectricalFeatureCount: 2 });
    expect(f.calls.find(call => call.name === "pcb_sync_from_schematic")!.args.auto_place).toBe(false);
    expect(parseFreshPcbSource(f.staged[0]!).footprints.map(fp => fp.reference)).toEqual(["H1", "H2"]);
    await f.bridge.internal.saveAfterMutation(save);
    const before = await readFile(f.project.pcbPath, "utf8"), ids = parseFreshPcbSource(before).footprints.filter(fp => fp.reference.startsWith("H")).map(fp => [fp.id, fp.pads[0]!.physical.id]);
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.input);
    expect(await readFile(resumed.project.pcbPath, "utf8")).toBe(before);
    expect(parseFreshPcbSource(before).footprints.filter(fp => fp.reference.startsWith("H")).map(fp => [fp.id, fp.pads[0]!.physical.id])).toEqual(ids);
    const beforeRepeat = f.calls.length;
    const repeated = await f.bridge.execute({ ...sync, id: "resync" }), fields = JSON.parse(repeated.content);
    expect(fields).toMatchObject({ applied: true, mutated: false, idempotent: true, nativeSyncDisposition: "verified-no-change", boardFeatureCount: 2 });
    expect(fields).not.toHaveProperty("upstreamMetrics");
    expect(f.calls.slice(beforeRepeat).map(call => call.name)).toEqual(["pcb_sync_from_schematic"]);
    const context = { connectivityIdentity: createFreshConnectivityContract(f.preparation.bundle.contract).identity,
      projectBindingIdentity: f.project.planeBinding.identity, sourceContractIdentity: f.preparation.bundle.contract.identity, boardFeatureCount: 2 };
    expect(planeCompoundMutationState(sync, repeated, context)).toBe(false);
    expect(() => planeCompoundMutationState(sync, repeated, { ...context, boardFeatureCount: 1 })).toThrow(/feature inventory/);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(before); expect(f.live()).toBe(before);
    const republish = await f.lifecycle.prepareCheckpoint(); await republish();
  });
  it.each(["drop", "number", "move", "exclude", "source-drift"] as const)("rolls the whole compound back on %s", async fault => {
    const f = await fixture(fault);
    await expect(f.bridge.execute(sync)).rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL/);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.initial);
    expect(f.live()).toBe(f.initial);
  });
  it("rejects a dropped feature before checkpoint publication", async () => {
    const f = await fixture(); await f.bridge.execute(sync); await f.bridge.internal.saveAfterMutation(save);
    const before = await readFile(f.project.checkpointPath), source = await readFile(f.project.pcbPath, "utf8");
    const fp = parseFreshPcbSourceDocument(source).children.find(node => node.name === "footprint" && node.values[0]?.value === holeId)!;
    await writeFile(f.project.pcbPath, source.slice(0,fp.start) + source.slice(fp.end));
    await f.session.callTool("pcb_revert", {});
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow(/missing board feature/);
    expect(await readFile(f.project.checkpointPath)).toEqual(before);
  });
  it.each([
    ["net", (source: string) => source.replace('(net "VIN")', '(net "GND")')],
    ["feature", (source: string) => source.replace('attr board_only', 'attr')],
    ["geometry", (source: string) => source.replace('(at 3 3)', '(at 3.1 3)')],
  ] as const)("rejects a literal no-change acknowledgement hiding %s drift", async (_name, change) => {
    const f = await fixture(); await f.bridge.execute(sync); await f.bridge.internal.saveAfterMutation(save);
    const before = await readFile(f.project.pcbPath, "utf8"); f.changeOnResync(change);
    await expect(f.bridge.execute({ ...sync, id: "bad-resync" })).rejects.toThrow(/no-change sync changed/);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(before); expect(f.live()).toBe(before);
  });
  it("preserves a schematic-only pre-sync checkpoint and resume", async () => {
    const f = await fixture();
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.input);
    expect(await readFile(resumed.project.pcbPath, "utf8")).toBe(f.initial);
    expect(() => resumed.boardFeatureState!.verify(f.initial, f.f.resolver)).not.toThrow();
    expect(f.physicalReads()).toBe(0);
  });
  it.each(["move", "save"] as const)("keeps prepared-state authority after a rolled-back %s failure", async fault => {
    const f = await fixture(fault);
    if (fault === "move") await expect(f.bridge.execute(sync)).rejects.toThrow(/ROLLED_BACK_TERMINAL/);
    else { await f.bridge.execute(sync); expect((await f.bridge.internal.saveAfterMutation(save)).isError).toBe(true); }
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.initial);
    const publish = await f.lifecycle.prepareCheckpoint(); await publish();
    await expect(resumeKicadToolboxPlaneProject(f.input)).resolves.toMatchObject({ mode: "resumed" });
  });
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ] as const)("rejects deleting all footprints (published=%s, exact prepared bytes=%s)", async (published, exactSeed) => {
    const f = await fixture(); await f.bridge.execute(sync); expect((await f.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    let lifecycle = f.lifecycle;
    if (published) {
      const publish = await lifecycle.prepareCheckpoint(); await publish();
      const resumed = await resumeKicadToolboxPlaneProject(f.input);
      lifecycle = createPlaneToolboxCheckpointLifecycle({ project: resumed.project, preparation: resumed, session: f.session as unknown as KicadMcpSession });
    }
    const checkpoint = await readFile(f.project.checkpointPath), source = await readFile(f.project.pcbPath, "utf8");
    let removed = source;
    for (const fp of parseFreshPcbSourceDocument(source).children.filter(node => node.name === "footprint").reverse()) removed = removed.slice(0, fp.start) + removed.slice(fp.end);
    await writeFile(f.project.pcbPath, exactSeed ? f.initial : removed); await f.session.callTool("pcb_revert", {});
    await expect(lifecycle.prepareCheckpoint()).rejects.toThrow(/missing board feature/);
    expect(await readFile(f.project.checkpointPath)).toEqual(checkpoint);
    if (published) await expect(resumeKicadToolboxPlaneProject(f.input)).rejects.toThrow(/latest checkpoint/);
  });
  it.each(["footprint", "bore"] as const)("rejects changed %s UUID before public connectivity collects native evidence", async kind => {
    const f = await fixture(); await f.bridge.execute(sync); expect((await f.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    await expect(f.bridge.assessPlaneConnectivity!()).resolves.toHaveProperty("nativeObservationIdentity");
    const beforeReads = f.physicalReads(), source = await readFile(f.project.pcbPath, "utf8");
    const hole = parseFreshPcbSource(source).footprints.find(fp => fp.reference === "H1")!;
    const id = kind === "footprint" ? hole.id! : hole.pads[0]!.physical.id!;
    await writeFile(f.project.pcbPath, source.replace(id, "12121212-1212-4212-8212-121212121212")); await f.session.callTool("pcb_revert", {});
    await expect(f.bridge.assessPlaneConnectivity!()).rejects.toThrow(/immutable.*UUID/);
    expect(f.physicalReads()).toBe(beforeReads);
  });
});
