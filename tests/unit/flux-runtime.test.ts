import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PCB_AGENT_HARNESS_RULE_IDENTITY, PCB_AGENT_MUTATION_ALLOWLIST, pcbAgentRequiredSessionTools, type PcbAgentCliDependencies, type PcbAgentCliExecution, type PcbAgentCliOptions, type PcbAgentCliReport } from "../../src/cli/pcb-agent.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS } from "../../src/flux/contracts.js";
import { FluxRunStore } from "../../src/flux/run-store.js";
import { parseFluxOpenPreflightReceipt } from "../../src/flux/open-preflight.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS } from "../../src/harness/pcb-agent-harness.js";
import { createFluxRuntime, FLUX_ITERATION_CAP_POLICY } from "../../src/flux/runtime.js";
import { registerFluxRoutes } from "../../src/flux/routes.js";
import type { KicadCliAdapter, KicadCliAdapterOptions, KicadPreviewExportResult } from "../../src/integrations/kicad-cli.js";
import { ProcessTreeTerminationUnconfirmedError } from "../../src/integrations/bounded-process.js";
import { createFakeFluxKicadMcpRuntime } from "../helpers/flux-kicad-mcp-runtime.js";
import { createFakeFluxKicadToolchain } from "../helpers/flux-kicad-toolchain.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
};

describe("Flux production runtime adapter", () => {
  it("fails with explicit setup guidance when Flux roots are absent", async () => {
    expect(PCB_AGENT_HARNESS_RULE_IDENTITY).toMatch(/^[a-f0-9]{64}$/u);
    await expect(createFluxRuntime({}, {} as never)).rejects.toThrow("EVLEDA_FLUX_SOURCE_ROOT is required");
  });

  it("runs the lifecycle and rejects fingerprint, rule, or allowlist drift before resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-flux-runtime-")); roots.push(root);
    const source = path.join(root, "sources", "controller"); const workspace = path.join(root, "workspace");
    await mkdir(source, { recursive: true });
    const kicad = await createFakeFluxKicadToolchain(root, "10.0.4", "10.0.4.1");
    let replaceToolchainDuringPrepare = false;
    await Promise.all([
      writeFile(path.join(source, "controller.kicad_pro"), "{}\n"),
      writeFile(path.join(source, "controller.kicad_sch"), "(kicad_sch)\n"),
      writeFile(path.join(source, "controller.kicad_pcb"), "(kicad_pcb)\n"),
    ]);
    const modes: string[] = []; const opened: string[] = [];
    const runCli = async (options: PcbAgentCliOptions, dependencies: PcbAgentCliDependencies = {}): Promise<PcbAgentCliExecution> => {
      modes.push(options.mode);
      const project = path.join(options.outputDir, "project"); await mkdir(project, { recursive: true });
      await Promise.all([
        writeFile(path.join(project, "controller.kicad_pro"), "{}\n"),
        writeFile(path.join(project, "controller.kicad_sch"), "(kicad_sch)\n"),
        writeFile(path.join(project, "controller.kicad_pcb"), "(kicad_pcb)\n"),
      ]);
      const reportPath = path.join(options.outputDir, "pcb-agent-report.json");
      const needsReview = options.mode === "resume" && options.prompt === "Review candidate";
      const workflowPayload = { schemaVersion: "evleda.pcb-agent-workflow-binding.v2" as const, kind: "led_compatibility_fixture" as const, connectivityContractIdentity: canonicalIdentity({ fixture: "led" }, "evleda.fresh-connectivity-contract.v1") };
      let writeSessionIdentity: Readonly<{ readonly sessionReceiptIdentity: ReturnType<typeof canonicalIdentity> }> | undefined;
      if (options.mode === "resume") {
        expect(dependencies.sessionFactory).toBeTypeOf("function");
        const writeSession = await dependencies.sessionFactory!({ workspaceRoot: options.outputDir, projectRoot: project, outputRoot: path.join(options.outputDir, ".evleda-mcp-output"), mode: "write", freshProject: true, requiredTools: pcbAgentRequiredSessionTools(options) });
        expect((writeSession.identity as { launch?: { sessionAuthorityIdentity?: unknown } }).launch?.sessionAuthorityIdentity).toEqual(dependencies.sessionAuthorityIdentity);
        writeSessionIdentity = writeSession.identity as typeof writeSessionIdentity;
        await writeSession.close?.();
      }
      const report: PcbAgentCliReport = { schemaVersion: "evleda.pcb-agent-cli-report.v2", workflow: { ...workflowPayload, identity: canonicalIdentity(workflowPayload, workflowPayload.schemaVersion) }, status: options.mode === "prepare" || needsReview ? "needs_review" : "completed", provider: options.provider, model: options.model, projectPaths: { sourceProjectPath: source, isolatedProjectPath: project, outputPath: options.outputDir, reportPath }, summary: needsReview ? `Bearer secret-token-123456 at ${options.outputDir}` : "fake lifecycle", ruleProfile: { harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY }, ...(writeSessionIdentity === undefined ? {} : { sidecar: { identity: writeSessionIdentity }, writeSessionReceiptIdentity: writeSessionIdentity.sessionReceiptIdentity }), ...(needsReview ? { freshAcceptance: { passed: false, requirements: [{ id: "drc", status: "fail", detail: `cookie=session-secret-123 at ${options.outputDir}` }], missing: ["api_key=provider-secret-123"], sourceHashes: { schematicSha256: "a".repeat(64), pcbSha256: "b".repeat(64) }, evidenceLimitations: ["-----BEGIN PRIVATE KEY-----"] }, freshBoardSaveAudits: [{ rawPcbSaveResult: `private ${options.outputDir}`, fallbackReason: `private ${options.outputDir}`, before: { sha256: "c".repeat(64), bytes: 1 }, live: { sha256: "d".repeat(64), bytes: 2 }, after: { sha256: "d".repeat(64), bytes: 2 }, directorySync: "synced" }] } : {}) };
      if (options.mode === "resume") await dependencies.observer?.({ type: "report", report });
      await writeFile(reportPath, JSON.stringify(report));
      if (replaceToolchainDuringPrepare && options.mode === "prepare") {
        replaceToolchainDuringPrepare = false;
        const editor = await readFile(kicad.pcbnewPath);
        await rename(kicad.pcbnewPath, `${kicad.pcbnewPath}.during-prepare`);
        await writeFile(kicad.pcbnewPath, editor);
      }
      return { report, reportPath, isolatedProjectPath: project, exitCode: 0 };
    };
    const adapterConfigurations: KicadCliAdapterOptions[] = [];
    const previewDirectories: string[] = [];
    const createAdapter = async (options: KicadCliAdapterOptions): Promise<KicadCliAdapter> => {
      adapterConfigurations.push(options);
      return ({
      identity: { kind: "kicad-cli", path: kicad.cliPath, version: kicad.toolchain.kicadCli.operationalVersion, commit: kicad.toolchain.kicadCli.operationalCommit, sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size, capabilityHelpSha256: "c".repeat(64), confirmedCapabilities: [] },
      exportPreviewArtifacts: async ({ outputDirectory }: { outputDirectory: string }): Promise<KicadPreviewExportResult> => {
        previewDirectories.push(outputDirectory);
        const schematicDir = path.join(outputDirectory, "schematic"); const renderDir = path.join(outputDirectory, "renders");
        await Promise.all([mkdir(schematicDir), mkdir(renderDir)]);
        const definitions = [["schematic/controller.svg", "<svg/>", "schematic/controller.svg"], ["renders/board-top.png", "top", "renders/board-top.png"], ["renders/board-bottom.png", "bottom", "renders/board-bottom.png"]] as const;
        const artifacts = [];
        for (const [relativePath, body] of definitions) { const target = path.join(outputDirectory, relativePath); await writeFile(target, body); artifacts.push({ path: target, relativePath, sizeBytes: Buffer.byteLength(body), sha256: hash(body) }); }
        return { classification: "candidate-preview", releaseAuthorized: false, executable: { kind: "kicad-cli", path: "redacted", version: "10.0.3", commit: "abcdef0", sha256: "a".repeat(64), sizeBytes: 1, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: [] }, outputDirectory, sourceHashes: {}, invocations: [], artifacts };
      },
    } as unknown as KicadCliAdapter);
    };
    let policy = { harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST as readonly string[] };
    const profiles = { freshAcceptanceProfileIdentity: "evleda.flux.fresh-led-indicator-acceptance.v1", freshPersistenceProfileIdentity: "evleda.flux.fresh-board-persistence.v1", workflowKind: "led_compatibility_fixture" as const };
    const checkpointNames: string[] = [];
    const checkpointPublicationPaths = new Map<string, string>();
    let checkpointGate: ReturnType<typeof deferred> | undefined;
    let checkpointEntered: ReturnType<typeof deferred> | undefined;
    let rejectIdentityProbe = false;
    let uncertainIdentityProbe = false;
    let rejectLaunch = false;
    let launchAttempts = 0;
    const editorExitResolvers: Array<() => void> = [];
    const identityProbe = async (options: Parameters<typeof kicad.runner>[0]) => {
      if (uncertainIdentityProbe) throw new ProcessTreeTerminationUnconfirmedError("fixture tree uncertainty", options, "", "");
      if (rejectIdentityProbe) throw new Error("identity probe unavailable");
      return await kicad.runner(options);
    };
    const fakeMcp = createFakeFluxKicadMcpRuntime();
    const sessionAuthorityModes: Array<"readonly" | "write"> = [];
    let postProbeAssertGate: ReturnType<typeof deferred> | undefined;
    let postProbeAssertEntered: ReturnType<typeof deferred> | undefined;
    let armPostProbeAssert = false;
    let writeBindGate: ReturnType<typeof deferred> | undefined;
    let writeBindEntered: ReturnType<typeof deferred> | undefined;
    let writeDisposeObserved: ReturnType<typeof deferred> | undefined;
    let disposedWriteAuthorities = 0;
    let readonlyToolGate: ReturnType<typeof deferred> | undefined;
    let readonlyToolEntered: ReturnType<typeof deferred> | undefined;
    let readonlyCloseObserved: ReturnType<typeof deferred> | undefined;
    let rawRuntimeFailure: unknown;
    const kicadMcpRuntime = Object.freeze({ ...fakeMcp.runtime,
      assertCurrent: async (...args: Parameters<typeof fakeMcp.runtime.assertCurrent>) => {
        if (rawRuntimeFailure !== undefined) { const error = rawRuntimeFailure; rawRuntimeFailure = undefined; throw error; }
        const gate = postProbeAssertGate;
        if (gate !== undefined && armPostProbeAssert) { armPostProbeAssert = false; postProbeAssertEntered?.resolve(); await gate.promise; }
        await fakeMcp.runtime.assertCurrent(...args);
      },
      bindSession: async (...args: Parameters<typeof fakeMcp.runtime.bindSession>) => {
        sessionAuthorityModes.push(args[0].mode);
        const authority = await fakeMcp.runtime.bindSession(...args);
        const gate = writeBindGate;
        if (args[0].mode === "write" && gate !== undefined) { writeBindEntered?.resolve(); await gate.promise; }
        return Object.freeze({ ...authority, connect: async (...connectArgs: Parameters<typeof authority.connect>) => {
          const session = await authority.connect(...connectArgs);
          const toolGate = readonlyToolGate;
          if (args[0].mode !== "readonly" || toolGate === undefined) return session;
          return Object.freeze({ ...session,
            callTool: async (...toolArgs: Parameters<typeof session.callTool>) => { readonlyToolEntered?.resolve(); await toolGate.promise; return await session.callTool(...toolArgs); },
            close: async () => { try { await session.close(); } finally { readonlyCloseObserved?.resolve(); } },
          }) as unknown as typeof session;
        }, disposeUnused: async (...disposeArgs: Parameters<typeof authority.disposeUnused>) => {
          if (args[0].mode === "write") disposedWriteAuthorities += 1;
          try { return await authority.disposeUnused(...disposeArgs); }
          finally { if (args[0].mode === "write") writeDisposeObserved?.resolve(); }
        } });
      } });
    await expect(createFluxRuntime(
      { EVLEDA_FLUX_SOURCE_ROOT: path.dirname(source), EVLEDA_FLUX_WORKSPACE_ROOT: path.join(root, "mismatched-workspace"), EVLEDA_PCBNEW: kicad.cliPath },
      { kicadToolchain: kicad.toolchain, kicadMcpRuntime },
    )).rejects.toMatchObject({ code: "PATH_POLICY" });
    const createRuntime = async () => await createFluxRuntime(
      { EVLEDA_FLUX_SOURCE_ROOT: path.dirname(source), EVLEDA_FLUX_WORKSPACE_ROOT: workspace, OPENAI_API_KEY: "must-not-forward", ANTHROPIC_API_KEY: "must-not-forward", GITHUB_TOKEN: "must-not-forward", AWS_SECRET_ACCESS_KEY: "must-not-forward" },
      { providerModel: { provider: "codex", model: "test", tier: "fast" }, kicadToolchain: kicad.toolchain, kicadMcpRuntime, runKicadCliIdentityProbe: identityProbe, runCli: runCli as typeof import("../../src/cli/pcb-agent.js").runPcbAgentCli, checkpointOpen: async ({ newProjectName, outputDir, assertCanCommit }) => { checkpointNames.push(newProjectName); const publicationPath = path.join(outputDir, "checkpoint-publication.test.json"); checkpointPublicationPaths.set(newProjectName, publicationPath); const gate = checkpointGate; if (gate !== undefined) { checkpointEntered?.resolve(); await gate.promise; } assertCanCommit?.(); await writeFile(publicationPath, "{\"published\":true}\n"); return { changed: true, checkpointPath: "private" }; }, createAdapter: createAdapter as typeof KicadCliAdapter.create, launchPcbEditor: async ({ executablePath, boardPath, environment: childEnvironment }) => { launchAttempts += 1; expect(executablePath).toBe(kicad.pcbnewPath); expect(childEnvironment.KICAD_API_SOCKET).toMatch(/^ipc:\/\//u); expect(childEnvironment).not.toHaveProperty("PATH"); expect(childEnvironment).not.toHaveProperty("PATHEXT"); expect(childEnvironment).not.toHaveProperty("OPENAI_API_KEY"); expect(childEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(childEnvironment).not.toHaveProperty("GITHUB_TOKEN"); expect(childEnvironment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY"); if (rejectLaunch) throw new Error("spawn rejected before a process existed"); await writeFile(path.join(path.dirname(boardPath), `~${path.basename(boardPath)}.lck`), "{\"fixture\":true}\n"); opened.push(path.basename(boardPath)); let resolveExit!: () => void; const exited = new Promise<Readonly<{ code: null; signal: null }>>((resolve) => { resolveExit = () => resolve(Object.freeze({ code: null, signal: null })); }); editorExitResolvers.push(resolveExit); return { pid: process.pid, exited }; }, isPcbEditorProcessAlive: () => true, currentHarnessPolicy: () => policy },
    );
    const runtime = await createRuntime();
    const copy = (await runtime.manager.sources()).find((entry) => entry.label === "controller")!;
    const canonicalMutationAllowlist = [...PCB_AGENT_MUTATION_ALLOWLIST].sort();
    expect(PCB_AGENT_MUTATION_ALLOWLIST).toHaveLength(18); expect(new Set(PCB_AGENT_MUTATION_ALLOWLIST).size).toBe(18);
    expect(PCB_AGENT_MUTATION_ALLOWLIST).toContain("fresh_autoplace_schematic_fields");
    expect(PCB_AGENT_MUTATION_ALLOWLIST.filter((name) => name !== "fresh_autoplace_schematic_fields")).toEqual([
      "sch_apply_plan", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint", "fresh_apply_contract_connectivity",
      "fresh_apply_recommended_schematic_placement", "fresh_replace_route_items", "fresh_sync_from_schematic", "sch_move_symbol",
      "pcb_set_board_outline", "pcb_add_track", "pcb_add_via", "pcb_place_component", "pcb_move_component", "pcb_move_footprint",
      "pcb_sync_from_schematic", "pcb_add_zone",
    ]);
    expect(PCB_AGENT_MUTATION_ALLOWLIST).not.toEqual(canonicalMutationAllowlist);
    const projectedPolicy = runtime.routes.policy!();
    expect(projectedPolicy).toMatchObject({ iterationCap: { minimum: 1, maximum: 24, recommended: 12 }, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, checkpointOpenRequiredForFresh: true, freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$" });
    expect(projectedPolicy.mutationAllowlist).toEqual(canonicalMutationAllowlist); expect(Object.isFrozen(projectedPolicy.mutationAllowlist)).toBe(true); expect(projectedPolicy.mutationAllowlist).not.toContain("sch_add_no_connect");
    expect(runtime.routes.policy?.().iterationCap).toBe(FLUX_ITERATION_CAP_POLICY);
    expect(FLUX_ITERATION_CAP_POLICY).toEqual({ minimum: PCB_AGENT_MIN_ITERATIONS, maximum: PCB_AGENT_MAX_FRESH_ITERATIONS, recommended: 12 });
    const policyApp = Fastify(); await registerFluxRoutes(policyApp, runtime.routes);
    try {
      const policyResponse = await policyApp.inject({ method: "GET", url: "/api/v1/flux/policy" });
      expect(policyResponse.statusCode).toBe(200);
      const servedPolicy = policyResponse.json().result as typeof projectedPolicy;
      expect(servedPolicy.mutationAllowlist).toEqual(canonicalMutationAllowlist);
      const apiProject = (await policyApp.inject({ method: "POST", url: "/api/v1/flux/projects", headers: { "idempotency-key": "canonical-policy-project" }, payload: { sourceKey: copy.key, name: "Canonical policy" } })).json().result;
      const apiThread = (await policyApp.inject({ method: "POST", url: `/api/v1/flux/projects/${apiProject.id}/threads`, headers: { "idempotency-key": "canonical-policy-thread" }, payload: { title: "Canonical policy" } })).json().result;
      const runPayload = { projectId: apiProject.id, threadId: apiThread.id, prompt: "Canonical policy candidate", providerModel: servedPolicy.providerModel, iterationCap: 2,
        harnessRuleIdentity: servedPolicy.harnessRuleIdentity, mutationAllowlist: servedPolicy.mutationAllowlist, freshAcceptanceProfileIdentity: servedPolicy.freshAcceptanceProfileIdentity,
        freshPersistenceProfileIdentity: servedPolicy.freshPersistenceProfileIdentity, workflowKind: "generic" };
      const runResponse = await policyApp.inject({ method: "POST", url: "/api/v1/flux/runs", headers: { "idempotency-key": "canonical-policy-run" }, payload: runPayload });
      expect(runResponse.statusCode).toBe(200); expect(runResponse.json().result.mutationAllowlist).toEqual(servedPolicy.mutationAllowlist);
      const noncanonicalResponse = await policyApp.inject({ method: "POST", url: "/api/v1/flux/runs", headers: { "idempotency-key": "noncanonical-policy-run" }, payload: { ...runPayload, mutationAllowlist: [...servedPolicy.mutationAllowlist].reverse() } });
      expect(noncanonicalResponse.statusCode).toBe(400); expect(noncanonicalResponse.json().error.message).toContain("canonical active server policy");
    } finally { await policyApp.close(); }
    for (const invalidAllowlist of [
      [...PCB_AGENT_MUTATION_ALLOWLIST, PCB_AGENT_MUTATION_ALLOWLIST[0]],
      PCB_AGENT_MUTATION_ALLOWLIST.slice(1),
      [...PCB_AGENT_MUTATION_ALLOWLIST.slice(0, -1), "new_mutation"],
      [...PCB_AGENT_MUTATION_ALLOWLIST.slice(0, -1), "../unsafe"],
    ]) {
      policy = { harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: invalidAllowlist };
      expect(() => runtime.routes.policy!()).toThrow("exact unique executable mutation-tool set");
    }
    policy = { harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST as readonly string[] };
    const project = await runtime.manager.createProject(copy.key, "Controller"); const thread = await runtime.manager.createThread(project.id, "Main");
    const run = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Edit candidate", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: projectedPolicy.mutationAllowlist, ...profiles });
    expect(run.mutationAllowlist).toEqual(projectedPolicy.mutationAllowlist);
    const sourceSchematicBefore = await readFile(path.join(source, "controller.kicad_sch"));
    const preparedRun = await runtime.manager.prepareRun(run.id);
    expect(preparedRun.phase).toBe("awaiting_open");
    const initialPreview = await runtime.routes.ports!.preview!.get(run.id);
    const previewRevisionRoot = path.dirname(initialPreview.root);
    const previewAuthorityRoot = path.dirname(previewRevisionRoot);
    expect(path.dirname(previewAuthorityRoot)).toBe(path.join(workspace, "preview-revisions"));
    expect(path.basename(previewAuthorityRoot)).toMatch(/^authority-[0-9a-f]{24}$/u);
    expect(path.basename(previewRevisionRoot)).toBe("revisions");
    const authorityMarker = JSON.parse(await readFile(path.join(previewAuthorityRoot, "authority.json"), "utf8")) as Record<string, unknown>;
    expect(authorityMarker).toMatchObject({ runId: run.id, workflowKind: "led_compatibility_fixture", authorityDigest: preparedRun.contractState!.contractIdentity!.digest });
    const compilationRoot = path.join(workspace, "runs", run.id, "compilations", preparedRun.contractState!.contractIdentity!.digest);
    expect(adapterConfigurations[0]).toMatchObject({ workspaceRoot: compilationRoot, projectRoot: path.join(compilationRoot, "project"), outputRoot: previewAuthorityRoot,
      expectedExecutableIdentity: { sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size } });
    expect(previewDirectories[0]).toBe(initialPreview.root);
    if (process.platform === "win32") expect(previewDirectories[0]!.length).toBeLessThanOrEqual(247);
    await rm(previewAuthorityRoot, { recursive: true, force: true });
    const refreshedAfterCleanup = await runtime.routes.ports!.preview!.refresh(run.id);
    expect(refreshedAfterCleanup.artifacts).toHaveLength(3);
    expect(path.dirname(path.dirname(refreshedAfterCleanup.root))).toBe(previewAuthorityRoot);
    expect(JSON.parse(await readFile(path.join(previewAuthorityRoot, "authority.json"), "utf8"))).toEqual(authorityMarker);
    rejectIdentityProbe = true;
    const probesBeforeOpenFailure = kicad.calls.length;
    await expect(runtime.manager.open(project.id, run.id, "open-main")).rejects.toMatchObject({ code: "OPEN_PREFLIGHT_FAILED" });
    expect((await runtime.manager.getRun(run.id)).phase).toBe("awaiting_open");
    expect(opened).toEqual([]); expect(launchAttempts).toBe(0); expect(kicad.calls).toHaveLength(probesBeforeOpenFailure);
    rejectIdentityProbe = false;
    await runtime.manager.open(project.id, run.id, "open-main"); expect(opened).toEqual(["controller.kicad_pcb"]);
    expect(kicad.calls.every((call) => call.command === kicad.cliPath)).toBe(true);
    expect((await new FluxRunStore(workspace).read()).runs[run.id]?.openPreflightReceipt?.suiteVersion).toBe("10.0.4");
    expect((await runtime.manager.checkpointOpenRun(run.id, "checkpoint-main")).phase).toBe("awaiting_approval");
    expect(fakeMcp.connectionCount()).toBe(1);
    const subject = await runtime.manager.approvalSubject(run.id); await runtime.manager.approveRun(run.id, subject.digest);
    await rm(previewAuthorityRoot, { recursive: true, force: true });
    await runtime.manager.resumeRun(run.id); await runtime.manager.waitForIdle();
    const completedRun = await runtime.manager.getRun(run.id);
    expect(completedRun.phase).toBe("completed"); expect(modes).toEqual(["prepare", "resume"]);
    const completedPersisted = (await new FluxRunStore(workspace).read()).runs[run.id]!;
    const checkpointInspectionReceipt = completedPersisted.openCheckpointReceipt !== undefined && "checkpointInspectionSessionReceiptIdentity" in completedPersisted.openCheckpointReceipt
      ? completedPersisted.openCheckpointReceipt.checkpointInspectionSessionReceiptIdentity
      : undefined;
    expect(checkpointInspectionReceipt).toBeDefined();
    expect(completedRun.reports[0]?.executionInspectionSessionReceiptIdentity).not.toEqual(checkpointInspectionReceipt);
    expect((await runtime.manager.events()).some((entry) => entry.kind === "run_progress")).toBe(true);
    expect((await runtime.manager.events()).some((entry) => entry.kind === "preview_ready")).toBe(true);
    expect((await runtime.routes.ports!.preview!.get(run.id)).artifacts).toHaveLength(3);
    expect((await readFile(path.join(source, "controller.kicad_sch"))).equals(sourceSchematicBefore)).toBe(true);
    const firstInspection = await runtime.routes.ports!.inspector!.inspect(run.id, "inspect-main");
    expect(firstInspection).toMatchObject({ state: "ready", runId: run.id, connectionBudget: { used: 4, remaining: 4, limit: 8 } });
    const connectionsBeforeReplay = fakeMcp.connectionCount();
    expect(await runtime.routes.ports!.inspector!.inspect(run.id, "inspect-main")).toEqual(firstInspection);
    expect(fakeMcp.connectionCount()).toBe(connectionsBeforeReplay);
    for (let index = 0; index < 4; index += 1) {
      expect(await runtime.routes.ports!.inspector!.inspect(run.id, `inspect-budget-${index}`)).toMatchObject({ connectionBudget: { used: 5 + index, remaining: 3 - index, limit: 8 } });
    }
    const runBeforeExhaustedInspection = await runtime.manager.getRun(run.id);
    await expect(runtime.routes.ports!.inspector!.inspect(run.id, "inspect-budget-exhausted")).rejects.toThrow(/connection authority rejected/iu);
    expect(await runtime.manager.getRun(run.id)).toEqual(runBeforeExhaustedInspection);
    expect(await runtime.routes.ports!.inspector!.snapshot(run.id)).toMatchObject({ connectionBudget: { used: 8, remaining: 0, limit: 8 } });
    editorExitResolvers[0]!();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(fakeMcp.releasedCount()).toBe(1);
    await expect(runtime.routes.ports!.inspector!.snapshot(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    await rm(previewAuthorityRoot, { recursive: true, force: true });
    const restarted = await createRuntime();
    const [liveRefresh, restartedRefresh] = await Promise.all([
      runtime.routes.ports!.preview!.refresh(run.id),
      restarted.routes.ports!.preview!.refresh(run.id),
    ]);
    expect(path.dirname(path.dirname(liveRefresh.root))).toBe(previewAuthorityRoot);
    expect(path.dirname(path.dirname(restartedRefresh.root))).toBe(previewAuthorityRoot);
    expect(liveRefresh.root).not.toBe(restartedRefresh.root);

    const openAndCheckpoint = async (runId: string, key: string): Promise<void> => {
      await runtime.manager.open(project.id, runId, `open-${key}`);
      await runtime.manager.checkpointOpenRun(runId, `checkpoint-${key}`);
    };

    const changed = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Changed candidate", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(changed.id);
    const changedPreview = await runtime.routes.ports!.preview!.get(changed.id);
    const changedAuthorityRoot = path.dirname(path.dirname(changedPreview.root));
    expect(changedAuthorityRoot).not.toBe(previewAuthorityRoot);
    await openAndCheckpoint(changed.id, "changed");
    const changedSubject = await runtime.manager.approvalSubject(changed.id); await runtime.manager.approveRun(changed.id, changedSubject.digest);
    await appendFile(path.join(workspace, "runs", changed.id, "compilations", changed.contractState!.contractIdentity!.digest, "project", "controller.kicad_pcb"), "changed\n");
    await runtime.manager.resumeRun(changed.id); await runtime.manager.waitForIdle();
    expect((await runtime.manager.getRun(changed.id)).phase).toBe("failed"); expect(modes).toEqual(["prepare", "resume", "prepare"]);

    const wrongRule = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Wrong rule", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: "caller-rule", mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await expect(runtime.manager.prepareRun(wrongRule.id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const wrongMutations = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Wrong tools", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: ["pcb_add_track"], ...profiles });
    await expect(runtime.manager.prepareRun(wrongMutations.id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Too many iterations", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 25, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const drifted = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Policy drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(drifted.id); await openAndCheckpoint(drifted.id, "drifted"); const driftSubject = await runtime.manager.approvalSubject(drifted.id); await runtime.manager.approveRun(drifted.id, driftSubject.digest);
    policy = { harnessRuleIdentity: "f".repeat(64), mutationAllowlist: [...PCB_AGENT_MUTATION_ALLOWLIST, "new_mutation"] };
    await runtime.manager.resumeRun(drifted.id); await runtime.manager.waitForIdle(); const driftResult = await runtime.manager.getRun(drifted.id);
    expect(driftResult.phase).toBe("failed"); expect(driftResult.blockedReason).toContain("policy changed after approval"); expect(modes).toEqual(["prepare", "resume", "prepare", "prepare"]);

    policy = { harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST as readonly string[] };
    const freshSource = (await runtime.manager.sources()).find((entry) => entry.label === "New KiCad project")!; const freshProject = await runtime.manager.createProject(freshSource.key, "Fresh"); const freshThread = await runtime.manager.createThread(freshProject.id, "Fresh");
    const freshRun = await runtime.manager.createRun({ projectId: freshProject.id, threadId: freshThread.id, prompt: "Fresh candidate", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    expect((await runtime.manager.prepareRun(freshRun.id)).phase).toBe("awaiting_open"); await runtime.manager.open(freshProject.id, freshRun.id); expect((await runtime.manager.getRun(freshRun.id)).phase).toBe("awaiting_checkpoint");
    const checkpointStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect((await runtime.manager.checkpointOpenRun(freshRun.id)).phase).toBe("awaiting_approval"); expect(checkpointNames).toHaveLength(1); expect(checkpointNames[0]).toMatch(/^[a-z][a-z0-9-]{0,63}$/u); expect(checkpointNames[0]).not.toContain("_");
    expect(checkpointStderr).not.toHaveBeenCalled();

    const openedFreshRun = async (prompt: string) => {
      const candidate = await runtime.manager.createRun({ projectId: freshProject.id, threadId: freshThread.id, prompt, providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
      await runtime.manager.prepareRun(candidate.id); await runtime.manager.open(freshProject.id, candidate.id);
      expect((await runtime.manager.getRun(candidate.id)).phase).toBe("awaiting_checkpoint");
      return candidate;
    };

    const rawFailureRun = await openedFreshRun("Sensitive checkpoint prompt");
    const rawFailure = Object.assign(new Error(`provider-secret ${workspace} ${"sensitive-output".repeat(500)}`), {
      name: "SensitiveProviderError", code: "provider-secret-code", cause: { output: "sensitive-provider-output" },
    });
    const connectionsBeforeRawFailure = fakeMcp.connectionCount();
    rawRuntimeFailure = rawFailure;
    await expect(runtime.manager.checkpointOpenRun(rawFailureRun.id, "raw-runtime-failure")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
    expect(checkpointStderr).toHaveBeenCalledTimes(1);
    const rawFailureRecord = String(checkpointStderr.mock.calls[0]![0]);
    const diagnostic = JSON.parse(rawFailureRecord) as Record<string, unknown>;
    expect(diagnostic).toEqual({ event: "flux_checkpoint_failure", runId: rawFailureRun.id, stage: "runtime_revalidation", elapsedMs: expect.any(Number), errorCategory: "error", errorCode: "UNKNOWN" });
    expect(Number.isInteger(diagnostic.elapsedMs)).toBe(true);
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0); expect(diagnostic.elapsedMs).toBeLessThanOrEqual(86_400_000);
    expect(Buffer.byteLength(rawFailureRecord, "utf8")).toBeLessThan(512);
    expect(rawFailureRecord).not.toMatch(/provider-secret|SensitiveProviderError|sensitive-output|sensitive-provider-output|Sensitive checkpoint prompt|stack|cause/iu);
    expect(rawFailureRecord).not.toContain(workspace);
    expect(fakeMcp.connectionCount()).toBe(connectionsBeforeRawFailure);
    expect((await new FluxRunStore(workspace).read()).runs[rawFailureRun.id]?.openCheckpointReceipt).toBeUndefined();
    await expect(runtime.manager.approvalSubject(rawFailureRun.id)).rejects.toBeDefined();
    await expect(runtime.manager.checkpointOpenRun(rawFailureRun.id, "raw-runtime-failure")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    expect(checkpointStderr).toHaveBeenCalledTimes(1);

    const throwingSinkRun = await openedFreshRun("Throwing checkpoint stderr");
    const preparation = await runtime.manager.verifiedPreparation(throwingSinkRun.id);
    const preflight = parseFluxOpenPreflightReceipt((await new FluxRunStore(workspace).read()).runs[throwingSinkRun.id]!.openPreflightReceipt);
    checkpointStderr.mockImplementationOnce(() => { throw new Error("stderr unavailable"); });
    rawRuntimeFailure = rawFailure;
    // Observe the host port before the manager's intentional public-error normalization.
    await expect(runtime.manager["options"].ports.checkpointOpen!({ ...preparation, openPreflightReceipt: preflight }, {
      signal: new AbortController().signal, deadlineAtMs: Date.now() + FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS,
    })).rejects.toBe(rawFailure);
    expect(checkpointStderr).toHaveBeenCalledTimes(2);

    const delayedCheckpoint = await openedFreshRun("Delayed checkpoint");
    checkpointGate = deferred(); checkpointEntered = deferred();
    vi.useFakeTimers();
    try {
      const pending = runtime.manager.checkpointOpenRun(delayedCheckpoint.id, "delayed-checkpoint");
      await checkpointEntered.promise; await vi.advanceTimersByTimeAsync(1_000); checkpointGate.resolve();
      expect((await pending).phase).toBe("awaiting_approval");
    } finally {
      checkpointGate.resolve(); checkpointGate = undefined; checkpointEntered = undefined; vi.useRealTimers();
    }
    const delayedName = checkpointNames.at(-1)!;
    expect(await readFile(checkpointPublicationPaths.get(delayedName)!, "utf8")).toContain("published");

    const lateNormalizerRun = await openedFreshRun("Late normalizer checkpoint");
    const lateConnections = fakeMcp.connectionCount(); const lateModes = sessionAuthorityModes.length; const latePreviews = previewDirectories.length; const lateReleases = fakeMcp.releasedCount();
    checkpointGate = deferred(); checkpointEntered = deferred();
    const lateGate = checkpointGate; const lateEntered = checkpointEntered;
    vi.useFakeTimers();
    try {
      const pending = runtime.manager.checkpointOpenRun(lateNormalizerRun.id, "late-normalizer-checkpoint");
      await lateEntered.promise; await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      await expect(pending).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    } finally {
      vi.useRealTimers(); lateGate.resolve(); checkpointGate = undefined; checkpointEntered = undefined;
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const lateName = checkpointNames.at(-1)!;
    expect(JSON.parse(String(checkpointStderr.mock.calls.at(-1)![0]))).toMatchObject({ runId: lateNormalizerRun.id, stage: "normalization", errorCategory: "flux", errorCode: "OPERATION_UNCERTAIN" });
    await expect(readFile(checkpointPublicationPaths.get(lateName)!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fakeMcp.connectionCount()).toBe(lateConnections); expect(sessionAuthorityModes).toHaveLength(lateModes); expect(previewDirectories).toHaveLength(latePreviews); expect(fakeMcp.releasedCount()).toBe(lateReleases);
    expect(await runtime.manager.getRun(lateNormalizerRun.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    expect((await new FluxRunStore(workspace).read()).runs[lateNormalizerRun.id]?.openCheckpointReceipt).toBeUndefined();
    await expect(runtime.manager.approvalSubject(lateNormalizerRun.id)).rejects.toBeDefined();

    const liveReadAbortRun = await openedFreshRun("Abort live readonly probe");
    const liveReadConnections = fakeMcp.connectionCount(); const liveReadModes = sessionAuthorityModes.length; const liveReadPreviews = previewDirectories.length; const liveReadReleases = fakeMcp.releasedCount();
    readonlyToolGate = deferred(); readonlyToolEntered = deferred(); readonlyCloseObserved = deferred();
    const liveToolGate = readonlyToolGate; const liveToolEntered = readonlyToolEntered; const liveCloseObserved = readonlyCloseObserved;
    vi.useFakeTimers();
    try {
      const pending = runtime.manager.checkpointOpenRun(liveReadAbortRun.id, "abort-live-readonly-probe");
      await liveToolEntered.promise;
      await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      await expect(pending).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      await liveCloseObserved.promise;
    } finally {
      vi.useRealTimers(); liveToolGate.resolve(); readonlyToolGate = undefined; readonlyToolEntered = undefined; readonlyCloseObserved = undefined;
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(JSON.parse(String(checkpointStderr.mock.calls.at(-1)![0]))).toMatchObject({ runId: liveReadAbortRun.id, stage: "readonly_ipc_probe", errorCategory: "flux", errorCode: "OPERATION_UNCERTAIN" });
    expect(fakeMcp.connectionCount()).toBe(liveReadConnections + 1); expect(sessionAuthorityModes.slice(liveReadModes)).toEqual(["readonly"]); expect(previewDirectories).toHaveLength(liveReadPreviews); expect(fakeMcp.releasedCount()).toBe(liveReadReleases);
    expect((await new FluxRunStore(workspace).read()).runs[liveReadAbortRun.id]?.openCheckpointReceipt).toBeUndefined();
    await expect(runtime.manager.approvalSubject(liveReadAbortRun.id)).rejects.toBeDefined();

    const postProbeHangRun = await openedFreshRun("Attempt six post-probe hang");
    const postProbeConnections = fakeMcp.connectionCount(); const postProbeModes = sessionAuthorityModes.length; const postProbePreviews = previewDirectories.length; const postProbeReleases = fakeMcp.releasedCount();
    postProbeAssertGate = deferred(); postProbeAssertEntered = deferred(); armPostProbeAssert = false;
    const postProbeGate = postProbeAssertGate; const postProbeEntered = postProbeAssertEntered;
    fakeMcp.setOnSessionClosed(() => { armPostProbeAssert = true; });
    vi.useFakeTimers();
    try {
      const pending = runtime.manager.checkpointOpenRun(postProbeHangRun.id, "attempt6-post-probe-hang");
      await postProbeEntered.promise;
      expect(fakeMcp.connectionCount()).toBe(postProbeConnections + 1); expect(sessionAuthorityModes.slice(postProbeModes)).toEqual(["readonly"]);
      await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      await expect(pending).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    } finally {
      vi.useRealTimers(); postProbeGate.resolve(); postProbeAssertGate = undefined; postProbeAssertEntered = undefined; fakeMcp.setOnSessionClosed(undefined);
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(JSON.parse(String(checkpointStderr.mock.calls.at(-1)![0]))).toMatchObject({ runId: postProbeHangRun.id, stage: "readonly_ipc_probe", errorCategory: "flux", errorCode: "OPERATION_UNCERTAIN" });
    expect(sessionAuthorityModes.slice(postProbeModes)).toEqual(["readonly"]); expect(previewDirectories).toHaveLength(postProbePreviews); expect(fakeMcp.releasedCount()).toBe(postProbeReleases);
    expect(await runtime.manager.getRun(postProbeHangRun.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    expect((await new FluxRunStore(workspace).read()).runs[postProbeHangRun.id]?.openCheckpointReceipt).toBeUndefined();
    await expect(runtime.manager.approvalSubject(postProbeHangRun.id)).rejects.toBeDefined();

    const lateWriteBindRun = await openedFreshRun("Late write authority bind");
    const writeBindConnections = fakeMcp.connectionCount(); const writeBindModes = sessionAuthorityModes.length; const writeBindPreviews = previewDirectories.length; const writeBindReleases = fakeMcp.releasedCount(); const writeDisposalsBefore = disposedWriteAuthorities;
    writeBindGate = deferred(); writeBindEntered = deferred(); writeDisposeObserved = deferred();
    const lateWriteGate = writeBindGate; const lateWriteEntered = writeBindEntered; const lateWriteDisposed = writeDisposeObserved;
    vi.useFakeTimers();
    try {
      const pending = runtime.manager.checkpointOpenRun(lateWriteBindRun.id, "late-write-bind");
      await lateWriteEntered.promise;
      expect(fakeMcp.connectionCount()).toBe(writeBindConnections + 1); expect(sessionAuthorityModes.slice(writeBindModes)).toEqual(["readonly", "write"]);
      await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      await expect(pending).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    } finally {
      vi.useRealTimers(); lateWriteGate.resolve(); writeBindGate = undefined; writeBindEntered = undefined;
    }
    await lateWriteDisposed.promise; writeDisposeObserved = undefined;
    expect(JSON.parse(String(checkpointStderr.mock.calls.at(-1)![0]))).toMatchObject({ runId: lateWriteBindRun.id, stage: "write_binding", errorCategory: "flux", errorCode: "OPERATION_UNCERTAIN" });
    expect(disposedWriteAuthorities).toBe(writeDisposalsBefore + 1); expect(previewDirectories).toHaveLength(writeBindPreviews); expect(fakeMcp.releasedCount()).toBe(writeBindReleases);
    expect(await runtime.manager.getRun(lateWriteBindRun.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
    expect((await new FluxRunStore(workspace).read()).runs[lateWriteBindRun.id]?.openCheckpointReceipt).toBeUndefined();
    await expect(runtime.manager.approvalSubject(lateWriteBindRun.id)).rejects.toBeDefined();

    const review = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Review candidate", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(review.id); await openAndCheckpoint(review.id, "review"); const reviewSubject = await runtime.manager.approvalSubject(review.id); await runtime.manager.approveRun(review.id, reviewSubject.digest); await runtime.manager.resumeRun(review.id); await runtime.manager.waitForIdle(); const reviewed = await runtime.manager.getRun(review.id);
    expect(reviewed.phase).toBe("needs_review"); expect(reviewed.reports[0]).toMatchObject({ disposition: "needs_review", freshAcceptance: { passed: false }, freshBoardSaveAudits: [{ directorySync: "synced" }] });
    expect(reviewed.reports[0]?.summary).toBe("PCB agent candidate execution requires review.");
    expect(reviewed.reports[0]?.freshAcceptance).toMatchObject({ requirements: [{ detail: "Sensitive diagnostic text was withheld." }], missing: ["Sensitive diagnostic text was withheld."], evidenceLimitations: ["Sensitive diagnostic text was withheld."] });
    expect(reviewed.reports[0]?.reportSha256).toBe(reviewed.reports[0]?.digest); const projection = JSON.stringify(reviewed.reports[0]); expect(projection).not.toContain("projectPaths"); expect(projection).not.toContain(workspace); expect(projection).not.toContain("rawPcbSaveResult"); expect(projection).not.toContain("fallbackReason"); expect(projection).not.toMatch(/secret-token|session-secret|provider-secret|PRIVATE KEY/iu);
    await writeFile(path.join(changedAuthorityRoot, "authority.json"), "{}\n");
    await expect(runtime.routes.ports!.preview!.refresh(changed.id)).rejects.toMatchObject({ code: "PATH_POLICY" });

    const lockDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Lock drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(lockDrift.id); await openAndCheckpoint(lockDrift.id, "lock-drift"); const lockApproval = await runtime.manager.approvalSubject(lockDrift.id); await runtime.manager.approveRun(lockDrift.id, lockApproval.digest);
    const lockProject = path.join(workspace, "runs", lockDrift.id, "compilations", lockDrift.contractState!.contractIdentity!.digest, "project");
    await writeFile(path.join(lockProject, "~controller.kicad_pcb.lck"), "{\"fixture\":\"changed\"}\n");
    await runtime.manager.resumeRun(lockDrift.id); await runtime.manager.waitForIdle();
    expect((await runtime.manager.getRun(lockDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("lock") });

    const toolchainDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Toolchain drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(toolchainDrift.id); await openAndCheckpoint(toolchainDrift.id, "toolchain-drift"); const toolchainApproval = await runtime.manager.approvalSubject(toolchainDrift.id); await runtime.manager.approveRun(toolchainDrift.id, toolchainApproval.digest);
    const editorBytes = await readFile(kicad.pcbnewPath); const changedEditor = Buffer.from(editorBytes); changedEditor[changedEditor.length - 1] = changedEditor[changedEditor.length - 1]! ^ 0xff; await writeFile(kicad.pcbnewPath, changedEditor);
    await runtime.manager.resumeRun(toolchainDrift.id); await runtime.manager.waitForIdle();
    expect((await runtime.manager.getRun(toolchainDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("toolchain") });
    await writeFile(kicad.pcbnewPath, editorBytes);

    const prepareDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Prepare toolchain drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    const changedBeforePrepare = Buffer.from(editorBytes); changedBeforePrepare[changedBeforePrepare.length - 2] = changedBeforePrepare[changedBeforePrepare.length - 2]! ^ 0xff; await writeFile(kicad.pcbnewPath, changedBeforePrepare);
    const modesBeforePrepareDrift = modes.length;
    await expect(runtime.manager.prepareRun(prepareDrift.id)).rejects.toThrow(/SHA-256/iu);
    expect(modes).toHaveLength(modesBeforePrepareDrift);
    await writeFile(kicad.pcbnewPath, editorBytes);

    const postPrepareDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Post-prepare toolchain drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    replaceToolchainDuringPrepare = true;
    await expect(runtime.manager.prepareRun(postPrepareDrift.id)).rejects.toThrow(/replaced/iu);
    expect(replaceToolchainDuringPrepare).toBe(false);

    const bridgeDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Inspection bridge drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(bridgeDrift.id); await openAndCheckpoint(bridgeDrift.id, "bridge-drift"); const bridgeApproval = await runtime.manager.approvalSubject(bridgeDrift.id); await runtime.manager.approveRun(bridgeDrift.id, bridgeApproval.digest);
    fakeMcp.setCurrent(false); await runtime.manager.resumeRun(bridgeDrift.id); await runtime.manager.waitForIdle();
    expect((await runtime.manager.getRun(bridgeDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("toolchain") });
    fakeMcp.setCurrent(true);

    const ipcSemanticDrift = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "IPC semantic drift", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(ipcSemanticDrift.id); await openAndCheckpoint(ipcSemanticDrift.id, "ipc-semantic-drift"); const ipcSemanticApproval = await runtime.manager.approvalSubject(ipcSemanticDrift.id); await runtime.manager.approveRun(ipcSemanticDrift.id, ipcSemanticApproval.digest);
    fakeMcp.setReadSemanticVersion(2); await runtime.manager.resumeRun(ipcSemanticDrift.id); await runtime.manager.waitForIdle();
    expect((await runtime.manager.getRun(ipcSemanticDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("IPC") });
    fakeMcp.setReadSemanticVersion(1);

    const releaseRace = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Release race", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(releaseRace.id); await openAndCheckpoint(releaseRace.id, "release-race");
    const releasesBeforeRace = fakeMcp.releasedCount();
    fakeMcp.setOnSessionClosed(() => { editorExitResolvers.at(-1)!(); });
    await expect(runtime.routes.ports!.inspector!.inspect(releaseRace.id, "release-race-inspection")).rejects.toBeDefined();
    fakeMcp.setOnSessionClosed(undefined); await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(fakeMcp.releasedCount()).toBe(releasesBeforeRace + 1);

    const abandonedPreflight = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Abandoned preflight", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(abandonedPreflight.id);
    const statePath = path.join(workspace, "flux-state.json");
    const stateBeforeAbandon = await readFile(statePath);
    const releasesBeforeAbandon = fakeMcp.releasedCount();
    const launchesBeforeAbandon = launchAttempts;
    fakeMcp.setOnAllocate(async () => { await writeFile(statePath, "{corrupt-after-preflight\n"); });
    try { await expect(runtime.manager.open(project.id, abandonedPreflight.id, "abandoned-preflight")).rejects.toBeDefined(); }
    finally { fakeMcp.setOnAllocate(undefined); await writeFile(statePath, stateBeforeAbandon); }
    expect(fakeMcp.releasedCount()).toBe(releasesBeforeAbandon + 1);
    expect(launchAttempts).toBe(launchesBeforeAbandon);

    const failedLaunch = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Launch failure", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(failedLaunch.id); rejectLaunch = true; const attemptsBeforeFailure = launchAttempts;
    await expect(runtime.manager.open(project.id, failedLaunch.id, "open-failure")).rejects.toThrow("spawn rejected before a process existed");
    expect((await runtime.manager.getRun(failedLaunch.id)).phase).toBe("opening");
    expect(launchAttempts).toBe(attemptsBeforeFailure + 1);
    await expect(runtime.manager.open(project.id, failedLaunch.id, "open-failure")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    expect(launchAttempts).toBe(attemptsBeforeFailure + 1);

    const uncertainPreflight = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Uncertain preflight", providerModel: { provider: "codex", model: "test", tier: "fast" }, iterationCap: 2, harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST, ...profiles });
    await runtime.manager.prepareRun(uncertainPreflight.id); uncertainIdentityProbe = true; const attemptsBeforeUncertain = launchAttempts;
    await expect(runtime.manager.open(project.id, uncertainPreflight.id, "open-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    expect((await runtime.manager.getRun(uncertainPreflight.id)).phase).toBe("blocked"); expect(launchAttempts).toBe(attemptsBeforeUncertain);
    uncertainIdentityProbe = false;
    await expect(runtime.manager.open(project.id, uncertainPreflight.id, "open-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    await expect(runtime.manager.open(project.id, uncertainPreflight.id, "different-open-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(launchAttempts).toBe(attemptsBeforeUncertain);
  });
});
