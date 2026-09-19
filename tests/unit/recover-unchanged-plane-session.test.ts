import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, link } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { inspectUnchangedPlaneRecovery, applyUnchangedPlaneRecovery, type UnchangedPlaneRecoveryRequest } from "../../scripts/recover-unchanged-plane-session.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
import { compactPlaneStageFixture } from "../helpers/compact-plane-stage-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { expect(path.isAbsolute(root)).toBe(true); expect(path.basename(root).startsWith("evleda-plane-recovery-test-")).toBe(true); expect(await realpath(root)).toBe(root); await rm(root, { recursive: true, force: true }); } });
const hooks = { assertQuiescent: async () => {}, availableBytes: async () => 1024n * 1024n * 1024n };
const source = withNativePadFixtureIds(`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:X" (layer "F.Cu") (at 2 2) (property "Reference" "J1") (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))))\n`);
async function fixture() {
  const task = await mkdtemp(path.join(tmpdir(), "evleda-plane-recovery-test-")); roots.push(task);
  const id = randomUUID(), workspace = path.join(task, "workspace"), root = path.join(workspace, "projects", id), output = path.join(root, "output"), project = path.join(output, "project"), evidence = path.join(task, "session"), archiveRoot = path.join(task, "archives");
  for (const dir of [project, path.join(root, "input"), path.join(output, ".evleda-mcp-output"), evidence, archiveRoot]) await mkdir(dir, { recursive: true });
  const put = async (file: string, value: unknown) => { const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n"); await writeFile(file, bytes); const h = contentIdentity(bytes); return { path: file, sha256: h.digest, bytes: h.size }; };
  const files: Record<string, { path: string; sha256: string }> = {};
  for (const [key, name] of Object.entries({ pro: "plane.kicad_pro", pcb: "plane.kicad_pcb", sch: "plane.kicad_sch", dru: "plane.kicad_dru", symLibTable: "sym-lib-table", fpLibTable: "fp-lib-table" })) {
    const p = await put(path.join(project, name), key === "pcb" ? source : `synthetic ${key}\n`); files[key] = { path: p.path, sha256: p.sha256 };
  }
  await put(path.join(root, "allocation.json"), { projectId: id, name: "plane" });
  const binding = canonicalIdentity({ fixture: true }, "evleda.synthetic-plane-binding.v1");
  const marker = await put(path.join(output, ".evleda-pcb-agent-fresh.json"), { schemaVersion: "evleda.pcb-agent-fresh-project.v3", workflowKind: "plane", projectPath: project, outputPath: output, planeBinding: { identity: binding } });
  const checkpoint = await put(path.join(output, ".evleda-pcb-agent-checkpoint.json"), { schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", reason: "run_exit", projectPath: project, baselineMarkerSha256: marker.sha256, planeBindingIdentity: binding, files });
  const closed = await put(path.join(evidence, "prior-close.json"), { recordedAt: "2026-09-19T00:00:00Z", result: { structuredContent: { status: "closed", projectId: id } } });
  const closeProof = await put(path.join(evidence, "prior-close-proof.json"), { projectId: id, normalCloseConfirmed: true, checkpoint: { path: checkpoint.path, sha256: checkpoint.sha256 }, closeResponse: { path: closed.path, sha256: closed.sha256 }, files });
  const failedSession = await put(path.join(evidence, "session.json"), { startedAt: "2026-09-19T00:01:00Z", serverArgs: ["--workspace-root", workspace, "--edit"] });
  async function response(name: string, args: unknown, value: unknown, time: string, basename: string) {
    const request = await put(path.join(evidence, basename + "-request.jsonl"), { id: basename, operation: "call", name, arguments: args });
    return put(path.join(evidence, basename + "-response.json"), { recordedAt: time, disposition: "response", request: { path: request.path, identity: { algorithm: "sha256", digest: request.sha256, size: request.bytes } }, result: value });
  }
  const resumed = await response("evleda_resume_project", { projectId: id }, { structuredContent: { status: "opened", resumed: true, projectId: id } }, "2026-09-19T00:02:00Z", "resume");
  const failure = { schemaVersion: "evleda.fresh-plane-apply-failure.v1", stage: "stage-validation", code: "PLANE_APPLY_TERMINAL", recoveryRequired: true, editingSessionMustClose: true, rollback: "not-attempted-unknown-or-external-state", acceptedStagedPcbContentIdentity: null, message: "Portable value string budget exceeded", beforePcbContentIdentity: contentIdentity(source) };
  const failed = await response("fresh_apply_contract_plane", { planeId: "GND_PLANE" }, { isError: true, structuredContent: { recoveryRequired: true, result: { content: JSON.stringify(failure) } } }, "2026-09-19T00:03:00Z", "plane");
  const closeFailed = await response("evleda_close_project", { projectId: id }, { isError: true, structuredContent: { error: "Native toolbox cleanup was not confirmed; owned state was retained." } }, "2026-09-19T00:04:00Z", "close");
  const native = await planeStageObservationFixture({ beforePcbSource: source, boardPath: files.pcb!.path, mutation: { operation: "create", netName: "GND", layer: "B.Cu", rectangleNm: { x1: 500000, y1: 500000, x2: 29500000, y2: 19500000 }, clearanceNm: 250000, minWidthNm: 500000, priority: 0, name: "fixture-plane", connection: "full", islandPolicy: "always" } });
  const stageArtifact = await put(path.join(output, ".evleda-mcp-output", `evleda-plane-stage-${randomUUID()}.json`), compactPlaneStageFixture(native.receipt));
  const report = await put(path.join(output, "pcb-agent-report.json"), { syntheticFailure: true });
  const unsafe = await put(path.join(output, ".evleda-pcb-agent-unsafe-terminal.json"), { schemaVersion: "evleda.pcb-agent-unsafe-terminal.v1", projectPath: project, reportPath: report.path, reportSha256: report.sha256 });
  const lease = await put(path.join(root, ".toolbox-lease.json"), { schemaVersion: "evleda.toolbox-owned-lock.v1", nonce: "synthetic-unit-test-nonce" });
  const request: UnchangedPlaneRecoveryRequest = { schemaVersion: "evleda.unchanged-plane-session-recovery-request.v1", projectRoot: root, projectId: id, archiveRoot, checkpoint, normalCloseProof: closeProof, normalCloseResponse: closed, failedSession, resumeResponse: resumed, planeResponse: failed, closeResponse: closeFailed, stageArtifact, expectedLease: lease, expectedUnsafeMarker: unsafe };
  return { request, files, task, project, output, put, failure };
}

describe("unchanged plane-stage session recovery", () => {
  it("inspects without writes, then archives and retires only the exact quarantine artifacts", async () => {
    const f = await fixture(), before = await Promise.all(Object.values(f.files).map(p => readFile(p.path))), checkpoint = await readFile(f.request.checkpoint.path), lease = await readFile(f.request.expectedLease.path), unsafe = await readFile(f.request.expectedUnsafeMarker.path);
    const plan = await inspectUnchangedPlaneRecovery(f.request, hooks);
    expect(await readdir(f.request.archiveRoot)).toEqual([]); expect(plan.sourceFilesRewritten).toBe(false); expect(plan.checkpointRewritten).toBe(false);
    const result = await applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks);
    expect(result).toMatchObject({ status: "unchanged-checkpoint-released", normalCloseClaim: false, designAccepted: false });
    expect(await Promise.all(Object.values(f.files).map(p => readFile(p.path)))).toEqual(before); expect(await readFile(f.request.checkpoint.path)).toEqual(checkpoint);
    await expect(readFile(f.request.expectedLease.path)).rejects.toThrow(); await expect(readFile(f.request.expectedUnsafeMarker.path)).rejects.toThrow();
    expect(await readFile(path.join(result.archive, "original-lease.json"))).toEqual(lease); expect(await readFile(path.join(result.archive, "original-unsafe-terminal.json"))).toEqual(unsafe);
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks)).rejects.toThrow();
  });
  it.each(["PCB", "schematic", "checkpoint", "native-save", "other-failure", "prior-close", "foreign-lock", "hardlink"])("rejects %s changes without archival or retirement", async kind => {
    const f = await fixture();
    if (kind === "PCB") await writeFile(f.files.pcb!.path, source + " ");
    if (kind === "schematic") await writeFile(f.files.sch!.path, "changed");
    if (kind === "checkpoint") await writeFile(f.request.checkpoint.path, "{}");
    if (kind === "native-save") { const value = JSON.parse(await readFile(f.request.stageArtifact.path, "utf8")); value.nativeSaveCalled = true; f.request.stageArtifact = await f.put(f.request.stageArtifact.path, value); }
    if (kind === "other-failure") { const value = JSON.parse(await readFile(f.request.planeResponse.path, "utf8")); value.result.structuredContent.result.content = JSON.stringify({ ...f.failure, message: "some other failure" }); f.request.planeResponse = await f.put(f.request.planeResponse.path, value); }
    if (kind === "prior-close") { const value = JSON.parse(await readFile(f.request.normalCloseProof.path, "utf8")); value.normalCloseConfirmed = false; f.request.normalCloseProof = await f.put(f.request.normalCloseProof.path, value); }
    if (kind === "foreign-lock") await writeFile(path.join(f.project, "other.lck"), "lock");
    if (kind === "hardlink") await link(f.files.sch!.path, path.join(f.task, "linked-source"));
    await expect(inspectUnchangedPlaneRecovery(f.request, hooks)).rejects.toThrow();
    expect(await readdir(f.request.archiveRoot)).toEqual([]); expect(await readFile(f.request.expectedLease.path)).not.toHaveLength(0); expect(await readFile(f.request.expectedUnsafeMarker.path)).not.toHaveLength(0);
  });
  it("rejects a stale inspected plan and missing maintenance confirmation", async () => {
    const f = await fixture(), plan = await inspectUnchangedPlaneRecovery(f.request, hooks);
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: false as true }, hooks)).rejects.toThrow("maintenance");
    await writeFile(f.files.pcb!.path, source + " ");
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks)).rejects.toThrow(); expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });
  it("retains both artifacts if the source changes during archive publication", async () => {
    const f = await fixture(), plan = await inspectUnchangedPlaneRecovery(f.request, hooks);
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, beforeStep: async step => { if (step === "archived") await writeFile(f.files.pcb!.path, source + " "); } })).rejects.toThrow("stopped at archive");
    expect(await readFile(f.request.expectedLease.path)).not.toHaveLength(0); expect(await readFile(f.request.expectedUnsafeMarker.path)).not.toHaveLength(0); expect(await readdir(f.request.archiveRoot)).toHaveLength(1);
  });
  it("retains the lease when a new quarantine file appears after unsafe retirement", async () => {
    const f = await fixture(), plan = await inspectUnchangedPlaneRecovery(f.request, hooks);
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, beforeStep: async step => { if (step === "retire-lease") await writeFile(path.join(f.output, "new-unsafe.json"), "new"); } })).rejects.toThrow("stopped at retire-lease");
    expect(await readFile(f.request.expectedLease.path)).not.toHaveLength(0); await expect(readFile(f.request.expectedUnsafeMarker.path)).rejects.toThrow();
    const [archive] = await readdir(f.request.archiveRoot); expect(await readFile(path.join(f.request.archiveRoot, archive!, "original-unsafe-terminal.json"))).not.toHaveLength(0);
  });
  it("requires process quiescence and sufficient archive space", async () => {
    const f = await fixture(); await expect(inspectUnchangedPlaneRecovery(f.request, { assertQuiescent: async () => { throw new Error("live host"); } })).rejects.toThrow("live host");
    const plan = await inspectUnchangedPlaneRecovery(f.request, hooks);
    await expect(applyUnchangedPlaneRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, availableBytes: async () => 0n })).rejects.toThrow("reserve"); expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });
});
