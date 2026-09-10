import { link, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject, type PlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { assessFreshPlaneAcceptance } from "../../src/harness/fresh-plane-acceptance.js";
import { isSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import type { KicadPlaneStageReceipt } from "../../src/integrations/kicad-plane-stage.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";

const fsHook = vi.hoisted(() => ({ afterRead: undefined as ((file: unknown) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    await fsHook.afterRead?.(args[0]);
    return result;
  } };
});

// Offline producer-shaped native receipts exercise the real collectors,
// decoders and assessor. They are not native KiCad or electrical qualification.
type Raw = Record<string, any>;
type Assessor = NonNullable<KicadHarnessToolsOptions["assessFreshPlaneEvidence"]>;
type AssessmentInput = Parameters<Assessor>[0];
const temporaryRoot = path.resolve(tmpdir()), owned = new Set<string>();
afterEach(async () => {
  fsHook.afterRead = undefined;
  for (const root of owned) {
    const relative = path.relative(temporaryRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plane acceptance test cleanup escaped its temporary root.");
    await rm(root, { recursive: true, force: true }); owned.delete(root);
  }
});
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Offline V2 saved-fill authority harness test." }, dependencies);
const uuid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
const pcb = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  ${bundle.contract.components.map((component, index) => `(footprint "${component.footprintLibId}" (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${5 + index * 8} 10)
    (property "Reference" "${component.reference}") (property "Value" "${component.value}")
    ${component.pins.map((pin, ordinal) => `(pad "${pin.pin}" smd rect (uuid "${uuid(100 + index * 10 + ordinal)}") (at ${ordinal * 2} 0) (size 1 1) (layers "F.Cu") (net "${pin.assignment.kind === "net" ? pin.assignment.net : ""}"))`).join(" ")})`).join(" ")})`;
const schematic = `(kicad_sch (version 20250316) (lib_symbols) ${bundle.contract.nets.map(net => `(global_label "${net.name}" (shape passive) (at 10 10 0))`).join(" ")}
  ${bundle.contract.components.map(component => `(symbol (lib_id "${component.symbolLibId}") (at 20 20 0) (unit 1) (property "Reference" "${component.reference}") (property "Value" "${component.value}") (property "Footprint" "${component.footprintLibId}"))`).join(" ")})`;
const apply = { id: "apply", name: "fresh_apply_contract_plane" as const, arguments: {} };
const save = { id: "save", name: "pcb_save" as const, arguments: {} };
const unchangedProperty = { id: "unchanged-property", name: "sch_modify_property" as const,
  arguments: { reference: "R1", field: "Value", value: "10k" } };

async function fixture() {
  const root = await mkdtemp(path.join(temporaryRoot, "evleda-harness-plane-acceptance-")); owned.add(root);
  const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "plane", resume: false,
    compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
  await writeFile(project.pcbPath, pcb, "utf8"); await writeFile(project.schematicPath, schematic, "utf8");
  const physical = await nativePadObservationFixture(pcb), calls: string[] = [], assessments: AssessmentInput[] = [];
  let live = pcb, zones: Raw[] = [], afterStage: (() => Promise<void>) | undefined;
  let assessmentHook: ((input: AssessmentInput) => Promise<void>) | undefined;
  const session: KicadHarnessSession = {
    listTools: () => KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const,
      inputSchema: { type: "object", additionalProperties: true } })),
    supportsNativeRouteTransactions: () => true, supportsPlaneStage: () => true,
    assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
    readActivePcbSource: async expected => { expect(expected).toBe(project.pcbPath); return live; },
    readLivePcbPadSnapshot: async ids => {
      calls.push("pads");
      const generated = await nativePadObservationFixture(live, pcb), payload = structuredClone(generated.observation.rawSnapshot) as Raw;
      const document = { type: "DOCTYPE_PCB", board_filename: path.basename(project.pcbPath), project: { name: project.name, path: project.projectPath } };
      payload.documentBefore = document; payload.documentAfter = document; payload.enabledLayers.request.board = document;
      payload.footprintInventory.request.header.document = document; payload.padstackPresence.request.board = document;
      const queries = new Map(payload.connectivity.map((query: Raw) => [query.sourcePrimitiveId, query]));
      payload.connectivity = ids.map(id => {
        const query = structuredClone(queries.get(id)) as Raw; query.request.header.document = document;
        // No connecting tracks or contact evidence are supplied by this fixture.
        query.padRecordIndexes = [payload.padRecords.findIndex((pad: Raw) => pad.id.value === id)];
        return query;
      });
      return { isError: false, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
    stagePlane: async request => {
      calls.push("stage");
      const generated = await planeStageObservationFixture({ beforePcbSource: await readFile(project.pcbPath, "utf8"), request, beforeZoneProtos: zones });
      zones = [generated.stagedZoneProto]; live = generated.stagedSource;
      await afterStage?.(); return generated.receipt as KicadPlaneStageReceipt;
    },
    callTool: async name => {
      calls.push(name);
      if (name === "pcb_save") await writeFile(project.pcbPath, live, "utf8");
      if (name === "pcb_revert") live = await readFile(project.pcbPath, "utf8");
      return { content: [], structuredContent: { result: name === "pcb_save" ? "Board saved."
        : name === "pcb_revert" ? "Board reverted to last saved state. All unsaved changes have been discarded." : "ok" } };
    },
  };
  const options = (freshProject: PlaneFreshProject): KicadHarnessToolsOptions => ({ freshProject, freshConnectivityContract: bundle.contract,
    freshPlaneCompilationBundle: bundle, freshPhysicalFootprintResolver: physical.expected.physicalFootprintResolver!,
    freshPhysicalFootprintSourcePins: physical.expected.physicalFootprints!,
    capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest, verifyPersistedMutation: async () => false,
    assessFreshPlaneEvidence: async input => {
      calls.push("assess-start"); assessments.push(input); await assessmentHook?.(input);
      const result = await assessFreshPlaneAcceptance(input); calls.push("assess-end"); return result;
    } });
  const tools = createKicadHarnessTools(session, options(project));
  return { root, project, tools, session, calls, assessments, settingsPath: path.join(project.projectPath, `${project.name}.kicad_pro`),
    live: () => live, setLive: (source: string) => { live = source; },
    setStageHook: (hook: typeof afterStage) => { afterStage = hook; },
    setAssessmentHook: (hook: typeof assessmentHook) => { assessmentHook = hook; },
    toolsFor: (freshProject: PlaneFreshProject) => createKicadHarnessTools(session, options(freshProject)) };
}

async function applyAndSave(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.tools.execute(apply)).isError).not.toBe(true);
  const result = await f.tools.internal.saveAfterMutation(save);
  expect(result.isError, result.content).not.toBe(true);
  return JSON.parse(result.content) as Raw;
}

describe("current-session saved plane evidence and acceptance read guards", () => {
  it("has no fill witness before staging, refuses unsaved stages, and issues a branded witness only after qualified save", async () => {
    const f = await fixture();
    expect(await f.tools.assessPlaneAcceptance!()).toMatchObject({ accepted: false, savedEvidenceIdentity: null });
    expect(f.assessments[0]!.savedEvidence).toBeNull();
    expect((await f.tools.execute(apply)).isError).not.toBe(true);
    const count = f.assessments.length;
    await expect(f.tools.assessPlaneAcceptance!()).rejects.toThrow("pending or uncertain");
    expect(f.assessments).toHaveLength(count); expect(f.calls).not.toContain("pcb_save");
    const saved = await f.tools.internal.saveAfterMutation(save); expect(saved.isError, saved.content).not.toBe(true);
    const result = await f.tools.assessPlaneAcceptance!(), input = f.assessments.at(-1)!;
    expect(isSavedFreshPlaneEvidence(input.savedEvidence)).toBe(true);
    expect(result.savedEvidenceIdentity).toEqual(JSON.parse(saved.content).currentSessionFillEvidenceIdentity);
    expect(input.savedEvidence!.savedPcbIdentity).toEqual(contentIdentity(await readFile(f.project.pcbPath)));
    expect(input.savedEvidence!.projectSettingsIdentity).toEqual(contentIdentity(await readFile(f.settingsPath)));
    expect(input.savedEvidence!.rulesIdentity).toEqual(contentIdentity(await readFile(f.project.rulesPath)));
    expect(input.endpointConnectivity.nets.every(net => net.status === "disconnected")).toBe(true);
    expect(result.accepted).toBe(false); expect(result.mandatoryRowsRemaining.length).toBeGreaterThan(0);
  });

  it("does not recover current fill authority from a real saved-checkpoint resume", async () => {
    const f = await fixture(); await applyAndSave(f); await f.tools.assessPlaneAcceptance!();
    expect(isSavedFreshPlaneEvidence(f.assessments.at(-1)!.savedEvidence)).toBe(true);
    const reportPath = path.join(f.project.outputPath, "pcb-agent-report.json");
    await writeFile(reportPath, JSON.stringify({ status: "needs_review", fixture: "offline witness resume" }));
    await f.project.checkpointAfterReport(reportPath, "needs_review");
    const resumed = await preparePlaneFreshProject({ outputDir: f.project.outputPath, name: f.project.name, resume: true,
      compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
    const result = await f.toolsFor(resumed).assessPlaneAcceptance!();
    expect(f.assessments.at(-1)!.savedEvidence).toBeNull();
    expect(result).toMatchObject({ accepted: false, savedEvidenceIdentity: null });
    expect(result.verificationPlanRowsPassed).toEqual([]);
  });

  it.each(["settings", "rules"] as const)("rejects multiply linked %s before the first-fill assessment", async target => {
    const f = await fixture(), targetPath = target === "settings" ? f.settingsPath : f.project.rulesPath;
    await link(targetPath, path.join(f.root, `linked-${path.basename(targetPath)}`));
    await expect(f.tools.assessPlaneAcceptance!()).rejects.toThrow("ordinary project files");
    expect(f.assessments).toEqual([]); expect(f.calls).not.toContain("pads");
  });

  it.each(["mutation", "save"] as const)("invalidates fill authority on a source-equivalent later %s dispatch", async kind => {
    const f = await fixture(); await applyAndSave(f);
    const before = await readFile(f.project.pcbPath), settingsBefore = await readFile(f.settingsPath);
    if (kind === "mutation") {
      await f.tools.execute(unchangedProperty);
      expect(await f.tools.internal.classifyPendingMutationBatch!()).toMatchObject({ status: "no-governed-effect" });
    } else await f.tools.internal.execute({ ...save, id: "source-equivalent-save" });
    expect(await readFile(f.project.pcbPath)).toEqual(before); expect(await readFile(f.settingsPath)).toEqual(settingsBefore);
    expect(await f.tools.assessPlaneAcceptance!()).toMatchObject({ accepted: false, savedEvidenceIdentity: null });
    expect(f.assessments.at(-1)!.savedEvidence).toBeNull();
  });

  it.each([
    ["stage", "settings"], ["save", "settings"], ["stage", "rules"], ["save", "rules"],
  ] as const)("rejects %s-time %s drift without issuing fill authority", async (phase, target) => {
    const f = await fixture();
    const targetPath = target === "settings" ? f.settingsPath : f.project.rulesPath;
    const change = async () => { await writeFile(targetPath, `${await readFile(targetPath, "utf8")}\n`); };
    if (phase === "stage") f.setStageHook(change);
    else {
      const call = f.session.callTool;
      f.session.callTool = async (name, args) => { const result = await call(name, args); if (name === "pcb_save") await change(); return result; };
    }
    const staged = await f.tools.execute(apply);
    const result = phase === "stage" ? staged : await f.tools.internal.saveAfterMutation(save);
    expect(result.isError).toBe(true); expect(JSON.parse(result.content)).toMatchObject({ recoveryRequired: true });
    expect(JSON.parse(result.content).message).toMatch(/settings|rules|fill inputs/i);
    await expect(f.tools.assessPlaneAcceptance!()).rejects.toThrow("pending or uncertain");
    expect(f.assessments).toEqual([]);
    if (phase === "stage") expect(f.calls).not.toContain("pcb_save");
  });

  it("rejects changed PCB bytes observed inside the final post-save settings fence", async () => {
    const f = await fixture(); expect((await f.tools.execute(apply)).isError).not.toBe(true);
    const changed = f.live().replace("thickness 1.6", "thickness 1.7");
    let saved = false, changedAtFence = false;
    const call = f.session.callTool;
    f.session.callTool = async (name, args) => { const result = await call(name, args); if (name === "pcb_save") saved = true; return result; };
    fsHook.afterRead = async file => {
      if (file === f.settingsPath && saved && !changedAtFence) {
        changedAtFence = true; await writeFile(f.project.pcbPath, changed, "utf8");
      }
    };
    const result = await f.tools.internal.saveAfterMutation(save);
    expect(changedAtFence).toBe(true); expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).message).toMatch(/Plane fill.*changed/i);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed);
    expect(f.calls).not.toContain("pcb_revert");
    await expect(f.tools.assessPlaneAcceptance!()).rejects.toThrow("pending or uncertain");
    expect(f.assessments).toEqual([]);
  });

  it.each(["acceptance", "endpoint"] as const)("rejects PCB drift during the final settings capture of an %s read", async kind => {
    const f = await fixture(); await applyAndSave(f);
    const before = f.live(), changed = before.replace("thickness 1.6", "thickness 1.7");
    let nativeQueryFinished = false, changedAtFence = false;
    const readPads = f.session.readLivePcbPadSnapshot!;
    f.session.readLivePcbPadSnapshot = async ids => {
      const result = await readPads(ids); nativeQueryFinished = true; return result;
    };
    fsHook.afterRead = async file => {
      if (file === f.settingsPath && nativeQueryFinished && !changedAtFence) {
        changedAtFence = true; await writeFile(f.project.pcbPath, changed, "utf8");
      }
    };
    const read = kind === "acceptance" ? f.tools.assessPlaneAcceptance!() : f.tools.assessPlaneConnectivity!();
    await expect(read).rejects.toThrow("PCB source, marker, or physical scope changed");
    expect(nativeQueryFinished).toBe(true); expect(changedAtFence).toBe(true);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed); expect(f.live()).toBe(before);
    expect(f.assessments).toHaveLength(kind === "acceptance" ? 1 : 0);
    expect(f.calls.filter(name => name === "pcb_save")).toHaveLength(1); expect(f.calls).not.toContain("pcb_revert");
  });

  it.each(["source", "live", "settings", "rules", "marker"] as const)("rejects %s changed by the assessor before publishing its result", async kind => {
    const f = await fixture(); await applyAndSave(f);
    f.setAssessmentHook(async input => {
      expect(isSavedFreshPlaneEvidence(input.savedEvidence)).toBe(true);
      if (kind === "source") await writeFile(f.project.pcbPath, input.pcbSource.replace("thickness 1.6", "thickness 1.7"), "utf8");
      if (kind === "live") f.setLive(input.pcbSource.replace("thickness 1.6", "thickness 1.7"));
      if (kind === "settings") await writeFile(f.settingsPath, `${input.projectSettingsSource}\n`, "utf8");
      if (kind === "rules") await writeFile(f.project.rulesPath, `${input.rulesSource}\n`, "utf8");
      if (kind === "marker") await writeFile(f.project.markerPath, `${await readFile(f.project.markerPath, "utf8")}\n`, "utf8");
    });
    await expect(f.tools.assessPlaneAcceptance!()).rejects.toThrow(/changed|source|marker|rules|identity/i);
    expect(f.assessments).toHaveLength(1); expect(f.calls).toContain("assess-end");
    expect(f.calls.filter(name => name === "pcb_save")).toHaveLength(1); expect(f.calls).not.toContain("pcb_revert");
  });

  it("serializes a queued source-equivalent mutation after a current-evidence assessment", async () => {
    const f = await fixture(); await applyAndSave(f);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.setAssessmentHook(async input => { expect(isSavedFreshPlaneEvidence(input.savedEvidence)).toBe(true); entered(); await gate; });
    const assessment = f.tools.assessPlaneAcceptance!();
    await Promise.race([started, assessment.then(() => { throw new Error("Assessment completed before its queued-mutation test gate."); })]);
    const mutation = f.tools.execute(unchangedProperty);
    try { expect(f.calls).not.toContain("sch_modify_property"); }
    finally { release(); }
    expect((await assessment).savedEvidenceIdentity).not.toBeNull(); await mutation;
    expect(f.calls.indexOf("assess-end")).toBeLessThan(f.calls.indexOf("sch_modify_property"));
    expect(await f.tools.internal.classifyPendingMutationBatch!()).toMatchObject({ status: "no-governed-effect" });
    f.setAssessmentHook(undefined);
    expect((await f.tools.assessPlaneAcceptance!()).savedEvidenceIdentity).toBeNull();
  });
});
