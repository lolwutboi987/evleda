import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createPcbPlaneCompilationBundleRef, isAuthenticatedPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { prepareFreshProject, preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import type { SavedInterfaceAssessment, SavedInterfaceAssessmentInput } from "../../src/harness/saved-interface-assessment.js";
import type { KicadTransmissionLineCalculator } from "../../src/integrations/kicad-transmission-line.js";
import type { KicadPlaneStageReceipt } from "../../src/integrations/kicad-plane-stage.js";
import { interfaceConstructionBundle } from "../helpers/interface-construction-bundle.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";

// Guard-only tests: the project/bundle/read collectors/PAD decoder are real.
// The native port is simulated and the assessment result is only an opaque
// sentinel. Neither mock grants mathematical, native or physical proof.
const seams = vi.hoisted(() => ({ assess: vi.fn<(input: SavedInterfaceAssessmentInput) => Promise<SavedInterfaceAssessment>>() }));
vi.mock("../../src/harness/saved-interface-assessment.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/harness/saved-interface-assessment.js")>(), assessSavedInterface: seams.assess,
}));
const sentinel = Object.freeze({ guardOnlySentinel: true }) as unknown as SavedInterfaceAssessment;
beforeEach(() => { seams.assess.mockReset(); seams.assess.mockResolvedValue(sentinel); });
const owned = new Set<string>();
const prefix = "evleda-interface-harness-";
async function ownedRoot() {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), prefix)); owned.add(directory); return directory;
}
afterEach(async () => {
  const temporary = await realpath(os.tmpdir());
  for (const directory of owned) {
    const resolved = await realpath(directory), info = await lstat(directory);
    if (resolved !== directory || path.dirname(resolved) !== temporary || !path.basename(resolved).startsWith(prefix)
        || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe interface fixture cleanup");
    await rm(resolved, { recursive: true, force: true }); owned.delete(directory);
  }
});

type Raw = Record<string, any>;
const bundle = interfaceConstructionBundle();
const uuid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
const footprintSource = bundle.contract.components.map((component, index) => `(footprint "${component.footprintLibId}"
  (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${4 + index * 7} 10)
  (property "Reference" "${component.reference}") (property "Value" "${component.value}")
  ${component.pins.map((pin, ordinal) => `(pad "${pin.pin}" smd rect (uuid "${uuid(100 + index * 10 + ordinal)}")
    (at ${ordinal * 2} 0) (size 1 1) (layers "F.Cu") (net "${pin.assignment.kind === "net" ? pin.assignment.net : ""}"))`).join(" ")})`).join("\n");
const schematic = `(kicad_sch (version 20250316) (lib_symbols)
  ${bundle.contract.nets.map(net => `(global_label "${net.name}" (shape passive) (at 10 10 0))`).join(" ")}
  ${bundle.contract.components.map(component => `(symbol (lib_id "${component.symbolLibId}") (at 20 20 0) (unit 1)
    (property "Reference" "${component.reference}") (property "Value" "${component.value}") (property "Footprint" "${component.footprintLibId}"))`).join(" ")})`;

async function fixture() {
  const root = await ownedRoot();
  const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "interface-guards", resume: false,
    compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
  const seed = await readFile(project.pcbPath, "utf8"), closing = seed.lastIndexOf(")");
  if (closing < 0) throw new Error("Prepared construction fixture lacks its PCB root");
  // Preserve the actual prepared construction/stackup and use CRLF to make the
  // saved-byte forwarding assertion stricter than normalized source equality.
  const pcb = (seed.slice(0, closing) + footprintSource + "\n" + seed.slice(closing)).replace(/\r?\n/gu, "\r\n");
  await writeFile(project.pcbPath, pcb, "utf8"); await writeFile(project.schematicPath, schematic, "utf8");
  const physical = await nativePadObservationFixture(pcb), calls: string[] = [], requests: string[][] = [];
  let live = pcb, changedLibrary = false, liveReadCount = 0;
  let onPadReply: ((payload: Raw) => void | Promise<void>) | undefined;
  let onLiveRead: ((index: number) => void | Promise<void>) | undefined;
  let onStage: (() => void) | undefined;
  const resolver = { inspectFootprint(libraryId: string) {
    const result = physical.expected.physicalFootprintResolver!.inspectFootprint(libraryId);
    return !changedLibrary || result === null ? result : { ...result, sourceIdentity: { ...result.sourceIdentity, digest: "0".repeat(64) } };
  } };
  const session: KicadHarnessSession = {
    listTools: () => KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const,
      inputSchema: { type: "object", additionalProperties: true } })),
    supportsNativeRouteTransactions: () => true, supportsPlaneStage: () => true,
    assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
    readActivePcbSource: async expected => {
      expect(expected).toBe(project.pcbPath); calls.push("live"); await onLiveRead?.(++liveReadCount); return live;
    },
    readLivePcbPadSnapshot: async ids => {
      calls.push("pads"); requests.push([...ids]);
      const generated = await nativePadObservationFixture(live, pcb), payload = structuredClone(generated.observation.rawSnapshot) as Raw;
      const document = { type: "DOCTYPE_PCB", board_filename: path.basename(project.pcbPath),
        project: { name: project.name, path: path.dirname(project.pcbPath) } };
      payload.documentBefore = document; payload.documentAfter = document; payload.enabledLayers.request.board = document;
      payload.footprintInventory.request.header.document = document; payload.padstackPresence.request.board = document;
      const byId = new Map(payload.connectivity.map((query: Raw) => [query.sourcePrimitiveId, query]));
      payload.connectivity = ids.map(id => {
        const query = structuredClone(byId.get(id)) as Raw; query.request.header.document = document; return query;
      });
      await onPadReply?.(payload);
      return { isError: false, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
    stagePlane: async request => {
      calls.push("stage"); onStage?.();
      const generated = await planeStageObservationFixture({ beforePcbSource: await readFile(project.pcbPath, "utf8"), request });
      live = generated.stagedSource; return generated.receipt as KicadPlaneStageReceipt;
    },
    callTool: async name => {
      calls.push(name);
      if (name === "pcb_save") await writeFile(project.pcbPath, live, "utf8");
      if (name === "pcb_revert") live = await readFile(project.pcbPath, "utf8");
      return { content: [], structuredContent: { result: name === "pcb_save" ? "Board saved."
        : name === "pcb_revert" ? "Board reverted to last saved state. All unsaved changes have been discarded." : "read" } };
    },
  };
  const options = { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
    freshPhysicalFootprintResolver: resolver, freshPhysicalFootprintSourcePins: physical.expected.physicalFootprints!,
    capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
    verifyPersistedMutation: async () => false };
  return { project, options, tools: createKicadHarnessTools(session, options), session, pcb, calls, requests,
    setLive: (value: string) => { live = value; }, live: () => live, changeLibrary: () => { changedLibrary = true; },
    setPadReplyHook: (hook: typeof onPadReply) => { onPadReply = hook; },
    setLiveReadHook: (hook: typeof onLiveRead) => { onLiveRead = hook; }, setStageHook: (hook: typeof onStage) => { onStage = hook; } };
}
const noSaveOrRevert = (calls: readonly string[]) => { expect(calls).not.toContain("pcb_save"); expect(calls).not.toContain("pcb_revert"); };
function blockedAssessor() {
  const entered = Promise.withResolvers<SavedInterfaceAssessmentInput>(), release = Promise.withResolvers<void>();
  seams.assess.mockImplementationOnce(async input => { entered.resolve(input); await release.promise; return sentinel; });
  return { entered: entered.promise, release: () => release.resolve() };
}
function blockedInput(gate: ReturnType<typeof blockedAssessor>, pending: Promise<SavedInterfaceAssessment>) {
  return Promise.race([gate.entered, pending.then(() => { throw new Error("Harness settled without the blocked assessor entry"); })]);
}

describe("interface assessment harness binding and read fences only", () => {
  it("forwards exact saved bytes, the genuine bundle, interface ID and host calculator before awaiting the assessor", async () => {
    const f = await fixture(), gate = blockedAssessor();
    // This opaque marker is only forwarded to the mocked assessor. It is not a
    // branded calculator and must never be invoked or treated as numerical proof.
    const calculate = vi.fn(async () => { throw new Error("Guard-only calculator marker must never run"); });
    const calculator: KicadTransmissionLineCalculator = Object.freeze({ calculate });
    const pending = f.tools.assessInterface!("LINK", calculator);
    try {
      const captured = await blockedInput(gate, pending);
      expect(Buffer.isBuffer(captured.savedPcbBytes)).toBe(true);
      expect(Buffer.from(captured.savedPcbBytes)).toEqual(await readFile(f.project.pcbPath));
      expect(contentIdentity(captured.savedPcbBytes)).toEqual(contentIdentity(Buffer.from(f.pcb)));
      expect(captured.compilationBundle).toBe(bundle);
      expect(isAuthenticatedPcbPlaneCompilationBundle(captured.compilationBundle)).toBe(true);
      expect(captured.interfaceId).toBe("LINK"); expect(captured.calculator).toBe(calculator);
      expect(Object.keys(captured).sort()).toEqual(["calculator", "compilationBundle", "interfaceId", "savedPcbBytes"]);
      expect(f.requests).toHaveLength(1); expect(f.requests[0]).toHaveLength(6); expect(new Set(f.requests[0]).size).toBe(6);
      expect(f.calls).toEqual(["live", "pads"]);
      expect(f.tools.tools.some(tool => tool.name === ("assessInterface" as string))).toBe(false);
    } finally { gate.release(); await Promise.allSettled([pending]); }
    expect(await pending).toBe(sentinel); expect(calculate).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["live", "pads", "live"]); noSaveOrRevert(f.calls);
  });

  it("omits an absent host calculator rather than constructing or substituting one", async () => {
    const f = await fixture(); expect(await f.tools.assessInterface!("LINK")).toBe(sentinel);
    const input = seams.assess.mock.calls[0]![0]; expect(input.interfaceId).toBe("LINK");
    expect(Object.hasOwn(input, "calculator")).toBe(false); noSaveOrRevert(f.calls);
  });

  it("rejects copied plane project and copied bundle objects at harness construction", async () => {
    const f = await fixture();
    expect(() => createKicadHarnessTools(f.session, { ...f.options, freshProject: { ...f.project } })).toThrow(/copied|unauthenticated/i);
    expect(() => createKicadHarnessTools(f.session, { ...f.options, freshPlaneCompilationBundle: structuredClone(bundle) })).toThrow(/authentic|binding|bundle/i);
    expect(seams.assess).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });

  it("rejects copied-project and genuine non-plane generic workflows before native reads", async () => {
    const f = await fixture(), copied = createKicadHarnessTools(f.session, {});
    await expect(copied.assessInterface!("LINK")).rejects.toThrow(/genuine V2/i);
    const generic = createGenericDividerBundleFixture(), root = await ownedRoot();
    const project = await prepareFreshProject({ outputDir: path.join(root, "output"), name: "generic", resume: false,
      workflowKind: "generic", compilationBundle: generic.bundle, compilationBundleRef: generic.reference });
    const tools = createKicadHarnessTools(f.session, { freshProject: project, freshConnectivityContract: generic.bundle.contract,
      freshCompilationBundle: generic.bundle });
    await expect(tools.assessInterface!("LINK")).rejects.toThrow(/genuine V2/i);
    expect(seams.assess).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });

  it("rejects unsaved live PCB differences before PAD collection or assessor dispatch", async () => {
    const f = await fixture(); f.setLive(f.pcb.replace("thickness 1.57", "thickness 1.58"));
    expect(f.live()).not.toBe(f.pcb);
    await expect(f.tools.assessInterface!("LINK")).rejects.toThrow(/unsaved native/i);
    expect(f.requests).toEqual([]); expect(seams.assess).not.toHaveBeenCalled(); noSaveOrRevert(f.calls);
  });

  it("requires the real complete PAD decoder to accept the simulated native reply before dispatch", async () => {
    const f = await fixture(); f.setPadReplyHook(payload => { payload.enabledLayers.response.copper_layer_count = 4; });
    await expect(f.tools.assessInterface!("LINK")).rejects.toThrow();
    expect(f.requests).toHaveLength(1); expect(seams.assess).not.toHaveBeenCalled(); noSaveOrRevert(f.calls);
  });

  it.each(["pcb", "live", "schematic", "project", "rules", "marker", "sym-lib-table", "fp-lib-table", "physical-library"] as const)
    ("suppresses an awaited assessor result after exact %s drift", async kind => {
      const f = await fixture(), gate = blockedAssessor();
      const pending = f.tools.assessInterface!("LINK");
      const outcome = pending.then(value => ({ published: true as const, value }), error => ({ published: false as const, error }));
      try {
        const captured = await blockedInput(gate, pending), beforeBytes = Buffer.from(captured.savedPcbBytes);
        if (kind === "live") f.setLive(f.pcb.replace("thickness 1.57", "thickness 1.58"));
        else if (kind === "physical-library") f.changeLibrary();
        else {
          const file = kind === "pcb" ? f.project.pcbPath : kind === "schematic" ? f.project.schematicPath
            : kind === "project" ? path.join(f.project.projectPath, `${f.project.name}.kicad_pro`)
              : kind === "rules" ? f.project.rulesPath : kind === "marker" ? f.project.markerPath : path.join(f.project.projectPath, kind);
          const before = await readFile(file); await writeFile(file, Buffer.concat([before, Buffer.from("\n")]));
          expect(contentIdentity(await readFile(file))).not.toEqual(contentIdentity(before));
        }
        // The consumer retains the original exact source snapshot even when the
        // owning host's final read fence must discard its otherwise-ready value.
        expect(Buffer.from(captured.savedPcbBytes)).toEqual(beforeBytes);
        expect(contentIdentity(captured.savedPcbBytes)).toEqual(contentIdentity(Buffer.from(f.pcb)));
      } finally { gate.release(); await Promise.allSettled([pending, outcome]); }
      const result = await outcome; expect(result.published).toBe(false);
      if (!result.published) expect(String(result.error)).toMatch(/changed|source|marker|library|settings|rules|native/i);
      expect(seams.assess).toHaveBeenCalledTimes(1); noSaveOrRevert(f.calls);
    });

  it("rejects pending staged plane mutation without saving, rolling back or dispatching the assessor", async () => {
    const f = await fixture();
    const staged = await f.tools.execute({ id: "stage", name: "fresh_apply_contract_plane", arguments: {} });
    expect(staged.isError).not.toBe(true); const count = f.requests.length, live = f.live();
    await expect(f.tools.assessInterface!("LINK")).rejects.toThrow(/pending or uncertain/i);
    expect(f.requests).toHaveLength(count); expect(f.live()).toBe(live); expect(seams.assess).not.toHaveBeenCalled(); noSaveOrRevert(f.calls);
  });

  it("serializes a queued plane mutation after assessment and its final read fence", async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const events: string[] = [];
    f.setLiveReadHook(async index => {
      if (index !== 2) return; // The read after the assessor, before the rest of the final source fence.
      events.push("final-live-entered"); entered.resolve(); await release.promise; events.push("final-live-completed");
    });
    f.setStageHook(() => {
      events.push("stage"); expect(events).toContain("final-live-completed"); expect(events).toContain("assessment-settled");
    });
    const assessment = f.tools.assessInterface!("LINK").then(value => { events.push("assessment-settled"); return value; });
    let mutation: ReturnType<typeof f.tools.execute> | undefined;
    try {
      await Promise.race([entered.promise, assessment.then(() => { throw new Error("Expected the final live-read fence to block"); })]);
      mutation = f.tools.execute({ id: "queued-plane", name: "fresh_apply_contract_plane", arguments: {} });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(["final-live-entered"]); expect(f.calls).not.toContain("stage");
      release.resolve(); expect(await assessment).toBe(sentinel);
      expect((await mutation).isError).not.toBe(true);
      expect(events).toEqual(["final-live-entered", "final-live-completed", "assessment-settled", "stage"]);
    } finally { release.resolve(); await Promise.allSettled([assessment, ...(mutation === undefined ? [] : [mutation])]); }
    expect(f.calls.filter(call => call === "stage")).toHaveLength(1);
    await expect(f.tools.assessInterface!("LINK")).rejects.toThrow(/pending or uncertain/i);
    expect(seams.assess).toHaveBeenCalledTimes(1); noSaveOrRevert(f.calls);
  });
});
