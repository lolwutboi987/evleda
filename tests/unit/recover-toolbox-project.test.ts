import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { applyRecovery, classifyRecoveryProcesses, inspectRecovery, pcbCheckpointRollbackBudget, type RecoveryHooks, type RecoveryRequest, type OutlinedSyncRecoveryRequest, type PcbCheckpointRollbackRequest, type RecoveryPlan } from "../../scripts/recover-toolbox-project.js";
import { closePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const owned = new Set<string>();
const hooks: RecoveryHooks = { assertQuiescent: async () => {}, availableBytes: async () => 1024n * 1024n * 1024n };
const jsonBytes = (value: unknown) => Buffer.from(canonicalJson(value));
const identified = <T extends { schemaVersion: string }>(value: T) => ({ ...value, identity: canonicalIdentity(value, value.schemaVersion) });
afterEach(async () => { for (const root of owned) { expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await rm(root, { recursive: true, force: true }); owned.delete(root); } });

async function fixture(outlined = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), "evleda-offline-recovery-test-")); owned.add(base);
  const evidenceBase = path.join(base, "case"), projectId = randomUUID(), projectRoot = path.join(evidenceBase, "workspace", "projects", projectId);
  const output = path.join(projectRoot, "output"), project = path.join(output, "project"), input = path.join(projectRoot, "input");
  const archiveRoot = path.join(base, "archives"), session = path.join(evidenceBase, "failed-session"), closedSession = path.join(evidenceBase, "closed-session");
  for (const folder of [project, input, archiveRoot, session, closedSession, path.join(project, ".history")]) await mkdir(folder, { recursive: true });
  const put = async (file: string, data: Buffer | string | object) => { const bytes = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data) : jsonBytes(data); await writeFile(file, bytes); const id = contentIdentity(bytes); return { path: file, sha256: id.digest, bytes: id.size }; };
  const prompt = "Synthetic offline recovery test; no CAD process.";
  const draft = outlined ? { ...planeDividerDraft(), boardFeatures: [{ kind: "npth_mounting_hole", reference: "H1", footprintLibId: "MountingHole:Hole_D2.1", value: "Mounting hole",
    pose: { side: "front", xMm: 3, yMm: 3, rotationDeg: 0 }, boreDiameterMm: 2.1, minimumHoleToCopperMm: .5, minimumHoleToEdgeMm: .5 }] }
    : { schemaVersion: "synthetic-test-draft", value: 1 };
  const draftPin = await put(path.join(input, "draft.json"), draft);
  await put(path.join(projectRoot, "allocation.json"), { schemaVersion: "evleda.toolbox-workspace-allocation.v1", projectId, name: "test", originalPrompt: prompt, draftIdentity: { algorithm: "sha256", digest: draftPin.sha256, size: draftPin.bytes } });
  const bundle = identified({ schemaVersion: "evleda.pcb-design-compilation-bundle.v2", originalPromptContentIdentity: contentIdentity(prompt), draft,
    ...(outlined ? { contract: closePcbPlaneDesignIntentDraft(draft) } : {}) });
  const bundlePin = await put(path.join(output, "toolbox-design-bundle.json"), bundle);
  const bundleRef = identified({ schemaVersion: "evleda.pcb-design-compilation-bundle-ref.v2", bundleIdentity: bundle.identity, contentIdentity: { algorithm: "sha256", digest: bundlePin.sha256, size: bundlePin.bytes } });
  const planeBinding = identified({ schemaVersion: "evleda.pcb-agent-plane-fresh-binding.v1", family: "plane-v2", bundleRef });
  const sourcePins = await Promise.all(["fp-lib-table", "test.kicad_dru", "test.kicad_pcb", "test.kicad_pro", "test.kicad_sch", "sym-lib-table"].map(name => put(path.join(project, name),
    outlined && name === "test.kicad_pcb" ? '(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)))\n' : `Original ${name}\n`)));
  const byLeaf = (leaf: string) => sourcePins.find(file => path.basename(file.path) === leaf)!;
  const files = Object.fromEntries(Object.entries({ pro: "test.kicad_pro", sch: "test.kicad_sch", pcb: "test.kicad_pcb", symLibTable: "sym-lib-table", fpLibTable: "fp-lib-table", dru: "test.kicad_dru" }).map(([key, leaf]) => [key, { path: byLeaf(leaf).path, sha256: byLeaf(leaf).sha256 }]));
  const dir = await lstat(project, { bigint: true });
  const markerPin = await put(path.join(output, ".evleda-pcb-agent-fresh.json"), { schemaVersion: "evleda.pcb-agent-fresh-project.v3", workflowKind: "plane", name: "test", outputPath: output, projectPath: project,
    projectIdentity: { canonicalPath: project, dev: String(dir.dev), ino: String(dir.ino) }, files, planeBinding });
  const reportPin = await put(path.join(output, "pcb-agent-report.json"), { status: "needs_review", projectPath: project, workflow: { kind: "plane", bundlePath: bundlePin.path, bundleRef } });
  const checkpointPin = await put(path.join(output, ".evleda-pcb-agent-checkpoint.json"), { schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", reason: "run_exit", projectPath: project,
    baselineMarkerSha256: markerPin.sha256, reportPath: reportPin.path, reportSha256: reportPin.sha256, reportStatus: "needs_review", planeBindingIdentity: planeBinding.identity, files });
  const goodBoard = await readFile(byLeaf("test.kicad_pcb").path), backup = await put(path.join(base, "backup.kicad_pcb"), goodBoard);
  const baseline = [...sourcePins, bundlePin, checkpointPin], start = Date.now() - 60_000, at = (offset: number) => new Date(start + offset).toISOString();
  const normalCloseResponse = await put(path.join(closedSession, "response.json"), { recordedAt: at(0), isError: false, result: { structuredContent: { status: "closed", projectId } } });
  const normalCloseVerification = await put(path.join(base, "normal-close.json"), { recordedAt: at(1000), projectId, checkpointExists: true, remainingLeaseUnsafeLocks: [], nativeBoardMaterialized: false,
    normalWorkspaceCloseResponse: path.relative(evidenceBase, normalCloseResponse.path), files: baseline });
  const failedSession = await put(path.join(session, "session.json"), { startedAt: at(2000), host: path.join(base, "test-build", "dist", "src", "mcp", "toolbox-workspace-main.js"),
    serverArgs: ["--workspace-root", path.join(evidenceBase, "workspace"), "--edit"] });
  const resumeRequest = await put(path.join(session, "resume-request.json"), { name: "evleda_resume_project", arguments: { projectId } });
  const resumeResponse = await put(path.join(session, "resume-response.json"), { recordedAt: at(3000), isError: false,
    request: { path: resumeRequest.path, identity: { digest: resumeRequest.sha256, size: resumeRequest.bytes } }, result: { structuredContent: { status: "opened", resumed: true, projectId, name: "test", projectPath: project, outputPath: output } } });
  const outlineRequest = await put(path.join(session, "outline-request.json"), { id: "outline-once", operation: "call", name: "pcb_set_board_outline", arguments: { width_mm: 22, height_mm: 51 } });
  const failureWire = await put(path.join(session, "failure-wire.json"), { receivedAt: at(65_000), message: { result: { isError: true, structuredContent: { error: "The existing CAD save/readback boundary failed." } } } });
  const failedResponse = await put(path.join(session, "failed-response.json"), ""), failedTerminal = await put(path.join(session, "failed-terminal.json"), "");
  const expectedLease = await put(path.join(projectRoot, ".toolbox-lease.json"), { schemaVersion: "evleda.toolbox-owned-lock.v1", nonce: randomUUID() });
  const expectedBoardLock = await put(path.join(project, "~test.kicad_pcb.lck"), '{"hostname":"test","username":"test"}');
  const expectedProjectLock = await put(path.join(project, "~test.kicad_pro.lck"), '{"hostname":"test","username":"test"}');
  await put(byLeaf("test.kicad_pcb").path, ""); await put(path.join(project, ".history", "test.kicad_pcb"), ""); await put(path.join(project, "test.kicad_prl"), "retained local preferences");
  const failureObservation = await put(path.join(base, "failure.json"), { recordedAt: at(70_000), projectId, hostBuild: "test-build", operation: "pcb_set_board_outline", requestId: "outline-once",
    sessionEvidence: path.relative(path.dirname(evidenceBase), session), clientTerminalObservation: "ENOSPC", nativeEditorsObservedAbsent: true, responseAndTerminalEvidenceFilesEmpty: true,
    mutationsRetried: false, leaseOrLocksRemoved: false, sourceOrCheckpointManuallyRestored: false,
    files: baseline.map(file => ({ ...file, observedBytes: file.path === byLeaf("test.kicad_pcb").path ? 0 : file.bytes,
      observedSha256: file.path === byLeaf("test.kicad_pcb").path ? contentIdentity("").digest : file.sha256, matchesLastNormalClose: file.path !== byLeaf("test.kicad_pcb").path })) });
  const editor = { pid: 1234, createdAt: at(2500), executablePath: path.join(base, "KiCad", "pcbnew.exe"), boardPath: byLeaf("test.kicad_pcb").path };
  const exitReceipt = await put(path.join(base, "editor-exit.json"), { schemaVersion: "evleda.offline-recovery-editor-exit.v1", projectId, editor, observedExited: true, recordedAt: at(80_000),
    normalNativeClose: false, checkpointChangedByOperator: false, leaseOrLocksRemoved: false, sourceRestored: false });
  const processAmendment = await put(path.join(base, "process-amendment.json"), { schemaVersion: "evleda.offline-recovery-process-amendment.v1", projectId,
    originalFailureObservation: failureObservation, correctedAssertion: "nativeEditorsObservedAbsent", originalAssertionWasIncorrect: true, editor, exitReceipt, recordedAt: at(90_000) });
  const request: RecoveryRequest = { schemaVersion: "evleda.offline-zero-pcb-recovery-request.v1", projectRoot, projectId, archiveRoot, backup, normalCloseVerification, normalCloseResponse, processAmendment,
    failureObservation, failedSession, resumeRequest, resumeResponse, outlineRequest, failureWire, failedResponse, failedTerminal, expectedLease, expectedBoardLock, expectedProjectLock };
  return { base, request, put, project, output, goodBoard, sourcePins, markerPin, checkpointPin, reportPin, bundle, planeBinding, baseline, pcb: byLeaf("test.kicad_pcb").path };
}

async function outlinedFixture() {
  const f = await fixture(true), originalRequest = f.request, sessionDir = path.dirname(originalRequest.failedSession.path);
  const leaseBirth = Number((await lstat(originalRequest.expectedLease.path, { bigint: true })).birthtimeNs / 1_000_000n);
  const at = (offset: number) => new Date(leaseBirth + offset).toISOString();
  const session = JSON.parse(await readFile(originalRequest.failedSession.path, "utf8")); session.startedAt = at(-1000);
  const failedSession = await f.put(originalRequest.failedSession.path, session);
  const resume = JSON.parse(await readFile(originalRequest.resumeResponse.path, "utf8")); resume.recordedAt = at(1000);
  const resumeResponse = await f.put(originalRequest.resumeResponse.path, resume);
  const response = async (name: string, requested: { path: string; sha256: string; bytes: number }, isError: boolean, structuredContent: unknown, time: string) => f.put(path.join(sessionDir, name),
    { recordedAt: time, disposition: "response", isError, request: { path: requested.path, identity: { algorithm: "sha256", digest: requested.sha256, size: requested.bytes } }, result: { structuredContent } });
  const outlineRequest = await f.put(originalRequest.outlineRequest.path, { id: "outlined-once", operation: "call", name: "pcb_set_board_outline", arguments: { width_mm: 30, height_mm: 20, origin_x_mm: 0, origin_y_mm: 0 } });
  const outlineResponse = await response("outline-response.json", outlineRequest, false, { operation: "pcb_set_board_outline", noGovernedEffect: false,
    result: { content: JSON.stringify({ result: "Board outline added successfully." }) }, persistence: { content: JSON.stringify({ result: "Board saved." }) } }, at(2000));
  const source = f.goodBoard.toString("utf8").trimEnd().slice(0, -1) + ` (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${randomUUID()}")))\n`;
  await writeFile(f.pcb, source); const outlinedPin = { path: f.pcb, sha256: contentIdentity(source).digest, bytes: Buffer.byteLength(source) };
  const syncRequest = await f.put(path.join(sessionDir, "sync-request.json"), { operation: "call", name: "fresh_sync_from_schematic", arguments: {}, id: "sync-once" });
  const message = "FRESH_SYNC_ROLLED_BACK_TERMINAL: Board features: missing board feature H1 Exact disk and live board preimage restored; close this editing session.";
  const syncResponse = await response("sync-response.json", syncRequest, true, { error: message }, at(3000));
  const closeRequest = await f.put(path.join(sessionDir, "close-request.json"), { operation: "call", name: "evleda_close_project", arguments: { projectId: originalRequest.projectId } });
  const closeResponse = await response("close-response.json", closeRequest, true, { error: "Project lease retained because native finalization/checkpoint requires review." }, at(5000));
  const statusRequest = await f.put(path.join(sessionDir, "status-request.json"), { operation: "call", name: "evleda_workspace_status", arguments: {} });
  const statusResponse = await response("status-response.json", statusRequest, false, { nativeState: "uncertain", activeProject: { projectId: originalRequest.projectId, phase: "needs-review" } }, at(6000));
  const capture = (text: string) => ({ status: "captured", text, contentIdentity: contentIdentity(text) });
  const unavailable = { status: "unavailable", reason: "Synthetic pre-native-sync fixture" };
  const diagnostic = identified({ schemaVersion: "evleda.fresh-sync-failure-diagnostic.v1", phase: "primary-failure", stage: "contract-board-feature-staging", toolCallId: `toolbox:${randomUUID()}`,
    contractIdentity: createFreshConnectivityContract(f.bundle.contract!).identity, projectBindingIdentity: f.planeBinding.identity,
    freshMarkerContentIdentity: { algorithm: "sha256", digest: f.markerPin.sha256, size: f.markerPin.bytes },
    beforePcb: capture(source), savedPcbAtFailure: capture(source), schematicInput: capture(await readFile(path.join(f.project, "test.kicad_sch"), "utf8")),
    primary: capture(JSON.stringify({ name: "Error", message: "Board features: missing board feature H1" })), nativeNetlistBefore: capture("Synthetic pre-sync native netlist"),
    nativeResponseJson: unavailable, nativeNetlistAfter: unavailable, savedPcb: unavailable, livePcb: unavailable });
  await mkdir(path.join(f.output, ".evleda-mcp-output"));
  const syncDiagnostic = await f.put(path.join(f.output, ".evleda-mcp-output", `sync-diagnostic-primary-failure-${randomUUID()}.json`), diagnostic);
  const expectedUnsafeMarker = await f.put(path.join(f.output, ".evleda-pcb-agent-unsafe-terminal.json"), { schemaVersion: "evleda.pcb-agent-unsafe-terminal.v1", projectPath: f.project,
    reportPath: f.reportPin.path, reportSha256: f.reportPin.sha256, reason: "Toolbox checkpoint or owned teardown was not confirmed; explicit recovery is required." });
  await unlink(originalRequest.expectedBoardLock.path); await unlink(originalRequest.expectedProjectLock.path);
  const expectedBoardLock = { path: originalRequest.expectedBoardLock.path, absent: true as const }, expectedProjectLock = { path: originalRequest.expectedProjectLock.path, absent: true as const };
  const failure = { recordedAt: at(7000), projectId: originalRequest.projectId, failedOperation: "fresh_sync_from_schematic", failureStage: "contract-board-feature-staging",
    nativeElectricalSyncCalled: false, noMutationRetried: true, noRecoveryApplied: true, publicResult: message,
    normalCloseResult: "Project lease retained because native finalization/checkpoint requires review.",
    files: f.baseline.map(file => ({ ...(file.path === f.pcb ? outlinedPin : file), lastNormalCloseSha256: file.sha256, matchesLastNormalClose: file.path !== f.pcb })),
    retainedArtifacts: [originalRequest.expectedLease, expectedUnsafeMarker, expectedBoardLock, expectedProjectLock], privateDiagnostic: syncDiagnostic };
  const failureObservation = await f.put(path.join(f.base, "sync-failure.json"), failure);
  const shutdownObservation = await f.put(path.join(f.base, "shutdown.json"), { recordedAt: at(8000), projectId: originalRequest.projectId, ownedHostPid: 1234, ownedHostObservedAbsent: true,
    nativeEditors: [], clientInterruptedAfterFailedNormalClose: true, normalNativeCheckpointClose: false, leaseAndUnsafeMarkerRetained: true, editorLocksObservedAbsentAfterClose: true });
  const request: OutlinedSyncRecoveryRequest = { schemaVersion: "evleda.offline-outlined-pre-sync-recovery-request.v1", projectRoot: originalRequest.projectRoot, projectId: originalRequest.projectId,
    archiveRoot: originalRequest.archiveRoot, backup: originalRequest.backup, normalCloseVerification: originalRequest.normalCloseVerification, normalCloseResponse: originalRequest.normalCloseResponse,
    failureObservation, failedSession, resumeRequest: originalRequest.resumeRequest, resumeResponse, outlineRequest, outlineResponse, syncRequest, syncResponse, syncDiagnostic,
    closeRequest, closeResponse, statusRequest, statusResponse, shutdownObservation, expectedUnsafeMarker, expectedLease: originalRequest.expectedLease, expectedBoardLock, expectedProjectLock };
  return { ...f, request, originalRequest, source, diagnostic, failure };
}

async function checkpointRollbackFixture(kind: "different" | "empty" | "checkpoint" = "different") {
  const f = await outlinedFixture(), source = kind === "empty" ? "" : kind === "checkpoint" ? f.goodBoard.toString() : "Untrusted failed native PCB state; deliberately abandoned.\n";
  const currentPcb = await f.put(f.pcb, source);
  const diagnostic = JSON.parse(await readFile(f.request.syncDiagnostic.path, "utf8"));
  diagnostic.stage = "physical-pad-observation";
  diagnostic.primary = { status: "captured", text: "Unspecified failed native validation; no rollback claim", contentIdentity: contentIdentity("Unspecified failed native validation; no rollback claim") };
  const failedNative = "Separate preserved failed native PCB capture\n";
  for (const role of ["savedPcb", "savedPcbAtFailure", "livePcb"]) diagnostic[role] = { status: "captured", text: failedNative, contentIdentity: contentIdentity(failedNative) };
  diagnostic.nativeResponseJson = { status: "captured", text: '{"nativeSyncRan":true}', contentIdentity: contentIdentity('{"nativeSyncRan":true}') };
  const { identity: _identity, ...body } = diagnostic;
  const syncDiagnostic = await f.put(f.request.syncDiagnostic.path, identified(body as { schemaVersion: string }));
  const observedFailurePcb = await f.put(path.join(f.base, "observed-failure.kicad_pcb"), failedNative);
  const sync = JSON.parse(await readFile(f.request.syncResponse.path, "utf8"));
  sync.result.structuredContent.error = "Failed sync; native rollback status unproven.";
  const syncResponse = await f.put(f.request.syncResponse.path, sync);
  const closed = JSON.parse(await readFile(f.request.closeResponse.path, "utf8"));
  closed.result.structuredContent.error = "Could not publish checkpoint or finish the failed editing session.";
  const closeResponse = await f.put(f.request.closeResponse.path, closed);
  const failure = { recordedAt: f.failure.recordedAt, projectId: f.request.projectId, failedOperation: "fresh_sync_from_schematic", normalCloseFailed: true,
    mutationsRetried: false, recoveryApplied: false, currentPcb,
    files: f.failure.files.map(file => file.path === f.pcb ? { ...file, bytes: currentPcb.bytes, sha256: currentPcb.sha256,
      matchesLastNormalClose: currentPcb.sha256 === file.lastNormalCloseSha256 } : file), retainedArtifacts: f.failure.retainedArtifacts, privateDiagnostic: syncDiagnostic };
  const failureObservation = await f.put(path.join(f.base, "checkpoint-rollback-failure.json"), failure);
  const { outlineRequest: _outlineRequest, outlineResponse: _outlineResponse, ...common } = f.request;
  const request: PcbCheckpointRollbackRequest = { ...common, schemaVersion: "evleda.offline-pcb-checkpoint-rollback-request.v1", currentPcb,
    observedFailurePcb, syncDiagnostic, syncResponse, closeResponse, failureObservation };
  return { ...f, request, source, failure, failedNative };
}

describe("bounded offline zero-PCB recovery", () => {
  it("inspects without writes and restores only the exact PCB while archiving every reviewed orphan", async () => {
    const f = await fixture(), before = await readdir(f.request.archiveRoot), plan = await inspectRecovery(f.request, hooks);
    expect(await readdir(f.request.archiveRoot)).toEqual(before); expect((await readFile(f.pcb)).length).toBe(0);
    expect(plan.files.reduce((n, file) => n + file.bytes, 0)).toBeLessThan(100_000);
    const result = await applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks);
    expect(await readFile(f.pcb)).toEqual(f.goodBoard);
    for (const file of [f.markerPin, f.checkpointPin, f.reportPin, ...f.sourcePins.filter(file => file.path !== f.pcb)]) expect(contentIdentity(await readFile(file.path)).digest).toBe(file.sha256);
    expect((await readFile(path.join(f.project, ".history", "test.kicad_pcb"))).length).toBe(0);
    for (const lock of [f.request.expectedLease, f.request.expectedBoardLock, f.request.expectedProjectLock]) {
      await expect(lstat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
      const index = plan.files.findIndex(file => file.path === lock.path);
      expect(contentIdentity(await readFile(path.join(result.archive, `${String(index).padStart(4, "0")}.bin`))).digest).toBe(lock.sha256);
    }
    expect(JSON.parse(await readFile(path.join(result.archive, "lease-release-intent.json"), "utf8")).state).toContain("not yet observed");
    await expect(applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks)).rejects.toThrow();
  });

  it.each(["checkpoint", "schematic", "backup", "lease", "board-lock", "history", "new-file", "unsafe"])("rejects %s drift before apply without any archive writes", async kind => {
    const f = await fixture(), plan = await inspectRecovery(f.request, hooks);
    const file = kind === "checkpoint" ? f.checkpointPin.path : kind === "schematic" ? path.join(f.project, "test.kicad_sch")
      : kind === "backup" ? f.request.backup.path : kind === "lease" ? f.request.expectedLease.path : kind === "board-lock" ? f.request.expectedBoardLock.path
        : kind === "history" ? path.join(f.project, ".history", "test.kicad_pcb") : kind === "unsafe" ? path.join(f.output, ".evleda-pcb-agent-unsafe-terminal.json") : path.join(f.project, "unexpected.txt");
    await writeFile(file, "changed");
    await expect(applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, hooks)).rejects.toThrow();
    expect(await readdir(f.request.archiveRoot)).toEqual([]); expect((await readFile(f.pcb)).length).toBe(0);
  });

  it("refuses a live/unknown process observation and inadequate computed headroom", async () => {
    const f = await fixture();
    await expect(inspectRecovery(f.request, { assertQuiescent: async () => { throw new Error("live host"); } })).rejects.toThrow("live host");
    const plan = await inspectRecovery(f.request, hooks);
    expect(plan.requiredFreeBytes).toBeGreaterThan(100 * 1024 * 1024);
    await expect(applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, availableBytes: async () => BigInt(plan.requiredFreeBytes - 1) })).rejects.toThrow(/headroom/);
    expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });

  it("requires explicit exact-plan approval and rejects alias paths", async () => {
    const f = await fixture(), plan = await inspectRecovery(f.request, hooks);
    await expect(applyRecovery(plan, { planIdentity: "0".repeat(64), maintenanceConfirmed: true }, hooks)).rejects.toThrow(/reviewed plan/);
    const alias = path.join(f.base, "alias"); await symlink(f.project, alias, "junction");
    await expect(inspectRecovery({ ...f.request, expectedBoardLock: { ...f.request.expectedBoardLock, path: path.join(alias, "~test.kicad_pcb.lck") } }, hooks)).rejects.toThrow(/link|alias/);
  });

  it("requires the preserved process correction and exact editor exit receipt", async () => {
    const f = await fixture(), { processAmendment: _amendment, ...missing } = f.request;
    await expect(inspectRecovery(missing, hooks)).rejects.toThrow();
    const amendment = JSON.parse(await readFile(f.request.processAmendment.path, "utf8"));
    amendment.editor.boardPath = path.join(f.project, "another.kicad_pcb");
    const changed = await f.put(f.request.processAmendment.path, amendment);
    await expect(inspectRecovery({ ...f.request, processAmendment: changed }, hooks)).rejects.toThrow(/correction/);
  });

  it("bounds empty-directory traversal", async () => {
    const f = await fixture(); let folder = f.project;
    for (let index = 0; index < 18; index++) { folder = path.join(folder, `empty-${index}`); await mkdir(folder); }
    await expect(inspectRecovery(f.request, hooks)).rejects.toThrow(/bounded recovery scope/);
  });

  it.each(["normalNativeClose", "checkpointChangedByOperator", "leaseOrLocksRemoved", "sourceRestored"])("rejects a contradictory exit receipt: %s", async field => {
    const f = await fixture(), amendment = JSON.parse(await readFile(f.request.processAmendment.path, "utf8"));
    const receipt = JSON.parse(await readFile(amendment.exitReceipt.path, "utf8")); receipt[field] = true;
    amendment.exitReceipt = await f.put(amendment.exitReceipt.path, receipt);
    const processAmendment = await f.put(f.request.processAmendment.path, amendment);
    await expect(inspectRecovery({ ...f.request, processAmendment }, hooks)).rejects.toThrow(/exit receipt/);
  });

  it("allows only proven disjoint workspace hosts and blocks target, ambiguous, unknown and native processes", async () => {
    const target = path.resolve(os.tmpdir(), "target-workspace"), other = path.resolve(os.tmpdir(), "other-workspace"), script = path.resolve(os.tmpdir(), "toolbox-workspace-main.js");
    const flags = `--profile "${path.resolve(os.tmpdir(), "profile.json")}" --profile-sha256 ${"a".repeat(64)} --profile-bytes 100`;
    const command = (scope: string) => `node "${script}" ${flags} --workspace-root "${scope}" --edit`;
    const rows = [
      { ProcessId: 1, Name: "node.exe", CommandLine: command(other) },
      { ProcessId: 2, Name: "node.exe", CommandLine: command(target) },
      { ProcessId: 3, Name: "node.exe", CommandLine: command(other) + ` --workspace-root "${target}"` },
      { ProcessId: 4, Name: "node.exe", CommandLine: `node "${script}" --profile "${other}"` },
      { ProcessId: 5, Name: "node.exe", CommandLine: null },
      { ProcessId: 6, Name: "pcbnew.exe", CommandLine: `pcbnew "${other}"` },
      { ProcessId: 7, Name: "python.exe", CommandLine: "python kicad_mcp/entry.py" },
      { ProcessId: 8, Name: "node.exe", CommandLine: `node "${script}" --workspace-root "unclosed` },
      { ProcessId: 9, Name: "node.exe", CommandLine: `node "${path.resolve(os.tmpdir(), "wrapper.js")}" "${script}" ${flags} --workspace-root "${other}"` },
      { ProcessId: 10, Name: "node.exe", CommandLine: `node --eval "require('wrapper')" "${script}" ${flags} --workspace-root "${other}"` },
      { ProcessId: 11, Name: "node.exe", CommandLine: `node --require wrapper "${script}" ${flags} --workspace-root "${other}"` },
      { ProcessId: 12, Name: "node.exe", CommandLine: `node "${path.resolve(os.tmpdir(), "toolbox-native-main.js")}" ${flags} --workspace-root "${other}"` },
    ];
    const result = await classifyRecoveryProcesses(rows, 99, target, async value => path.resolve(value));
    expect(result.disjointHosts.map(row => row.ProcessId)).toEqual([1]);
    expect(result.blocking.map(row => row.ProcessId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.quiescent).toBe(false);
    expect((await classifyRecoveryProcesses([rows[0]!], 99, target, async value => path.resolve(value))).quiescent).toBe(true);
    expect((await classifyRecoveryProcesses([rows[0]!], 99, target, async () => { throw new Error("alias"); })).quiescent).toBe(false);
  });

  it.each(["archived", "restored", "before-restore-verified.json", "before-editor-lock-1-release", "before-editor-lock-1-released.json", "before-editor-lock-2-release", "before-lease-release-intent.json", "before-lease-release"])("retains the lease and archive on partial failure at %s", async stop => {
    const f = await fixture(), plan = await inspectRecovery(f.request, hooks);
    await expect(applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, beforeStep: async step => { if (step === stop) throw new Error("simulated ENOSPC or removal failure"); } })).rejects.toThrow(/stopped/);
    expect(contentIdentity(await readFile(f.request.expectedLease.path)).digest).toBe(f.request.expectedLease.sha256);
    expect(contentIdentity(await readFile(f.checkpointPin.path)).digest).toBe(f.checkpointPin.sha256);
    expect((await readdir(f.request.archiveRoot)).length).toBe(1);
    expect(await readFile(f.pcb)).toEqual(stop === "archived" ? Buffer.alloc(0) : f.goodBoard);
    expect((await readFile(path.join(f.project, ".history", "test.kicad_pcb"))).length).toBe(0);
  });

  it.each(["temporary", "archive", "unsafe"])("rejects %s drift after archival before replacing the PCB", async kind => {
    const f = await fixture(), plan = await inspectRecovery(f.request, hooks);
    await expect(applyRecovery(plan, { planIdentity: plan.identity.digest, maintenanceConfirmed: true }, { ...hooks, beforeStep: async step => {
      if (step !== "temporary-ready") return;
      if (kind === "temporary") await writeFile(path.join(f.project, `.test.kicad_pcb.${plan.identity.digest}.recovery.tmp`), "bad");
      else if (kind === "archive") await writeFile(path.join(f.request.archiveRoot, `recovery-${f.request.projectId}-${plan.identity.digest}`, "0000.bin"), "bad");
      else await writeFile(path.join(f.output, ".evleda-pcb-agent-unsafe-terminal.json"), "new unsafe state");
    } })).rejects.toThrow(/stopped/);
    expect((await readFile(f.pcb)).length).toBe(0);
    expect(contentIdentity(await readFile(f.request.expectedLease.path)).digest).toBe(f.request.expectedLease.sha256);
  });

  it.skipIf(process.platform !== "win32")("real read-only process inspection does not match its own PowerShell command", () => {
    const script = fileURLToPath(new URL("../../scripts/recover-toolbox-project.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--check-quiescence"], { encoding: "utf8", windowsHide: true, timeout: 20_000,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.quiescent).toBe(observed.blocking.length === 0);
    expect([...observed.blocking, ...observed.disjointHosts].some((row: { ProcessId: number }) => row.ProcessId === observed.inspectorPid)).toBe(false);
  });
});

describe("separately typed outlined pre-native-sync recovery", () => {
  const approve = (plan: Awaited<ReturnType<typeof inspectRecovery>>) => ({ planIdentity: plan.identity.digest, maintenanceConfirmed: true as const });
  async function reviseDiagnostic(f: Awaited<ReturnType<typeof outlinedFixture>>, change: (value: Record<string, any>) => void) {
    const diagnostic = JSON.parse(await readFile(f.request.syncDiagnostic.path, "utf8")); change(diagnostic);
    const { identity: _identity, ...body } = diagnostic;
    const syncDiagnostic = await f.put(f.request.syncDiagnostic.path, identified(body as { schemaVersion: string }));
    const failure = JSON.parse(await readFile(f.request.failureObservation.path, "utf8")); failure.privateDiagnostic = syncDiagnostic;
    const failureObservation = await f.put(f.request.failureObservation.path, failure);
    return { ...f.request, syncDiagnostic, failureObservation };
  }
  it("archives the saved outline and exact unsafe marker, restores the old checkpoint and retires only marker then lease", async () => {
    const f = await outlinedFixture(), plan = await inspectRecovery(f.request, hooks);
    expect(plan.schemaVersion).toBe("evleda.offline-outlined-pre-sync-recovery-plan.v1");
    expect(plan.absentPaths).toEqual([f.request.expectedBoardLock.path, f.request.expectedProjectLock.path]);
    const steps: string[] = [];
    const result = await applyRecovery(plan, approve(plan), { ...hooks, beforeStep: async step => { steps.push(step); } });
    expect(await readFile(f.pcb)).toEqual(f.goodBoard);
    expect(steps.indexOf("before-unsafe-marker-retirement")).toBeLessThan(steps.indexOf("before-lease-release"));
    for (const pin of [f.request.expectedUnsafeMarker, f.request.expectedLease]) {
      await expect(lstat(pin.path)).rejects.toMatchObject({ code: "ENOENT" });
      const index = plan.files.findIndex(file => file.path === pin.path);
      expect(contentIdentity(await readFile(path.join(result.archive, `${String(index).padStart(4, "0")}.bin`))).digest).toBe(pin.sha256);
    }
    const boardIndex = plan.files.findIndex(file => file.path === f.pcb);
    expect((await readFile(path.join(result.archive, `${String(boardIndex).padStart(4, "0")}.bin`))).toString()).toBe(f.source);
    for (const pin of [f.markerPin, f.checkpointPin, f.reportPin, ...f.sourcePins.filter(pin => pin.path !== f.pcb)]) expect(contentIdentity(await readFile(pin.path)).digest).toBe(pin.sha256);
    expect((await readFile(path.join(f.project, ".history", "test.kicad_pcb"))).length).toBe(0);
    for (const file of plan.absentPaths!) await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(result.archive, "unsafe-marker-retired.json"), "utf8")).state).toContain("no normal close is claimed");
  });
  it.each(["stage", "nativeResponseJson", "nativeNetlistAfter", "preimage", "projectBinding", "schematic"])("rejects contradictory private diagnostic %s even with newly pinned evidence", async field => {
    const f = await outlinedFixture();
    const request = await reviseDiagnostic(f, diagnostic => {
      if (field === "stage") diagnostic.stage = "post-native-sync";
      else if (field === "projectBinding") diagnostic.projectBindingIdentity.digest = "0".repeat(64);
      else if (field === "nativeResponseJson" || field === "nativeNetlistAfter") diagnostic[field] = { status: "captured", text: "native ran", contentIdentity: contentIdentity("native ran") };
      else { const role = field === "schematic" ? "schematicInput" : "beforePcb"; diagnostic[role].text += " "; diagnostic[role].contentIdentity = contentIdentity(diagnostic[role].text); }
    });
    await expect(inspectRecovery(request, hooks)).rejects.toThrow();
    expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });
  it.each(["nativeResponseJson", "nativeNetlistAfter", "savedPcb", "livePcb"])("rejects captured data hidden in unavailable diagnostic slot %s", async role => {
    const f = await outlinedFixture();
    const request = await reviseDiagnostic(f, diagnostic => { diagnostic[role] = { status: "unavailable", reason: "Contradictory fixture",
      text: "native ran", contentIdentity: contentIdentity("native ran") }; });
    await expect(inspectRecovery(request, hooks)).rejects.toThrow(/pre-native-sync rejection/);
  });
  it.each(["outline", "save", "inner-error"])("rejects contradictory %s acknowledgement even when the success text is present", async kind => {
    const f = await outlinedFixture(), returned = JSON.parse(await readFile(f.request.outlineResponse.path, "utf8")), body = returned.result.structuredContent;
    if (kind === "inner-error") body.persistence.isError = true;
    else { const part = kind === "outline" ? body.result : body.persistence; part.content = JSON.stringify({ ...JSON.parse(part.content), error: "native failure" }); }
    const outlineResponse = await f.put(f.request.outlineResponse.path, returned);
    await expect(inspectRecovery({ ...f.request, outlineResponse }, hooks)).rejects.toThrow(/exact positive native save receipt/);
  });
  it.each(["settings", "outline"])("rejects additional %s changes beyond the one authorized rectangle", async kind => {
    const f = await outlinedFixture(), source = kind === "settings" ? f.source.replace('(generator "pcbnew")', '(generator "other")') : f.source.replace("(end 30 20)", "(end 31 20)");
    await writeFile(f.pcb, source);
    const request = await reviseDiagnostic(f, diagnostic => { for (const role of ["beforePcb", "savedPcbAtFailure"]) diagnostic[role] = { status: "captured", text: source, contentIdentity: contentIdentity(source) }; });
    const failure = JSON.parse(await readFile(request.failureObservation.path, "utf8")), row = failure.files.find((file: { path: string }) => file.path === f.pcb);
    row.sha256 = contentIdentity(source).digest; row.bytes = Buffer.byteLength(source);
    const failureObservation = await f.put(request.failureObservation.path, failure);
    await expect(inspectRecovery({ ...request, failureObservation }, hooks)).rejects.toThrow(/exact contract rectangle/);
  });
  it.each(["reason", "reportSha256"])("refuses a different unsafe marker %s rather than generically clearing it", async field => {
    const f = await outlinedFixture(), marker = JSON.parse(await readFile(f.request.expectedUnsafeMarker.path, "utf8"));
    marker[field] = field === "reason" ? "Other recovery required" : "0".repeat(64);
    const expectedUnsafeMarker = await f.put(f.request.expectedUnsafeMarker.path, marker);
    await expect(inspectRecovery({ ...f.request, expectedUnsafeMarker }, hooks)).rejects.toThrow();
  });
  it.each(["foreign-marker", "recreated-lock", "changed-report"])("refuses %s without source or marker retirement", async kind => {
    const f = await outlinedFixture(), plan = await inspectRecovery(f.request, hooks);
    await writeFile(kind === "foreign-marker" ? path.join(f.output, ".other-unsafe.json") : kind === "recreated-lock" ? f.request.expectedBoardLock.path : f.reportPin.path, "changed");
    await expect(applyRecovery(plan, approve(plan), hooks)).rejects.toThrow();
    expect(await readFile(f.pcb, "utf8")).toBe(f.source);
    expect(contentIdentity(await readFile(f.request.expectedUnsafeMarker.path)).digest).toBe(f.request.expectedUnsafeMarker.sha256);
  });
  it.each(["before-unsafe-marker-retirement", "before-lease-release"])("keeps the lease and durable outlined/marker evidence on partial failure at %s", async stop => {
    const f = await outlinedFixture(), plan = await inspectRecovery(f.request, hooks);
    await expect(applyRecovery(plan, approve(plan), { ...hooks, beforeStep: async step => { if (step === stop) throw new Error("simulated retirement failure"); } })).rejects.toThrow(/stopped/);
    expect(await readFile(f.pcb)).toEqual(f.goodBoard);
    expect(contentIdentity(await readFile(f.request.expectedLease.path)).digest).toBe(f.request.expectedLease.sha256);
    if (stop === "before-unsafe-marker-retirement") expect(contentIdentity(await readFile(f.request.expectedUnsafeMarker.path)).digest).toBe(f.request.expectedUnsafeMarker.sha256);
    else await expect(lstat(f.request.expectedUnsafeMarker.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(contentIdentity(await readFile(f.checkpointPin.path)).digest).toBe(f.checkpointPin.sha256);
  });
  it("keeps the old zero-byte mode's unsafe-marker refusal unchanged", async () => {
    const f = await fixture(); await writeFile(path.join(f.output, ".evleda-pcb-agent-unsafe-terminal.json"), "unsupported");
    await expect(inspectRecovery(f.request, hooks)).rejects.toThrow(/unsafe\/recovery marker/);
    expect((await readFile(f.pcb)).length).toBe(0); expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });
});

describe("operator PCB-only rollback to a prior authenticated closed checkpoint", () => {
  const approve = (plan: RecoveryPlan) => ({ planIdentity: plan.identity.digest, maintenanceConfirmed: true as const });
  it.each(["different", "empty", "checkpoint"] as const)("restores exact checkpoint bytes from %s current PCB without native rollback authority", async kind => {
    const f = await checkpointRollbackFixture(kind), plan = await inspectRecovery(f.request, hooks);
    expect(plan.schemaVersion).toBe("evleda.offline-pcb-checkpoint-rollback-plan.v1");
    expect(plan.discardAllCurrentPcbChanges).toBe(true);
    expect(plan.requiredFreeBytes).toBe(150 * 1024 * 1024 + plan.archiveAndTemporaryBytes!);
    expect(plan.archiveAndTemporaryBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    const result = await applyRecovery(plan, approve(plan), hooks);
    expect(await readFile(f.pcb)).toEqual(f.goodBoard);
    for (const pin of [f.markerPin, f.checkpointPin, f.reportPin, ...f.sourcePins.filter(file => file.path !== f.pcb)]) expect(contentIdentity(await readFile(pin.path)).digest).toBe(pin.sha256);
    const currentIndex = plan.files.findIndex(file => file.path === f.pcb), nativeIndex = plan.files.findIndex(file => file.path === f.request.observedFailurePcb!.path);
    expect(await readFile(path.join(result.archive, `${String(currentIndex).padStart(4, "0")}.bin`), "utf8")).toBe(f.source);
    expect(await readFile(path.join(result.archive, `${String(nativeIndex).padStart(4, "0")}.bin`), "utf8")).toBe(f.failedNative);
    expect((await readFile(path.join(f.project, ".history", "test.kicad_pcb"))).length).toBe(0);
    await expect(lstat(f.request.expectedUnsafeMarker.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(f.request.expectedLease.path)).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = JSON.parse(await readFile(path.join(result.archive, "restore-verified.json"), "utf8"));
    expect(receipt.state).toContain("ALL archived current PCB changes discarded");
    expect(receipt.state).toContain("no native rollback or normal close claimed");
  });
  it("does not require a stage-specific error or an independent observed-failure PCB copy", async () => {
    const f = await checkpointRollbackFixture(), diagnostic = JSON.parse(await readFile(f.request.syncDiagnostic.path, "utf8"));
    diagnostic.stage = "another-native-sync-failure-stage";
    diagnostic.beforePcb = { status: "unavailable", reason: "Historical preimage not retained; never restoration authority" };
    const { identity: _identity, ...body } = diagnostic;
    const syncDiagnostic = await f.put(f.request.syncDiagnostic.path, identified(body as { schemaVersion: string }));
    const failureObservation = await f.put(f.request.failureObservation.path, { ...f.failure, privateDiagnostic: syncDiagnostic });
    const { observedFailurePcb: _observed, ...request } = f.request;
    expect((await inspectRecovery({ ...request, syncDiagnostic, failureObservation }, hooks)).discardAllCurrentPcbChanges).toBe(true);
  });
  it.each(["missing", "false"])("requires the explicit discard-all decision even in a re-identified %s plan", async kind => {
    const f = await checkpointRollbackFixture(), original = await inspectRecovery(f.request, hooks);
    const { identity: _identity, discardAllCurrentPcbChanges: _decision, ...body } = original;
    const plan = identified({ ...body, ...(kind === "false" ? { discardAllCurrentPcbChanges: false } : {}) }) as unknown as RecoveryPlan;
    await expect(applyRecovery(plan, approve(plan), hooks)).rejects.toThrow(/explicitly discard ALL/);
    expect(await readFile(f.pcb, "utf8")).toBe(f.source); expect(await readdir(f.request.archiveRoot)).toEqual([]);
  });
  it.each(["schematic", "report", "checkpoint", "currentPCB", "unsafeMarker", "recreatedLock"])("refuses %s drift before abandoning any current PCB bytes", async kind => {
    const f = await checkpointRollbackFixture(), plan = await inspectRecovery(f.request, hooks);
    const file = kind === "schematic" ? path.join(f.project, "test.kicad_sch") : kind === "report" ? f.reportPin.path : kind === "checkpoint" ? f.checkpointPin.path
      : kind === "currentPCB" ? f.pcb : kind === "unsafeMarker" ? f.request.expectedUnsafeMarker.path : f.request.expectedBoardLock.path;
    await writeFile(file, "changed");
    await expect(applyRecovery(plan, approve(plan), hooks)).rejects.toThrow();
    expect(await readdir(f.request.archiveRoot)).toEqual([]);
    expect(contentIdentity(await readFile(f.request.expectedLease.path)).digest).toBe(f.request.expectedLease.sha256);
  });
  it("refuses a foreign unsafe reason and an unrelated optional native capture even when newly pinned", async () => {
    const f = await checkpointRollbackFixture(), observedFailurePcb = await f.put(f.request.observedFailurePcb!.path, "unrelated source");
    await expect(inspectRecovery({ ...f.request, observedFailurePcb }, hooks)).rejects.toThrow(/exact diagnostic capture/);
    const marker = JSON.parse(await readFile(f.request.expectedUnsafeMarker.path, "utf8")); marker.reason = "Unrelated unsafe condition";
    const expectedUnsafeMarker = await f.put(f.request.expectedUnsafeMarker.path, marker);
    await expect(inspectRecovery({ ...f.request, expectedUnsafeMarker, observedFailurePcb: undefined }, hooks)).rejects.toThrow();
  });
  it.each(["before-unsafe-marker-retirement", "before-lease-release"])("keeps lease and exact archive across partial failure at %s", async stop => {
    const f = await checkpointRollbackFixture(), plan = await inspectRecovery(f.request, hooks);
    await expect(applyRecovery(plan, approve(plan), { ...hooks, beforeStep: async step => { if (step === stop) throw new Error("simulated stopped retirement"); } })).rejects.toThrow(/stopped/);
    expect(await readFile(f.pcb)).toEqual(f.goodBoard);
    expect(contentIdentity(await readFile(f.request.expectedLease.path)).digest).toBe(f.request.expectedLease.sha256);
    if (stop === "before-unsafe-marker-retirement") expect(contentIdentity(await readFile(f.request.expectedUnsafeMarker.path)).digest).toBe(f.request.expectedUnsafeMarker.sha256);
    else await expect(lstat(f.request.expectedUnsafeMarker.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(contentIdentity(await readFile(f.checkpointPin.path)).digest).toBe(f.checkpointPin.sha256);
  });
  it("uses the 150 MiB reserve and enforces the 5 MiB work bound without allocating giant test artifacts", () => {
    const boundary = pcbCheckpointRollbackBudget(4 * 1024 * 1024 - 1, 1, 0);
    expect(boundary).toEqual({ archiveAndTemporaryBytes: 5 * 1024 * 1024, requiredFreeBytes: 155 * 1024 * 1024 });
    expect(() => pcbCheckpointRollbackBudget(4 * 1024 * 1024, 1, 0)).toThrow(/5 MiB/);
    expect(() => pcbCheckpointRollbackBudget(Number.NaN, 1, 0)).toThrow(/accounting/);
  });
  it("does not admit post-native evidence through either older mode", async () => {
    const f = await checkpointRollbackFixture();
    await expect(inspectRecovery({ ...f.request, schemaVersion: "evleda.offline-zero-pcb-recovery-request.v1" }, hooks)).rejects.toThrow();
    await expect(inspectRecovery({ ...f.request, schemaVersion: "evleda.offline-outlined-pre-sync-recovery-request.v1" }, hooks)).rejects.toThrow();
  });
});
