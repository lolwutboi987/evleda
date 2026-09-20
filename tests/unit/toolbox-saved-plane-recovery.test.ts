import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";
import { qualifySavedPlaneRecovery, executeQualifiedSavedPlaneRecovery, type SavedPlaneRecoveryRequest,
  type SavedPlaneRecoveryDependencies } from "../../src/mcp/toolbox-saved-plane-recovery.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import type { loadKicadToolboxFreshProfile } from "../../src/mcp/toolbox-fresh-profile.js";
import { parsePlacementRevisionLineage } from "../../src/mcp/toolbox-placement-revision.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";

const owned: Awaited<ReturnType<typeof placementRevisionFixture>>[] = [];
afterEach(async () => { for (const f of owned.splice(0)) await f.f.cleanup(); });
async function fixture() {
  const h = await placementRevisionFixture({ viaBudgetHeadroom: true }); owned.push(h);
  const root = h.preparation.project.projectPath, output = h.preparation.project.outputPath, evidence = path.join(h.f.root, "evidence");
  await mkdir(evidence);
  const put = async (file: string, value: string | object) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n"); await writeFile(file, bytes);
    return { path: file, contentIdentity: contentIdentity(bytes) };
  };
  for (const [key, extension] of Object.entries({ pcb: "kicad_pcb", sch: "kicad_sch", pro: "kicad_pro", dru: "kicad_dru" }) as [keyof typeof h.input.sources, string][])
    await put(path.join(root, `seeded.${extension}`), h.input.sources[key]);
  await h.f.store.acquireLease(h.sourceAllocation.projectId); // Fixture tracks this deliberately retained quarantine lease.
  const marker = await readFile(h.preparation.project.markerPath), reportPath = h.preparation.reportPath;
  const unsafe = await put(path.join(output, ".evleda-pcb-agent-unsafe-terminal.json"), { schemaVersion: "evleda.pcb-agent-unsafe-terminal.v1",
    projectPath: root, reportPath, reportSha256: contentIdentity(await readFile(reportPath)).digest, reason: "Synthetic failed native close" });
  const sourceNativePins = {} as SavedPlaneRecoveryRequest["sourceNativePins"];
  for (const [key, file] of Object.entries({ pcb: "seeded.kicad_pcb", sch: "seeded.kicad_sch", pro: "seeded.kicad_pro", dru: "seeded.kicad_dru",
    fpLibTable: "fp-lib-table", symLibTable: "sym-lib-table" })) sourceNativePins[key as keyof typeof sourceNativePins] = contentIdentity(await readFile(path.join(root, file)));
  const now = Date.parse("2026-09-20T00:00:00Z"), at = (n: number) => new Date(now + n * 1000).toISOString();
  const session = await put(path.join(evidence, "session.json"), { startedAt: at(0), serverArgs: ["--profile", h.f.profile.path,
    "--profile-sha256", h.f.profile.contentIdentity.digest, "--profile-bytes", String(h.f.profile.contentIdentity.size), "--workspace-root", h.f.workspaceRoot, "--edit"] });
  const response = async (name: string, args: object, data: object, error: boolean, index: number) => {
    const request = await put(path.join(evidence, `request-${index}.json`), { id: String(index), operation: "call", name, arguments: args });
    return put(path.join(evidence, `response-${index}.json`), { recordedAt: at(index), disposition: "response", isError: error,
      request: { path: request.path, identity: request.contentIdentity }, result: { isError: error, structuredContent: data } });
  };
  const savedPlaneResponse = await response("fresh_apply_contract_plane", { planeId: "GND_PLANE" }, { result: { content: JSON.stringify({
    applied: true, sourceContractIdentity: h.source.contract.identity, freshMarkerContentIdentity: contentIdentity(marker) }) },
    persistence: { content: JSON.stringify({ status: "plane-native-saved-and-source-verified", nativeSaveCalled: true, savedPcbContentIdentity: sourceNativePins.pcb }) } }, false, 1);
  const staged = h.input.sources.pcb + "\n" + " ".repeat(510_000);
  const failedBody = { schemaVersion: "evleda.fresh-plane-apply-failure.v1", stage: "stage-validation", code: "PLANE_APPLY_TERMINAL",
    recoveryRequired: true, editingSessionMustClose: true, rollback: "not-attempted-unknown-or-external-state",
    message: "KiCad live board readback is absent, truncated, or over its host bound.",
    beforePcbContentIdentity: sourceNativePins.pcb, acceptedStagedPcbContentIdentity: contentIdentity(staged) };
  const failedPlaneResponse = await response("fresh_apply_contract_plane", { planeId: "GND_PLANE" }, { recoveryRequired: true,
    result: { content: JSON.stringify({ ...failedBody, identity: canonicalIdentity(failedBody, failedBody.schemaVersion) }) } }, true, 2);
  const failedCloseResponse = await response("evleda_close_project", { projectId: h.sourceAllocation.projectId },
    { error: "Native toolbox cleanup was not confirmed; owned state was retained." }, true, 3);
  const clientTerminal = await put(path.join(evidence, "terminal.json"), { endedAt: at(4), nativeCleanup: "not_verified" });
  const planeStage = await put(path.join(evidence, "stage.json"), { schemaVersion: "evleda.native-plane-stage.v2", complete: true,
    nativeSaveCalled: false, mutationDispatched: true, recoveryRequired: false,
    document: { type: "DOCTYPE_PCB", board_filename: "seeded.kicad_pcb", project: { path: root } },
    request: { expectedSavedIdentity: sourceNativePins.pcb, mutation: { netName: "GND", layer: "B.Cu" } },
    sourcePool: [h.input.sources.pcb, staged], rpcPadPool: [], rpc: [], savedSourceBefore: { sourceIndex: 0 },
    savedSourceStaged: { sourceIndex: 0 }, nativeSourceBefore: { sourceIndex: 0 }, nativeSourceStaged: { sourceIndex: 1 } });
  const archivedLivePcb = await put(path.join(evidence, "live.kicad_pcb"), staged);
  const draft = structuredClone(h.draft), route = draft.routingConstraints.nets.find(r => r.net === "VOUT");
  if (!route || !("maxVias" in route)) throw new Error("Missing fixture net"); route.maxVias = 2;
  const targetIntent = await put(path.join(evidence, "intent.json"), { name: "seeded", originalPrompt: "Synthetic recovery and explicit via budget revision", draft });
  const request: SavedPlaneRecoveryRequest = { schemaVersion: "evleda.saved-plane-recovery-request.v1", workspaceRoot: h.f.workspaceRoot,
    sourceProjectId: h.sourceAllocation.projectId, targetProjectId: randomUUID(), profile: h.f.profile, sourceNativePins,
    targetIntent, session, savedPlaneResponse, failedPlaneResponse, failedCloseResponse, clientTerminal, planeStage, archivedLivePcb };
  const openBinding = vi.fn<NonNullable<SavedPlaneRecoveryDependencies["openBinding"]>>(async options => {
    const prepared = await h.f.prepare(options.outputDir, options.fresh.draft as typeof h.draft, {
      originalPrompt: options.fresh.originalPrompt!, placementSeed: options.fresh.placementSeed!, placementRevisionLineage: options.fresh.placementRevisionLineage! });
    const cad = { tools: { tools: [], execute: vi.fn() }, assertCurrent: async () => {}, captureSources: async () => "synthetic",
      prepareCheckpoint: async () => async () => { await prepared.project.checkpointAfterReport(prepared.reportPath, "needs_review"); },
      close: async () => {}, recordRecoveryRequired: async () => {} } as unknown as ConnectedKicadToolbox;
    return { cad, access: "edit", compoundContractIdentity: canonicalIdentity({ synthetic: true }, "test.contract"),
      designContext: () => ({ bundleIdentity: prepared.bundle.identity }) };
  });
  const dependencies: SavedPlaneRecoveryDependencies = { assertQuiescent: async () => {}, openBinding,
    loadProfile: async () => ({ dependencies: h.f.dependencies }) as Awaited<ReturnType<typeof loadKicadToolboxFreshProfile>> };
  return { ...h, request, put, unsafe, dependencies, openBinding, root, output };
}

describe("operator saved-plane recovery into a separate candidate", () => {
  async function fieldFixture() {
    const f = await fixture(), component = f.source.contract.components[0]!, evidence = path.dirname(f.request.session.path);
    const originalField = `(property "Reference" "${component.reference}")`;
    const pcb = f.input.sources.pcb.replace(originalField, `(property "Reference" "${component.reference}" (at 0 -10.025 0) (layer "F.SilkS")
      (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
    expect(pcb).not.toBe(f.input.sources.pcb); f.input.sources.pcb = pcb;
    await writeFile(f.preparation.project.pcbPath, pcb);
    const sourceNativePins = { ...f.request.sourceNativePins, pcb: contentIdentity(pcb) };
    const pose = { schemaVersion: "evleda.fresh-footprint-poses-result.v1", applied: true, placementCount: 1,
      contractIdentity: createFreshConnectivityContract(f.source.contract, f.source.externalPowerBinding, f.source.derivedPowerBinding).identity,
      freshMarkerContentIdentity: contentIdentity(await readFile(f.preparation.project.markerPath)) };
    const response = async (name: string, args: object, data: object, isError: boolean, index: number) => {
      const request = await f.put(path.join(evidence, `field-request-${index}.json`), { id: `field-${index}`, operation: "call", name, arguments: args });
      return f.put(path.join(evidence, `field-response-${index}.json`), { recordedAt: new Date(Date.parse("2026-09-20T00:00:00Z") + index * 1000).toISOString(),
        disposition: "response", isError, request: { path: request.path, identity: request.contentIdentity }, result: { isError, structuredContent: data } });
    };
    const savedPoseResponse = await response("fresh_set_footprint_poses", { placements: [] }, {
      result: { content: JSON.stringify({ ...pose, identity: canonicalIdentity(pose, pose.schemaVersion) }) },
      persistence: { content: JSON.stringify({ status: "saved-and-native-footprint-poses-verified", placementCount: 1, pcbContentIdentity: sourceNativePins.pcb }) } }, false, 1);
    const failedFieldResponse = await response("fresh_set_footprint_fields", { updates: [{ reference: component.reference, field: "Reference", layer: "F.Fab" }] },
      { error: "Visible footprint field anchors must remain within the declared board." }, true, 2);
    const failedCloseResponse = await response("evleda_close_project", { projectId: f.sourceAllocation.projectId },
      { error: "Project lease retained because native finalization/checkpoint requires review." }, true, 3);
    const sourceRecord = (await f.f.store.lookup(f.sourceAllocation.projectId))!;
    const targetIntent = await f.put(path.join(evidence, "same-intent.json"), { name: sourceRecord.name,
      originalPrompt: sourceRecord.originalPrompt, draft: sourceRecord.draft });
    const archivedLivePcb = await f.put(path.join(evidence, "saved-live.kicad_pcb"), pcb);
    const { savedPlaneResponse: _saved, failedPlaneResponse: _failed, planeStage: _stage, ...base } = f.request;
    const request: SavedPlaneRecoveryRequest = { ...base, schemaVersion: "evleda.saved-field-recovery-request.v1", sourceNativePins,
      targetIntent, archivedLivePcb, savedPoseResponse, failedFieldResponse, failedCloseResponse };
    return { ...f, request };
  }

  it("copies a verified saved pose state after a field rejection without changing the engineering bundle", async () => {
    const f = await fieldFixture(), original = await readFile(f.preparation.project.pcbPath), marker = await readFile(f.unsafe.path);
    const cap = await qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies);
    const result = await executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: true });
    const lineage = parsePlacementRevisionLineage(result.lineage);
    expect(lineage.sourceBundleIdentity).toEqual(lineage.targetBundleIdentity);
    expect(lineage.sourcePlanIdentity.schemaVersion).toBe("evleda.plane-saved-copy-source-plan.v1");
    expect(result.custody).toMatchObject({ status: "new-target-normally-closed", sourceNormalCloseClaim: false, originalQuarantineRetained: true });
    expect(await readFile(f.preparation.project.pcbPath)).toEqual(original);
    expect(await readFile(f.unsafe.path)).toEqual(marker);
  });

  it.each(["changed-intent", "live-drift", "saved-hash", "no-rejection", "wrong-close"])("rejects invalid field recovery: %s", async fault => {
    const f = await fieldFixture(), request = structuredClone(f.request);
    if (fault === "live-drift") request.archivedLivePcb = await f.put(request.archivedLivePcb.path, f.input.sources.pcb.replace('(size 1 1)', '(size 2 1)'));
    if (fault === "changed-intent") {
      const intent = JSON.parse(await readFile(request.targetIntent.path, "utf8")); intent.originalPrompt += " changed";
      request.targetIntent = await f.put(request.targetIntent.path, intent);
    }
    if (fault === "saved-hash") {
      const saved = JSON.parse(await readFile(request.savedPoseResponse.path, "utf8"));
      const persistence = JSON.parse(saved.result.structuredContent.persistence.content); persistence.pcbContentIdentity.digest = "f".repeat(64);
      saved.result.structuredContent.persistence.content = JSON.stringify(persistence); request.savedPoseResponse = await f.put(request.savedPoseResponse.path, saved);
    }
    if (fault === "no-rejection") {
      const failed = JSON.parse(await readFile(request.failedFieldResponse.path, "utf8"));
      const command = JSON.parse(await readFile(failed.request.path, "utf8")); command.arguments.updates[0].visible = false;
      const pin = await f.put(failed.request.path, command); failed.request.identity = pin.contentIdentity;
      request.failedFieldResponse = await f.put(request.failedFieldResponse.path, failed);
    }
    if (fault === "wrong-close") {
      const close = JSON.parse(await readFile(request.failedCloseResponse.path, "utf8")); close.isError = false;
      request.failedCloseResponse = await f.put(request.failedCloseResponse.path, close);
    }
    await expect(qualifySavedPlaneRecovery(request, f.f.store, f.dependencies)).rejects.toThrow();
    expect((await f.f.store.list()).total).toBe(1); expect(f.openBinding).not.toHaveBeenCalled();
  });

  it("inspects without allocation or native calls, then preserves original quarantine through new-target closure", async () => {
    const f = await fixture(), before = await readFile(f.preparation.project.pcbPath), checkpoint = await readFile(path.join(f.output, ".evleda-pcb-agent-checkpoint.json")),
      unsafe = await readFile(f.unsafe.path);
    const cap = await qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies);
    expect((await f.f.store.list()).total).toBe(1); expect(f.openBinding).not.toHaveBeenCalled();
    expect(Object.isFrozen(cap.plan)).toBe(true);
    const result = await executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: true });
    expect(result).toMatchObject({ status: "recovered-to-new-allocation", projectId: f.request.targetProjectId,
      lineage: { schemaVersion: "evleda.plane-saved-recovery-lineage.v1", recovery: { sourceNormalCloseConfirmed: false, sourceQuarantineRetained: true } } });
    expect((await f.f.store.list()).total).toBe(2);
    expect(await readFile(f.preparation.project.pcbPath)).toEqual(before);
    expect(await readFile(path.join(f.output, ".evleda-pcb-agent-checkpoint.json"))).toEqual(checkpoint);
    expect(await readFile(f.unsafe.path)).toEqual(unsafe);
    await expect(executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: true })).rejects.toThrow(/consumed/);
  });
  it("rejects forged capabilities and refuses source drift before allocating", async () => {
    const f = await fixture(), cap = await qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies);
    await expect(executeQualifiedSavedPlaneRecovery(structuredClone(cap), { planIdentity: cap.identity.digest, maintenanceConfirmed: true })).rejects.toThrow(/unissued/);
    await expect(executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: false as true })).rejects.toThrow(/unconfirmed/);
    await writeFile(f.preparation.project.pcbPath, f.input.sources.pcb + "\n");
    await expect(executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: true })).rejects.toThrow(/source|bytes|file/iu);
    expect((await f.f.store.list()).total).toBe(1); expect(f.openBinding).not.toHaveBeenCalled();
  });
  it.each(["saved-hash", "wrong-error", "native-saved-stage", "foreign-document", "normal-close", "source-pin", "changed-rule"])
  ("rejects unsupported recovery evidence: %s", async kind => {
    const f = await fixture(), request = structuredClone(f.request);
    const edit = async (key: "savedPlaneResponse" | "failedPlaneResponse" | "failedCloseResponse" | "planeStage" | "targetIntent", change: (value: any) => void) => {
      const value = JSON.parse(await readFile(request[key].path, "utf8")); change(value); request[key] = await f.put(request[key].path, value);
    };
    if (kind === "saved-hash") await edit("savedPlaneResponse", value => { const p = JSON.parse(value.result.structuredContent.persistence.content); p.savedPcbContentIdentity.digest = "f".repeat(64); value.result.structuredContent.persistence.content = JSON.stringify(p); });
    if (kind === "wrong-error") await edit("failedPlaneResponse", value => { const p = JSON.parse(value.result.structuredContent.result.content); p.message = "Unknown source change"; const { identity: _id, ...body } = p; p.identity = canonicalIdentity(body, p.schemaVersion); value.result.structuredContent.result.content = JSON.stringify(p); });
    if (kind === "native-saved-stage") await edit("planeStage", value => { value.nativeSaveCalled = true; });
    if (kind === "foreign-document") await edit("planeStage", value => { value.document.board_filename = "other.kicad_pcb"; });
    if (kind === "normal-close") await edit("failedCloseResponse", value => { value.isError = false; });
    if (kind === "source-pin") request.sourceNativePins.pcb.digest = "f".repeat(64);
    if (kind === "changed-rule") await edit("targetIntent", value => { value.draft.routingConstraints.maximumTurnAngleDeg = 90; });
    await expect(qualifySavedPlaneRecovery(request, f.f.store, f.dependencies)).rejects.toThrow();
    expect((await f.f.store.list()).total).toBe(1); expect(f.openBinding).not.toHaveBeenCalled();
  });
  it("stops when maintenance exclusion cannot be established", async () => {
    const f = await fixture(); await expect(qualifySavedPlaneRecovery(f.request, f.f.store, { ...f.dependencies,
      assertQuiescent: async () => { throw new Error("Native editor remains"); } })).rejects.toThrow(/Native editor/);
    expect((await f.f.store.list()).total).toBe(1);
  });
  it("retains a failed target and the untouched source, and refuses automatic replay", async () => {
    const f = await fixture(), before = await readFile(f.preparation.project.pcbPath);
    f.openBinding.mockRejectedValueOnce(new Error("Synthetic native startup failure"));
    const cap = await qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies);
    await expect(executeQualifiedSavedPlaneRecovery(cap, { planIdentity: cap.identity.digest, maintenanceConfirmed: true }))
      .rejects.toThrow("Synthetic native startup failure");
    expect((await f.f.store.list()).total).toBe(2);
    expect(await readFile(f.preparation.project.pcbPath)).toEqual(before);
    expect(await readFile(path.join(f.request.workspaceRoot, "projects", f.request.targetProjectId, ".toolbox-lease.json"))).not.toHaveLength(0);
    await expect(qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies)).rejects.toThrow(/target already exists/);
  });
  it("requires recovery evidence only on recovery lineage", async () => {
    const f = await fixture(), cap = await qualifySavedPlaneRecovery(f.request, f.f.store, f.dependencies);
    const lineage = structuredClone(cap.plan.lineage) as Record<string, any>;
    lineage.schemaVersion = "evleda.plane-via-budget-revision-lineage.v1";
    const { identity: _id, ...body } = lineage; lineage.identity = canonicalIdentity(body, lineage.schemaVersion);
    expect(() => parsePlacementRevisionLineage(lineage)).toThrow(/Recovery lineage/);
  });
});
