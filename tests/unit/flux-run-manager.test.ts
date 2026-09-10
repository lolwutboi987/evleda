import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, sha256 } from "../../src/core/canonical.js";
import { createFluxOpenCheckpointReceipt, createFluxOpenPreflightReceipt, FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, fluxDigest, fluxOpenPreparationDigest, FluxError, FluxRunManager, FluxRunStore, parseFluxOpenPreflightReceipt, projectFluxRunDto, type FluxContractStateDto, type FluxExecutionPorts, type FluxFreshAcceptanceProjection, type FluxRunManagerOptions } from "../../src/flux/index.js";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);
const KICAD_TOOLCHAIN_IDENTITY = canonicalIdentity({ suite: "10.0.3", installation: "test" }, "evleda.test-kicad-toolchain.v1");
const INSPECTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-readonly" }, "evleda.kicad-mcp-inspection-bridge.v2");
const EXECUTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-write" }, "evleda.kicad-mcp-execution-bridge.v1");
const IPC_SOCKET_IDENTITY = canonicalIdentity({ socket: "run-bound" }, "evleda.kicad-api-socket-binding.v1");
const WRITE_SESSION_AUTHORITY_IDENTITY = canonicalIdentity({ mode: "write" }, "evleda.kicad-mcp-session-authority.v1");
const WRITE_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "write" }, "evleda.kicad-mcp-session-receipt.v1");
const IPC_PROBE_SEMANTIC_IDENTITY = canonicalIdentity({ result: "same" }, "evleda.flux-open-ipc-probe-semantic.v2");
const CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "checkpoint-read" }, "evleda.kicad-mcp-session-receipt.v1");
const EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "execution-read" }, "evleda.kicad-mcp-session-receipt.v1");
const acceptanceReport = (sourceHashes: FluxFreshAcceptanceProjection["sourceHashes"]) => ({
  title: "Candidate acceptance", digest: digest("d"), mediaType: "application/json", disposition: "blocked" as const,
  executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY,
  writeSessionReceiptIdentity: WRITE_SESSION_RECEIPT_IDENTITY, executionInspectionSessionReceiptIdentity: EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY,
  freshAcceptance: {
    passed: false,
    requirements: [{ id: "schematic", status: "pass" as const, detail: "Source parsed." }, { id: "native-validation", status: "unknown" as const, detail: "Source-bound validation was not run." }],
    missing: ["native-validation [unknown]: Source-bound validation was not run."], sourceHashes,
    evidenceLimitations: ["The netlist digest identifies the supplied input; it does not establish native validation."],
  },
});
const openPreflight = ({ projectId, runId, preparation }: Parameters<NonNullable<FluxExecutionPorts["preflightOpen"]>>[0]) => createFluxOpenPreflightReceipt({
  schemaVersion: "evleda.flux-open-preflight.v5", projectId, runId: runId!, preparationDigest: fluxOpenPreparationDigest(preparation!), suiteVersion: "10.0.3",
  installationRootIdentity: canonicalIdentity({ installation: "test" }, "evleda.test-kicad-installation-root.v1"),
  inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY,
  freshNetClassSemanticAuthorityIdentity: null,
  freshProjectOpenPreparedSourceAuthorityIdentity: null, freshNetClassPreparationEvidenceIdentity: null,
  kicadCli: { algorithm: "sha256", digest: digest("e"), size: 1 }, pcbnew: { algorithm: "sha256", digest: digest("f"), size: 1 }, board: { algorithm: "sha256", digest: digest("9"), size: 1 },
});
const openCheckpoint = (request: Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[0], isolatedFingerprint = digest("b")) => ({
  isolatedFingerprint, checkpointRequired: false, preview: { title: "Checkpoint", summary: "Verified", artifactCount: 1, digest: digest("c") },
  openCheckpointReceipt: createFluxOpenCheckpointReceipt({ schemaVersion: "evleda.flux-open-checkpoint.v6", runId: request.runId, openPreflightReceiptIdentity: request.openPreflightReceipt.identity,
    kicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY,
    writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, isolatedFingerprint, board: { algorithm: "sha256" as const, digest: digest("1"), size: 1 }, editorLock: { algorithm: "sha256" as const, digest: digest("2"), size: 1 },
    ipcProbeSemanticIdentity: IPC_PROBE_SEMANTIC_IDENTITY, checkpointInspectionSessionReceiptIdentity: CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY,
    freshNetClassSemanticAuthorityIdentity: null, freshProjectOpenPreparedSourceAuthorityIdentity: null, freshNetClassPreparationEvidenceIdentity: null }),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixture = async (ports?: Partial<FluxExecutionPorts>, managerOptions: Partial<Pick<FluxRunManagerOptions, "lifecycleObserver" | "contractInterpreter" | "compilationBundleStore">> = {}) => {
  const base = await mkdtemp(path.join(tmpdir(), "evleda-flux-")); roots.push(base);
  const sourceRoot = path.join(base, "source"); const workspaceRoot = path.join(base, "workspace");
  await mkdir(sourceRoot);
  const defaultPorts: FluxExecutionPorts = {
    prepare: async () => ({ isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Preview", summary: "Safe preview", artifactCount: 1, digest: digest("c") } }),
    execute: async () => ({ disposition: "completed", reports: [{ title: "Report", digest: digest("d"), mediaType: "text/plain", executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, writeSessionReceiptIdentity: WRITE_SESSION_RECEIPT_IDENTITY, executionInspectionSessionReceiptIdentity: EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY }] }),
    preflightOpen: async (request) => openPreflight(request),
    cancelOpenPreflight: async () => undefined,
    open: async () => ({ opened: true, label: "Opened in host", checkpointRequired: true }),
    checkpointOpen: async (request) => openCheckpoint(request),
  };
  const manager = new FluxRunManager({ workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "reference", label: "Reference controller", sourceRoot, fingerprint: digest("a") }], ports: { ...defaultPorts, ...ports }, ...managerOptions });
  await manager.initialize();
  const project = await manager.createProject("reference", "Controller");
  const thread = await manager.createThread(project.id, "Main");
  const makeRun = () => manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Make a safe revision", providerModel: { provider: "openai", model: "test", tier: "local" }, iterationCap: 3, harnessRuleIdentity: "harness-v1", mutationAllowlist: ["board.kicad_pcb"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "led_compatibility_fixture" });
  return { manager, makeRun, project, thread, sourceRoot, workspaceRoot };
};

const identity = (schemaVersion: string, seed: string) => ({ algorithm: "sha256" as const, digest: fluxDigest(seed), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const compilation = (prompt: string, answers: readonly { id: string; answer: string }[]): FluxContractStateDto => answers.length === 0 ? {
  disposition: "needs_clarification", questions: [{ id: "/scope/board/widthMm", path: "/scope/board/widthMm", question: "What width?" }], issues: [{ code: "UNRESOLVED_FIELD", severity: "error", path: "/scope/board/widthMm", message: "Width missing", clarificationId: "/scope/board/widthMm" }], contract: null, contractIdentity: null, libraryBindingIdentity: null, deepRuleBindingIdentity: null, acceptancePlanIdentity: null,
  interpreterReceipt: { schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "test-v1", provider: "fake", promptDigest: fluxDigest(prompt), clarificationDigest: fluxDigest(answers), compiledAt: "2026-01-01T00:00:00.000Z" },
} : {
  disposition: "ready", questions: [], issues: [], contract: { schemaVersion: "evleda.pcb-design-contract.v1", kind: "pcb_design_contract", answer: answers[0]!.answer }, contractIdentity: identity("evleda.pcb-design-contract.v1", answers[0]!.answer), libraryBindingIdentity: identity("evleda.pcb-library-binding.v1", answers[0]!.answer), deepRuleBindingIdentity: identity("evleda.pcb-deep-rule-binding.v1", answers[0]!.answer), acceptancePlanIdentity: identity("evleda.pcb-acceptance-plan.v1", answers[0]!.answer),
  interpreterReceipt: { schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "test-v1", provider: "fake", promptDigest: fluxDigest(prompt), clarificationDigest: fluxDigest(answers), compiledAt: "2026-01-01T00:00:01.000Z" },
};

describe("FluxRunManager", () => {
  it("accepts only bounded canonical KiCad 10.x suite versions in Open preflight receipts", () => {
    const base = openPreflight({ projectId: "project_1", runId: "run_1", preparation: { benign: true } as never });
    const { identity: _identity, ...payload } = base;
    const next = createFluxOpenPreflightReceipt({ ...payload, suiteVersion: "10.0.4" });
    expect(parseFluxOpenPreflightReceipt(next).suiteVersion).toBe("10.0.4");
    for (const suiteVersion of ["9.0.4", "10", "10.0", "10.0.x", "10.0.4-beta", `10.${"1".repeat(300)}.0`]) {
      expect(() => createFluxOpenPreflightReceipt({ ...payload, suiteVersion })).toThrow();
    }
  });

  it("enforces the prepare, approve, resume state machine and hides local paths", async () => {
    const { manager, makeRun, project, sourceRoot } = await fixture();
    const run = await makeRun();
    await expect(manager.resumeRun(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" } satisfies Partial<FluxError>);
    const prepared = await manager.prepareRun(run.id);
    await expect(manager.open(project.id, run.id)).resolves.toEqual({ opened: true, label: "Opened in host", checkpointRequired: true });
    expect(prepared.phase).toBe("awaiting_open"); await manager.checkpointOpenRun(run.id);
    const subject = await manager.approvalSubject(run.id);
    await expect(manager.approveRun(run.id, digest("0"))).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" } satisfies Partial<FluxError>);
    const approved = await manager.approveRun(run.id, subject.digest);
    expect(approved.approval?.subjectDigest).toBe(subject.digest);
    const repeated = await manager.approveRun(run.id, subject.digest);
    expect(repeated.approval?.id).toBe(approved.approval?.id);
    const queued = await manager.resumeRun(run.id);
    expect(queued.phase).toBe("queued");
    await manager.waitForIdle();
    const completed = await manager.getRun(run.id);
    expect(completed.blockedReason).toBeUndefined(); expect(completed).toMatchObject({ phase: "completed" });
    expect(completed.approval?.consumedAt).toBeTruthy();
    await expect(manager.approveRun(run.id, subject.digest)).rejects.toMatchObject({ code: "APPROVAL_CONSUMED" } satisfies Partial<FluxError>);
    await expect(manager.resumeRun(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" } satisfies Partial<FluxError>);
    const browserJson = JSON.stringify({ sources: await manager.sources(), project, run: completed, events: await manager.events() });
    expect(browserJson).not.toContain(sourceRoot);
    expect(browserJson).not.toMatch(/[A-Za-z]:\\/u);
  });

  it.each([
    { name: "legacy two-hash", sourceHashes: { schematicSha256: digest("a"), pcbSha256: digest("b") } },
    { name: "generic three-hash", sourceHashes: { schematicSha256: digest("a"), pcbSha256: digest("b"), netlistSha256: digest("c") } },
    { name: "generic empty-netlist", sourceHashes: { schematicSha256: digest("a"), pcbSha256: digest("b"), netlistSha256: sha256("") } },
  ])("preserves a blocked $name acceptance report through publication and reload", async ({ sourceHashes }) => {
    const report = acceptanceReport(sourceHashes);
    const { manager, makeRun, project, workspaceRoot } = await fixture({ execute: async () => ({ disposition: "blocked", reports: [report] }) });
    const run = await makeRun();
    await manager.prepareRun(run.id); await manager.open(project.id, run.id); await manager.checkpointOpenRun(run.id);
    const subject = await manager.approvalSubject(run.id); await manager.approveRun(run.id, subject.digest);
    await manager.resumeRun(run.id); await manager.waitForIdle();
    const published = await manager.getRun(run.id);
    expect(published.phase).toBe("blocked");
    expect(published.reports).toHaveLength(1);
    expect(published.reports[0]!.freshAcceptance).toStrictEqual(report.freshAcceptance);
    expect(canonicalJson(projectFluxRunDto(published))).toBe(canonicalJson(published));
    const persisted = await new FluxRunStore(workspaceRoot).read();
    expect(persisted.runs[run.id]!.reports[0]).toStrictEqual(published.reports[0]);
    expect(persisted.reports[published.reports[0]!.reportId]!.freshAcceptance).toStrictEqual(report.freshAcceptance);
    expect(canonicalJson(projectFluxRunDto(await manager.getRun(run.id)).reports)).toBe(canonicalJson(published.reports));
  });

  it.each([
    { name: "an unknown hash key", sourceHashes: { schematicSha256: digest("a"), pcbSha256: digest("b"), extraSha256: digest("c") } },
    { name: "a missing schematic hash", sourceHashes: { pcbSha256: digest("b"), netlistSha256: digest("c") } },
    { name: "a missing PCB hash", sourceHashes: { schematicSha256: digest("a"), netlistSha256: digest("c") } },
    ...[null, undefined, "", "c".repeat(63), "C".repeat(64), "z".repeat(64), 123, [digest("c")]].map((netlistSha256) => ({
      name: `an invalid netlist hash ${JSON.stringify(netlistSha256)}`,
      sourceHashes: { schematicSha256: digest("a"), pcbSha256: digest("b"), netlistSha256 },
    })),
  ])("rejects $name at both execution and public projection boundaries", async ({ sourceHashes }) => {
    const report = acceptanceReport(sourceHashes as FluxFreshAcceptanceProjection["sourceHashes"]);
    const { manager, makeRun, project } = await fixture({ execute: async () => ({ disposition: "blocked", reports: [report] }) });
    const run = await makeRun();
    expect(() => projectFluxRunDto({ ...run, reports: [{ ...report, reportId: "report_invalid", createdAt: run.createdAt }] })).toThrow();
    await manager.prepareRun(run.id); await manager.open(project.id, run.id); await manager.checkpointOpenRun(run.id);
    const subject = await manager.approvalSubject(run.id); await manager.approveRun(run.id, subject.digest);
    await manager.resumeRun(run.id); await manager.waitForIdle();
    const rejected = await manager.getRun(run.id);
    expect(rejected.phase).toBe("failed");
    expect(rejected.reports).toHaveLength(0);
  });

  it("requires Open then provider-free checkpoint-open before fresh approval", async () => {
    const { manager, makeRun, project } = await fixture({
      prepare: async () => ({ isolatedFingerprint: digest("b"), checkpointRequired: true, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Fresh", summary: "Prepared", artifactCount: 3, digest: digest("c") } }),
      open: async () => ({ opened: true, label: "Opened fresh", checkpointRequired: true }),
      checkpointOpen: async (request) => ({ isolatedFingerprint: digest("e"), checkpointRequired: false, preview: { title: "Fresh", summary: "Checkpointed", artifactCount: 3, digest: digest("f") },
        openCheckpointReceipt: createFluxOpenCheckpointReceipt({ schemaVersion: "evleda.flux-open-checkpoint.v6", runId: request.runId, openPreflightReceiptIdentity: request.openPreflightReceipt.identity,
          kicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY,
          writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, isolatedFingerprint: digest("e"), board: { algorithm: "sha256", digest: digest("1"), size: 1 }, editorLock: { algorithm: "sha256", digest: digest("2"), size: 1 },
          ipcProbeSemanticIdentity: IPC_PROBE_SEMANTIC_IDENTITY, checkpointInspectionSessionReceiptIdentity: CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY,
          freshNetClassSemanticAuthorityIdentity: null, freshProjectOpenPreparedSourceAuthorityIdentity: null, freshNetClassPreparationEvidenceIdentity: null }) }),
    });
    const run = await makeRun(); expect((await manager.prepareRun(run.id)).phase).toBe("awaiting_open");
    await expect(manager.approvalSubject(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(manager.checkpointOpenRun(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await manager.open(project.id, run.id); expect((await manager.getRun(run.id)).phase).toBe("awaiting_checkpoint");
    await expect(manager.approvalSubject(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    const checkpointed = await manager.checkpointOpenRun(run.id); expect(checkpointed.phase).toBe("awaiting_approval"); expect(checkpointed.checkpointRequired).toBe(false);
    const subject = await manager.approvalSubject(run.id); expect(subject.subject.isolatedFingerprint).toBe(digest("e")); expect(subject.subject).toMatchObject({ freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" });
  });

  it("rejects the legacy public-projection-only interpreter port", async () => {
    const legacy = { interpret: async ({ prompt, clarificationAnswers }: { prompt: string; clarificationAnswers: readonly { id: string; answer: string }[] }) => compilation(prompt, clarificationAnswers) };
    const { manager, project, thread } = await fixture(undefined, { contractInterpreter: legacy as never, compilationBundleStore: { put: async () => { throw new Error("must not store"); }, get: async () => { throw new Error("must not read"); } } });
    const run = await manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: { provider: "codex", model: "test", tier: "priority" }, iterationCap: 2, harnessRuleIdentity: "rules", mutationAllowlist: ["pcb_add_track"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "generic" });
    await expect(manager.interpretRun(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect((await manager.getRun(run.id)).phase).toBe("draft");
  });

  it("returns a stable result for an idempotency key and rejects changed reuse", async () => {
    const { manager, project } = await fixture();
    const one = await manager.createThread(project.id, "Idempotent", "thread-key");
    const two = await manager.createThread(project.id, "Idempotent", "thread-key");
    expect(two.id).toBe(one.id);
    await expect(manager.createThread(project.id, "Different", "thread-key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<FluxError>);
  });

  it("durably replays prepare, open, approval, and resume without repeating side effects", async () => {
    let prepares = 0; let opens = 0; let executions = 0;
    const { manager, makeRun, project, workspaceRoot } = await fixture({
      prepare: async () => { prepares += 1; return { isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Preview", summary: "Safe", artifactCount: 1, digest: digest("c") } }; },
      open: async () => { opens += 1; return { opened: true, label: "Opened once", checkpointRequired: true }; },
      execute: async () => { executions += 1; return { disposition: "completed", reports: [] }; },
    });
    const first = await makeRun(); const second = await makeRun();
    const prepared = await manager.prepareRun(first.id, "prepare-key");
    expect(await manager.prepareRun(first.id, "prepare-key")).toEqual(prepared);
    await expect(manager.prepareRun(second.id, "prepare-key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(prepares).toBe(1);
    const opened = await manager.open(project.id, first.id, "open-key");
    expect(await manager.open(project.id, first.id, "open-key")).toEqual(opened); expect(opens).toBe(1);
    await manager.checkpointOpenRun(first.id, "checkpoint-key");
    const subject = await manager.approvalSubject(first.id);
    const approved = await manager.approveRun(first.id, subject.digest, "approval-key");
    expect(await manager.approveRun(first.id, subject.digest, "approval-key")).toEqual(approved);
    const queued = await manager.resumeRun(first.id, "resume-key"); await manager.waitForIdle();
    expect(await manager.resumeRun(first.id, "resume-key")).toEqual(queued); expect(executions).toBe(1);
    expect(await manager.approveRun(first.id, subject.digest, "approval-key")).toEqual(approved);
    const receipts = (await new FluxRunStore(workspaceRoot).read()).idempotency;
    expect(receipts["approval-key"]).toMatchObject({ status: "completed", terminalReceipt: { outcome: "succeeded" } });
    expect(receipts["resume-key"]).toMatchObject({ status: "completed", terminalReceipt: { outcome: "succeeded" } });
  });

  it("coalesces simultaneous identical open requests and launches once", async () => {
    let opens = 0; const gate = deferred<void>(); const entered = deferred<void>();
    const { manager, makeRun, project } = await fixture({ open: async () => { opens += 1; entered.resolve(); await gate.promise; return { opened: true, label: "Opened once", checkpointRequired: true }; } });
    const run = await makeRun(); await manager.prepareRun(run.id); const first = manager.open(project.id, run.id, "open-concurrent"); const second = manager.open(project.id, run.id, "open-concurrent");
    await entered.promise; expect(opens).toBe(1); gate.resolve(); expect(await Promise.all([first, second])).toEqual([{ opened: true, label: "Opened once", checkpointRequired: true }, { opened: true, label: "Opened once", checkpointRequired: true }]);
  });

  it("records retryable preflight failure before opening and retries the same key after restart", async () => {
    let preflights = 0; let launches = 0; let failPreflight = true;
    const prepare = async () => ({ isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Preview", summary: "Safe", artifactCount: 1, digest: digest("c") } });
    const preflightOpen: NonNullable<FluxExecutionPorts["preflightOpen"]> = async (request) => { preflights += 1; if (failPreflight) throw new Error("deterministic identity probe failure"); return openPreflight(request); };
    const open: NonNullable<FluxExecutionPorts["open"]> = async () => { launches += 1; return { opened: true, label: "Opened after preflight", checkpointRequired: true }; };
    const value = await fixture({ prepare, preflightOpen, open }); const run = await value.makeRun(); await value.manager.prepareRun(run.id);
    const before = await value.manager.getRun(run.id);
    await expect(value.manager.open(value.project.id, run.id, "open-preflight-retry")).rejects.toMatchObject({ code: "OPEN_PREFLIGHT_FAILED" });
    expect(await value.manager.getRun(run.id)).toEqual(before); expect(preflights).toBe(1); expect(launches).toBe(0);
    let state = await new FluxRunStore(value.workspaceRoot).read();
    expect(state.idempotency["open-preflight-retry"]).toMatchObject({ operation: "open_project", status: "preflight_failed", completedAt: expect.any(String), openPreflightFailure: { schemaVersion: "evleda.flux-open-preflight-failure.v1", runId: run.id } });
    expect(state.events.some((event) => event.runId === run.id && event.kind === "run_opened")).toBe(false);

    failPreflight = false;
    const restarted = new FluxRunManager({ workspaceRoot: value.workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "reference", label: "Reference controller", sourceRoot: value.sourceRoot, fingerprint: digest("a") }],
      ports: { prepare, preflightOpen, cancelOpenPreflight: async () => undefined, open, execute: async () => ({ disposition: "completed" }) } });
    await restarted.initialize(); const opened = await restarted.open(value.project.id, run.id, "open-preflight-retry");
    expect(opened.opened).toBe(true); expect(preflights).toBe(2); expect(launches).toBe(1);
    expect(await restarted.open(value.project.id, run.id, "open-preflight-retry")).toEqual(opened); expect(preflights).toBe(2); expect(launches).toBe(1);
    state = await new FluxRunStore(value.workspaceRoot).read(); expect(state.idempotency["open-preflight-retry"]?.status).toBe("completed");
  });

  it("blocks and durably refuses replay when Open preflight process settlement is uncertain", async () => {
    let preflights = 0; let launches = 0;
    const prepare = async () => ({ isolatedFingerprint: digest("b"), checkpointRequired: true, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Preview", summary: "Safe", artifactCount: 1, digest: digest("c") } });
    const preflightOpen: NonNullable<FluxExecutionPorts["preflightOpen"]> = async () => { preflights += 1; throw new FluxError("OPERATION_UNCERTAIN", "private probe detail must not authorize retry"); };
    const open: NonNullable<FluxExecutionPorts["open"]> = async () => { launches += 1; return { opened: true, label: "must not open", checkpointRequired: true }; };
    const value = await fixture({ prepare, preflightOpen, open }); const run = await value.makeRun(); await value.manager.prepareRun(run.id);
    await expect(value.manager.open(value.project.id, run.id, "open-probe-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE });
    expect(await value.manager.getRun(run.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE });
    expect(preflights).toBe(1); expect(launches).toBe(0);
    const state = await new FluxRunStore(value.workspaceRoot).read();
    expect(state.idempotency["open-probe-uncertain"]).toMatchObject({ operation: "open_project", status: "preflight_uncertain", completedAt: expect.any(String),
      openPreflightUncertain: { schemaVersion: "evleda.flux-open-preflight-uncertain.v1", runId: run.id } });
    expect(state.events.some((entry) => entry.runId === run.id && entry.kind === "run_opened")).toBe(false);
    await expect(value.manager.open(value.project.id, run.id, "open-probe-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE });
    await expect(value.manager.open(value.project.id, run.id, "different-open-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(preflights).toBe(1); expect(launches).toBe(0);

    const restarted = new FluxRunManager({ workspaceRoot: value.workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
      sources: [{ key: "reference", label: "Reference controller", sourceRoot: value.sourceRoot, fingerprint: digest("a") }],
      ports: { prepare, preflightOpen, cancelOpenPreflight: async () => undefined, open, execute: async () => ({ disposition: "completed" }) } });
    await restarted.initialize();
    await expect(restarted.open(value.project.id, run.id, "open-probe-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE });
    await expect(restarted.open(value.project.id, run.id, "restart-different-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(preflights).toBe(1); expect(launches).toBe(0);
  });

  it("cancels only preflight allocations that fail before durable opening admission", async () => {
    let confirmed!: Awaited<ReturnType<typeof fixture>>; let confirmedCancels = 0; let confirmedLaunches = 0;
    const confirmedPreflight: NonNullable<FluxExecutionPorts["preflightOpen"]> = async (request) => {
      const receipt = openPreflight(request); await new FluxRunStore(confirmed.workspaceRoot).replace((state) => ({ ...state,
        runs: { ...state.runs, [request.runId!]: { ...state.runs[request.runId!]!, updatedAt: "2030-01-01T00:00:00.000Z" } } })); return receipt;
    };
    confirmed = await fixture({ preflightOpen: confirmedPreflight, cancelOpenPreflight: async () => { confirmedCancels += 1; }, open: async () => { confirmedLaunches += 1; return { opened: true, label: "unexpected", checkpointRequired: true }; } });
    const confirmedRun = await confirmed.makeRun(); await confirmed.manager.prepareRun(confirmedRun.id);
    await expect(confirmed.manager.open(confirmed.project.id, confirmedRun.id, "cancel-confirmed")).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(confirmedCancels).toBe(1); expect(confirmedLaunches).toBe(0); expect((await confirmed.manager.getRun(confirmedRun.id)).phase).toBe("awaiting_open");

    let uncertain!: Awaited<ReturnType<typeof fixture>>; let uncertainCancels = 0; let uncertainLaunches = 0;
    const uncertainPreflight: NonNullable<FluxExecutionPorts["preflightOpen"]> = async (request) => {
      const receipt = openPreflight(request); await new FluxRunStore(uncertain.workspaceRoot).replace((state) => ({ ...state,
        runs: { ...state.runs, [request.runId!]: { ...state.runs[request.runId!]!, updatedAt: "2030-01-02T00:00:00.000Z" } } })); return receipt;
    };
    uncertain = await fixture({ preflightOpen: uncertainPreflight, cancelOpenPreflight: async () => { uncertainCancels += 1; throw new Error("release not confirmed"); }, open: async () => { uncertainLaunches += 1; return { opened: true, label: "unexpected", checkpointRequired: true }; } });
    const uncertainRun = await uncertain.makeRun(); await uncertain.manager.prepareRun(uncertainRun.id);
    await expect(uncertain.manager.open(uncertain.project.id, uncertainRun.id, "cancel-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    expect(uncertainCancels).toBe(1); expect(uncertainLaunches).toBe(0); expect(await uncertain.manager.getRun(uncertainRun.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE });

    let postIntentCancels = 0; let launchAttempts = 0;
    const postIntent = await fixture({ cancelOpenPreflight: async () => { postIntentCancels += 1; }, open: async () => { launchAttempts += 1; throw new Error("launch outcome uncertain"); } });
    const postIntentRun = await postIntent.makeRun(); await postIntent.manager.prepareRun(postIntentRun.id);
    await expect(postIntent.manager.open(postIntent.project.id, postIntentRun.id, "post-intent-launch")).rejects.toThrow("launch outcome uncertain");
    expect(launchAttempts).toBe(1); expect(postIntentCancels).toBe(0); expect((await postIntent.manager.getRun(postIntentRun.id)).phase).toBe("opening");
  });

  it("does not repeat a prepare side effect whose durable intent remained uncertain across restart", async () => {
    let prepares = 0;
    const prepare = async () => { prepares += 1; return { isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Preview", summary: "Safe", artifactCount: 1, digest: digest("c") } }; };
    const { manager, makeRun, sourceRoot, workspaceRoot } = await fixture({ prepare }, { lifecycleObserver: ({ phase, operation }) => { if (phase === "intent_persisted" && operation === "prepare_run") throw new Error("simulated crash"); } });
    const run = await makeRun(); await expect(manager.prepareRun(run.id, "prepare-crash")).rejects.toThrow("simulated crash"); expect(prepares).toBe(0); expect((await new FluxRunStore(workspaceRoot).read()).idempotency["prepare-crash"]?.status).toBe("pending");
    const restarted = new FluxRunManager({ workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "reference", label: "Reference controller", sourceRoot, fingerprint: digest("a") }], ports: { prepare, execute: async () => ({ disposition: "completed" }) } });
    await restarted.initialize(); await expect(restarted.prepareRun(run.id, "prepare-crash")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" }); expect(prepares).toBe(0);
  });

  it("does not repeat a resume executor whose terminal receipt remained pending across restart", async () => {
    let executions = 0;
    const execute = async () => { executions += 1; return { disposition: "completed" as const, reports: [] }; };
    const { manager, makeRun, project, sourceRoot, workspaceRoot } = await fixture({ execute }, { lifecycleObserver: ({ phase, operation }) => { if (phase === "side_effect_completed" && operation === "resume_run") throw new Error("simulated crash"); } });
    const run = await makeRun(); await manager.prepareRun(run.id); await manager.open(project.id, run.id); await manager.checkpointOpenRun(run.id); const subject = await manager.approvalSubject(run.id); await manager.approveRun(run.id, subject.digest); await manager.resumeRun(run.id, "resume-crash"); await expect(manager.waitForIdle()).rejects.toThrow("simulated crash"); expect(executions).toBe(1); expect((await new FluxRunStore(workspaceRoot).read()).idempotency["resume-crash"]?.status).toBe("pending");
    const restarted = new FluxRunManager({ workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "reference", label: "Reference controller", sourceRoot, fingerprint: digest("a") }], ports: { prepare: async () => { throw new Error("unused"); }, execute } });
    await restarted.initialize(); await expect(restarted.resumeRun(run.id, "resume-crash")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" }); expect(executions).toBe(1);
  });

  it("serializes write runs globally while exposing queued and busy snapshots", async () => {
    const first = deferred<{ reports: readonly { title: string; digest: string; mediaType: string }[] }>();
    let calls = 0;
    const { manager, makeRun, project } = await fixture({ execute: async () => { calls += 1; return calls === 1 ? { ...(await first.promise), disposition: "completed" as const } : { disposition: "completed", reports: [] }; } });
    const r1 = await makeRun(); const r2 = await makeRun();
    for (const run of [r1, r2]) { await manager.prepareRun(run.id); await manager.open(project.id, run.id); await manager.checkpointOpenRun(run.id); const subject = await manager.approvalSubject(run.id); await manager.approveRun(run.id, subject.digest); }
    await manager.resumeRun(r1.id); await manager.resumeRun(r2.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await manager.queueSnapshot()).toMatchObject({ busyRunId: r1.id, queuedRunIds: [r2.id] });
    first.resolve({ reports: [] }); await manager.waitForIdle();
    expect((await manager.getRun(r1.id)).phase).toBe("completed");
    expect((await manager.getRun(r2.id)).phase).toBe("completed");
    expect(calls).toBe(2);
  });

  it("blocks in-flight work on restart with an explanation", async () => {
    const gate = deferred<{ isolatedFingerprint: string; checkpointRequired: boolean; freshNetClassPreparationEvidence: null; freshNetClassSemanticAuthority: null; freshProjectOpenPreparedSourceAuthority: null; preview: { title: string; summary: string; artifactCount: number; digest: string } }>();
    const entered = deferred<void>();
    const { manager, makeRun, sourceRoot, workspaceRoot } = await fixture({ prepare: async () => { entered.resolve(); return gate.promise; } });
    const run = await makeRun(); const pending = manager.prepareRun(run.id).catch(() => undefined);
    await entered.promise;
    const restarted = new FluxRunManager({ workspaceRoot, activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "reference", label: "Reference controller", sourceRoot, fingerprint: digest("a") }], ports: { prepare: async () => ({ isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "x", summary: "x", artifactCount: 0, digest: digest("c") } }), execute: async () => ({ disposition: "completed" }) } });
    await restarted.initialize();
    const blocked = await restarted.getRun(run.id);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedReason).toContain("restarted");
    gate.resolve({ isolatedFingerprint: digest("b"), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "x", summary: "x", artifactCount: 0, digest: digest("c") } }); await pending;
  });

  it("rejects overlapping source and workspace roots", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "evleda-flux-path-")); roots.push(base);
    expect(() => new FluxRunManager({ workspaceRoot: path.join(base, "source", "workspace"), activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, sources: [{ key: "source", label: "Source", sourceRoot: path.join(base, "source"), fingerprint: digest("a") }], ports: { prepare: async () => { throw new Error("unused"); }, execute: async () => ({ disposition: "completed" }) } })).toThrow(/disjoint/u);
  });

  it("keeps an append-only bounded event log and rejects orphan reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-flux-store-")); roots.push(root);
    const store = new FluxRunStore(root, 2); await store.initialize();
    await store.appendEvent({ id: "one", eventSeq: 0, kind: "project_created", detail: "one", at: "2026-01-01T00:00:00.000Z" });
    await store.appendEvent({ id: "two", eventSeq: 0, kind: "project_created", detail: "two", at: "2026-01-01T00:00:01.000Z" });
    await store.appendEvent({ id: "three", eventSeq: 0, kind: "project_created", detail: "three", at: "2026-01-01T00:00:02.000Z" });
    expect((await store.read()).events.map((entry) => entry.id)).toEqual(["two", "three"]);
    const report = { reportId: "report_1", runId: "run_1", title: "Report", digest: digest("a"), mediaType: "text/plain", createdAt: "2026-01-01T00:00:00.000Z", body: "immutable" };
    await expect(store.publishReport(report)).rejects.toMatchObject({ code: "STORE_CORRUPT" } satisfies Partial<FluxError>);
  });

  it("keeps event cursors monotonic after more than 500 events and restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-flux-events-")); roots.push(root);
    const store = new FluxRunStore(root, 500); await store.initialize();
    for (let index = 1; index <= 505; index += 1) await store.appendEvent({ id: `event_${index}`, eventSeq: 0, kind: "project_created", detail: String(index), at: "2026-01-01T00:00:00.000Z" });
    const first = await store.read(); expect(first.events).toHaveLength(500); expect(first.events[0]?.eventSeq).toBe(6); expect(first.events.at(-1)?.eventSeq).toBe(505); expect(first.nextEventSeq).toBe(506);
    const restarted = new FluxRunStore(root, 500); await restarted.appendEvent({ id: "event_506", eventSeq: 0, kind: "project_created", detail: "506", at: "2026-01-01T00:00:00.000Z" });
    const next = await restarted.read(); expect(next.events[0]?.eventSeq).toBe(7); expect(next.events.at(-1)?.eventSeq).toBe(506); expect(next.nextEventSeq).toBe(507);
  });
});
