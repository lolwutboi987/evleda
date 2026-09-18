import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { applyRecovery, classifyRecoveryProcesses, inspectRecovery, type RecoveryHooks, type RecoveryRequest } from "../../scripts/recover-toolbox-project.js";

const owned = new Set<string>();
const hooks: RecoveryHooks = { assertQuiescent: async () => {}, availableBytes: async () => 1024n * 1024n * 1024n };
const jsonBytes = (value: unknown) => Buffer.from(canonicalJson(value));
const identified = <T extends { schemaVersion: string }>(value: T) => ({ ...value, identity: canonicalIdentity(value, value.schemaVersion) });
afterEach(async () => { for (const root of owned) { expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await rm(root, { recursive: true, force: true }); owned.delete(root); } });

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "evleda-offline-recovery-test-")); owned.add(base);
  const evidenceBase = path.join(base, "case"), projectId = randomUUID(), projectRoot = path.join(evidenceBase, "workspace", "projects", projectId);
  const output = path.join(projectRoot, "output"), project = path.join(output, "project"), input = path.join(projectRoot, "input");
  const archiveRoot = path.join(base, "archives"), session = path.join(evidenceBase, "failed-session"), closedSession = path.join(evidenceBase, "closed-session");
  for (const folder of [project, input, archiveRoot, session, closedSession, path.join(project, ".history")]) await mkdir(folder, { recursive: true });
  const put = async (file: string, data: Buffer | string | object) => { const bytes = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data) : jsonBytes(data); await writeFile(file, bytes); const id = contentIdentity(bytes); return { path: file, sha256: id.digest, bytes: id.size }; };
  const prompt = "Synthetic offline recovery test; no CAD process.";
  const draft = { schemaVersion: "synthetic-test-draft", value: 1 }, draftPin = await put(path.join(input, "draft.json"), draft);
  await put(path.join(projectRoot, "allocation.json"), { schemaVersion: "evleda.toolbox-workspace-allocation.v1", projectId, name: "test", originalPrompt: prompt, draftIdentity: { algorithm: "sha256", digest: draftPin.sha256, size: draftPin.bytes } });
  const bundle = identified({ schemaVersion: "evleda.pcb-design-compilation-bundle.v2", originalPromptContentIdentity: contentIdentity(prompt), draft });
  const bundlePin = await put(path.join(output, "toolbox-design-bundle.json"), bundle);
  const bundleRef = identified({ schemaVersion: "evleda.pcb-design-compilation-bundle-ref.v2", bundleIdentity: bundle.identity, contentIdentity: { algorithm: "sha256", digest: bundlePin.sha256, size: bundlePin.bytes } });
  const planeBinding = identified({ schemaVersion: "evleda.pcb-agent-plane-fresh-binding.v1", family: "plane-v2", bundleRef });
  const sourcePins = await Promise.all(["fp-lib-table", "test.kicad_dru", "test.kicad_pcb", "test.kicad_pro", "test.kicad_sch", "sym-lib-table"].map(name => put(path.join(project, name), `Original ${name}\n`)));
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
  return { base, request, put, project, output, goodBoard, sourcePins, markerPin, checkpointPin, reportPin, pcb: byLeaf("test.kicad_pcb").path };
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
