import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import type { KicadPlaneStageReceipt } from "../../src/integrations/kicad-plane-stage.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";

// Fully offline source/port simulation. The real host collector and decoders run;
// this fixture itself is not native KiCad or electrical acceptance evidence.
type Raw = Record<string, any>;
const owned = new Set<string>();
afterEach(async () => { for (const directory of owned) { await rm(directory, { recursive: true, force: true }); owned.delete(directory); } });
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Offline V2 endpoint harness test." }, dependencies);
const uuid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
const pcb = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  ${bundle.contract.components.map((component, index) => `(footprint "${component.footprintLibId}" (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${4 + index * 7} 10)
    (property "Reference" "${component.reference}") (property "Value" "${component.value}")
    ${component.pins.map((pin, ordinal) => `(pad "${pin.pin}" smd rect (uuid "${uuid(100 + index * 10 + ordinal)}") (at ${ordinal * 2} 0) (size 1 1) (layers "F.Cu") (net "${pin.assignment.kind === "net" ? pin.assignment.net : ""}"))`).join(" ")})`).join(" ")})`;
const schematic = `(kicad_sch (version 20250316) (lib_symbols) ${bundle.contract.nets.map(net => `(global_label "${net.name}" (shape passive) (at 10 10 0))`).join(" ")}
  ${bundle.contract.components.map(component => `(symbol (lib_id "${component.symbolLibId}") (at 20 20 0) (unit 1) (property "Reference" "${component.reference}") (property "Value" "${component.value}") (property "Footprint" "${component.footprintLibId}"))`).join(" ")})`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-plane-endpoint-harness-")); owned.add(root);
  const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "endpoints", resume: false, compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
  await writeFile(project.pcbPath, pcb, "utf8"); await writeFile(project.schematicPath, schematic, "utf8");
  const physical = await nativePadObservationFixture(pcb), calls: string[] = [], requests: string[][] = [];
  let live = pcb, changedLibrary = false, onRead: ((payload: Raw) => Promise<void> | void) | undefined;
  const resolver = { inspectFootprint(libraryId: string) {
    const result = physical.expected.physicalFootprintResolver!.inspectFootprint(libraryId);
    return !changedLibrary || result === null ? result : { ...result, sourceIdentity: { ...result.sourceIdentity, digest: "0".repeat(64) } };
  } };
  const session: KicadHarnessSession = {
    listTools: () => KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const, inputSchema: { type: "object", additionalProperties: true } })),
    supportsNativeRouteTransactions: () => true, supportsPlaneStage: () => true,
    assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
    readActivePcbSource: async expected => { expect(expected).toBe(project.pcbPath); calls.push("live"); return live; },
    readLivePcbPadSnapshot: async ids => {
      calls.push("pads"); requests.push([...ids]);
      const generated = await nativePadObservationFixture(live, pcb), payload = structuredClone(generated.observation.rawSnapshot) as Raw;
      const document = { type: "DOCTYPE_PCB", board_filename: path.basename(project.pcbPath), project: { name: project.name, path: path.dirname(project.pcbPath) } };
      payload.documentBefore = document; payload.documentAfter = document; payload.enabledLayers.request.board = document;
      payload.footprintInventory.request.header.document = document; payload.padstackPresence.request.board = document;
      const queries = new Map(payload.connectivity.map((query: Raw) => [query.sourcePrimitiveId, query]));
      payload.connectivity = ids.map(id => { const query = structuredClone(queries.get(id)) as Raw; query.request.header.document = document; return query; });
      await onRead?.(payload);
      return { isError: false, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
    stagePlane: async request => {
      calls.push("stage"); const generated = await planeStageObservationFixture({ beforePcbSource: await readFile(project.pcbPath, "utf8"), request });
      live = generated.stagedSource; return generated.receipt as KicadPlaneStageReceipt;
    },
    callTool: async name => {
      calls.push(name);
      if (name === "pcb_save") await writeFile(project.pcbPath, live, "utf8");
      if (name === "pcb_revert") live = await readFile(project.pcbPath, "utf8");
      return { content: [], structuredContent: { result: name === "pcb_save" ? "Board saved." : name === "pcb_revert" ? "Board reverted to last saved state. All unsaved changes have been discarded." : "read" } };
    },
  };
  const tools = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
    freshPhysicalFootprintResolver: resolver, freshPhysicalFootprintSourcePins: physical.expected.physicalFootprints!,
    capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest, verifyPersistedMutation: async () => false });
  return { project, tools, session, calls, requests, setLive: (value: string) => { live = value; }, live: () => live,
    setReadHook: (hook: typeof onRead) => { onRead = hook; }, changeLibrary: () => { changedLibrary = true; } };
}

describe("serialized current saved V2 endpoint connectivity", () => {
  it("collects each endpoint individually under marker/bundle/library scope and returns bounded reachability limits", async () => {
    const f = await fixture(), result = await f.tools.assessPlaneConnectivity!();
    expect(result.status).toBe("connected"); expect(result.nets).toHaveLength(3);
    expect(f.requests).toHaveLength(1); expect(f.requests[0]).toHaveLength(7); expect(new Set(f.requests[0]).size).toBe(7);
    expect(result.savedSourceIdentity).toEqual(contentIdentity(pcb)); expect(result.contractIdentity).toEqual(bundle.contract.identity);
    expect(result.verificationPlanIdentity).toEqual(bundle.verificationPlan.identity);
    expect(result.acceptanceEvaluated).toBe(false); expect(result.verificationPlanRowsPassed).toEqual([]);
    expect(result.limitations.crossNetShortAbsence).toBe("not_established-by-native-connectivity-traversal");
    expect(f.tools.tools.some(tool => tool.name === ("assessPlaneConnectivity" as string))).toBe(false);
    expect(f.calls.every(call => ["live", "pads"].includes(call))).toBe(true);
  });

  it("retains partial signal disconnection while ground remains connected", async () => {
    const f = await fixture(); f.setReadHook(payload => {
      for (const query of payload.connectivity) {
        const index = payload.padRecords.findIndex((pad: Raw) => pad.id.value === query.sourcePrimitiveId);
        if (payload.padRecords[index].net.name === "VOUT") query.padRecordIndexes = [index];
      }
    });
    const result = await f.tools.assessPlaneConnectivity!(); expect(result.status).toBe("partially-connected");
    expect(result.nets.find(net => net.net === "VOUT")!.status).toBe("disconnected");
    expect(result.nets.find(net => net.net === "GND")!.status).toBe("connected");
  });

  it("rejects unsaved native changes before any PAD query", async () => {
    const f = await fixture(); f.setLive(pcb.replace("thickness 1.6", "thickness 1.7"));
    await expect(f.tools.assessPlaneConnectivity!()).rejects.toThrow("unsaved native"); expect(f.requests).toEqual([]);
  });

  it.each(["source", "marker", "live", "library"] as const)("refuses to publish after %s changes during collection", async kind => {
    const f = await fixture(); f.setReadHook(async () => {
      if (kind === "source") await writeFile(f.project.pcbPath, pcb.replace("thickness 1.6", "thickness 1.7"), "utf8");
      if (kind === "marker") await writeFile(f.project.markerPath, (await readFile(f.project.markerPath, "utf8")) + "\n", "utf8");
      if (kind === "live") f.setLive(pcb.replace("thickness 1.6", "thickness 1.7"));
      if (kind === "library") f.changeLibrary();
    });
    await expect(f.tools.assessPlaneConnectivity!()).rejects.toThrow(/changed|source|marker|library/i);
    expect(f.calls).not.toContain("pcb_save"); expect(f.calls).not.toContain("pcb_revert");
  });

  it("serializes the read with existing provider operations", async () => {
    const f = await fixture(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.setReadHook(async () => { entered(); await gate; });
    const first = f.tools.assessPlaneConnectivity!(); await started;
    const next = f.tools.execute({ id: "queued", name: "pcb_get_footprints", arguments: {} });
    expect(f.calls).not.toContain("pcb_get_footprints"); release();
    await expect(first).resolves.toMatchObject({ status: "connected" }); await next;
    expect(f.calls.at(-1)).toBe("pcb_get_footprints");
  });

  it("rejects a pending unsaved plane stage without saving or rolling it back", async () => {
    const f = await fixture(); const staged = await f.tools.execute({ id: "stage", name: "fresh_apply_contract_plane", arguments: {} });
    expect(staged.isError).not.toBe(true); const count = f.requests.length, live = f.live();
    await expect(f.tools.assessPlaneConnectivity!()).rejects.toThrow("pending or uncertain");
    expect(f.requests).toHaveLength(count); expect(f.live()).toBe(live);
    expect(f.calls).not.toContain("pcb_save"); expect(f.calls).not.toContain("pcb_revert");
  });

  it("rejects non-plane/copy workflows and missing complete native PAD replies", async () => {
    const f = await fixture(); const copy = createKicadHarnessTools(f.session, {});
    await expect(copy.assessPlaneConnectivity!()).rejects.toThrow("genuine V2");
    f.session.readLivePcbPadSnapshot = async () => ({ isError: true, content: [{ type: "text", text: "native failed" }] });
    await expect(f.tools.assessPlaneConnectivity!()).rejects.toThrow();
  });
});
