import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PCB_AGENT_CLI_REPORT_SCHEMA_VERSION,
  PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION,
  computeGenericPcbAgentHarnessRuleIdentity,
  pcbAgentRequiredSessionTools,
  runPcbAgentCli as runActualPcbAgentCli,
  type PcbAgentCliDependencies,
  type PcbAgentCliExecution,
  type PcbAgentCliOptions,
  type PcbAgentCliReport
} from "../../src/cli/pcb-agent.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { runPcbAgentHarness, DEFAULT_PCB_HARNESS_VALIDATION_TOOLS } from "../../src/harness/pcb-agent-harness.js";
import { createSchematicRenderClearanceEvidence, type SchematicRenderClearanceEvidence } from "../../src/integrations/schematic-render-clearance.js";
import { schematicRenderCapture } from "../helpers/schematic-render-capture.js";
import { createPcbProviderProfileBinding } from "../../src/harness/pcb-design-interpreter.js";
import { createFreshNetClassPreparationEvidence, materializeFreshNetClasses, readFreshClearanceEvidence, readFreshNetClassSemanticAuthority } from "../../src/harness/fresh-clearance-evidence.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { fluxDigest, type FluxContractStateDto } from "../../src/flux/contracts.js";
import { FluxRunStore } from "../../src/flux/run-store.js";
import { createFluxRuntime } from "../../src/flux/runtime.js";
import type { KicadCliAdapter, KicadCliAdapterOptions, KicadExecutableIdentity, KicadPreviewExportResult } from "../../src/integrations/kicad-cli.js";
import { createGenericBundleFixture, createGenericDividerBundleFixture, genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { createFakeFluxKicadMcpRuntime } from "../helpers/flux-kicad-mcp-runtime.js";
import { createFakeFluxKicadToolchain } from "../helpers/flux-kicad-toolchain.js";

const roots: string[] = [];
const runningRoots = new Set<string>();
const temporaryRoot = path.resolve(tmpdir());
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    // A Vitest timeout does not cancel the asynchronous test body. Retain its
    // files so pending readback cannot turn the timeout into a secondary ENOENT.
    if (runningRoots.has(root)) {
      console.warn(`Retained unfinished generic runtime test workspace: ${root}`);
      return;
    }
    const relative = path.relative(temporaryRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Generic runtime test cleanup escaped its temporary root.");
    await rm(root, { recursive: true, force: true });
  }));
});
const withTestRoot = async (operation: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(temporaryRoot, "evleda-flux-generic-runtime-"));
  roots.push(root); runningRoots.add(root);
  try { await operation(root); }
  finally { runningRoots.delete(root); }
};
const clearanceBoardSource = (netNames: readonly string[]): string => `(kicad_pcb
  (version 20250316)
  (generator "pcbnew")
  (generator_version "10.0.3")
  (general)
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  ${netNames.map((name, index) => `(net ${index + 1} "${name}")`).join("\n  ")}
  ${netNames.map((name, index) => `(footprint "Test:Pad_${index + 1}" (layer "F.Cu") (at ${5 + index * 3} 5) (property "Reference" "X${index + 1}") (property "Value" "TEST") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net ${index + 1} "${name}")))`).join("\n  ")}
)
`;

describe("Flux generic runtime handoff", () => {
  // This aggregate replays more than ten filesystem-backed lifecycle scenarios.
  // Its bound is test-local and does not change the production checkpoint deadline.
  it("passes only the verified bundle workflow to the strict CLI union and uses its content digest path", async () => withTestRoot(async (root) => {
    const sources = path.join(root, "sources"); const workspace = path.join(root, "workspace"); await mkdir(sources);
    const kicad = await createFakeFluxKicadToolchain(root);
    const prompt = "Build a generic 10k/10k voltage divider candidate."; const fixture = createGenericDividerBundleFixture(prompt);
    const profile = createPcbProviderProfileBinding({ provider: "codex", model: "gpt-test", tier: "priority", adapterSchemaVersion: "evleda.test-provider.v1" });
    const publicStateFor = (bundleFixture: ReturnType<typeof createGenericDividerBundleFixture>): FluxContractStateDto => {
      const payload = { schemaVersion: "evleda.flux-interpreter-receipt.v2" as const, interpreterSchemaVersion: "evleda.pcb-design-interpreter.v1",
        provider: profile.provider, providerProfile: profile, providerProfileIdentity: profile.identity, promptDigest: fluxDigest(prompt), clarificationDigest: fluxDigest([]),
        compilerProfileIdentity: bundleFixture.bundle.compilerProfile.identity, practiceProfileBindingIdentity: bundleFixture.bundle.practiceProfileBinding.identity,
        bundleIdentity: bundleFixture.bundle.identity, compiledAt: "2026-09-06T00:00:00.000Z" };
      const interpreterReceipt = Object.freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
      return Object.freeze({ disposition: "ready", questions: [], issues: [], contract: bundleFixture.bundle.contract,
        contractIdentity: bundleFixture.bundle.contract.identity, libraryBindingIdentity: bundleFixture.bundle.libraryBinding.identity,
        deepRuleBindingIdentity: bundleFixture.bundle.deepRuleBinding.identity, acceptancePlanIdentity: bundleFixture.bundle.acceptancePlan.identity,
        interpreterReceipt });
    };
    let activeBundleFixture = fixture;
    const publicState = publicStateFor(fixture);
    const seen: PcbAgentCliOptions[] = [];
    const clearanceOrder: string[] = [];
    let tamperClearanceReport = false;
    let renderAttack: "clone" | "stale" | "missing-row" | undefined;
    let rejectPrepareSemanticReadback = false;
    const runCli = async (options: PcbAgentCliOptions, dependencies: PcbAgentCliDependencies = {}): Promise<PcbAgentCliExecution> => {
      seen.push(options);
      if (options.workflowKind !== "generic") throw new Error("expected generic workflow");
      expect(Object.hasOwn(options, "prompt")).toBe(false);
      expect(Object.hasOwn(options, "projectDir")).toBe(false);
      expect(canonicalJson(options.compilationBundleRef)).toBe(canonicalJson(activeBundleFixture.reference));
      expect(canonicalJson(options.compilationBundle)).toBe(canonicalJson(activeBundleFixture.bundle));
      expect(dependencies.compilationBundleDependencies).toBe(fixture.dependencies);
      expect(options.outputDir).toContain(path.join("compilations", activeBundleFixture.reference.contentIdentity.digest));
      if (options.mode === "prepare") return await runActualPcbAgentCli(options, dependencies);
      const project = path.join(options.outputDir, "project");
      const reportPath = path.join(options.outputDir, "pcb-agent-report.json");
      const prepareReport = JSON.parse(await readFile(reportPath, "utf8")) as PcbAgentCliReport;
      const freshProject = await prepareFreshProject({ outputDir: options.outputDir, name: options.newProjectName, resume: true, workflowKind: "generic", compilationBundle: options.compilationBundle, compilationBundleRef: options.compilationBundleRef });
      const workflowPayload = { schemaVersion: PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION, kind: "generic" as const,
        bundleRef: options.compilationBundleRef, contractIdentity: options.compilationBundle.contract.identity,
        libraryBindingIdentity: options.compilationBundle.libraryBinding.identity, deepRuleBindingIdentity: options.compilationBundle.deepRuleBinding.identity,
        practiceProfileBindingIdentity: options.compilationBundle.practiceProfileBinding.identity,
        acceptancePlanIdentity: options.compilationBundle.acceptancePlan.identity,
        executionPromptContentIdentity: options.compilationBundle.executionPrompt.textContentIdentity };
      let writeSessionIdentity: Readonly<{ readonly sessionReceiptIdentity: ReturnType<typeof canonicalIdentity> }> | undefined;
      const freshNetClassMaterialization = prepareReport.freshNetClassMaterialization!;
      const freshProjectOpenPreparedSourceAuthority = prepareReport.freshProjectOpenPreparedSourceAuthority!;
      const freshNetClassSemanticAuthority = await dependencies.freshDesignClearanceEvidencePort!.readSemanticAuthority({ bundle: options.compilationBundle, project: freshProject });
      const freshNetClassPreparationEvidence = createFreshNetClassPreparationEvidence(freshNetClassMaterialization, freshNetClassSemanticAuthority);
      expect(freshNetClassPreparationEvidence).toEqual(dependencies.expectedFreshNetClassPreparationEvidence);
      expect(freshProjectOpenPreparedSourceAuthority).toEqual(dependencies.expectedFreshProjectOpenPreparedSourceAuthority);
      let freshClearanceEvidenceReceipt: PcbAgentCliReport["freshClearanceEvidenceReceipt"];
      expect(dependencies.freshDesignClearanceEvidencePort?.kicad).toMatchObject({ path: kicad.cliPath, version: kicad.toolchain.kicadCli.operationalVersion, commit: kicad.toolchain.kicadCli.operationalCommit, sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size });
      expect(dependencies.createKicadCliAdapter).toBeTypeOf("function");
      const runtimeAdapterOutput = path.join(options.outputDir, ".runtime-adapter-output"); await mkdir(runtimeAdapterOutput, { recursive: true });
      const runtimeAdapter = await dependencies.createKicadCliAdapter!({ workspaceRoot: options.outputDir, projectRoot: project, outputRoot: runtimeAdapterOutput, executablePath: "C:\\attacker\\kicad-cli.exe", environment: { PATH: "C:\\attacker" } });
      expect(runtimeAdapter.identity).toMatchObject({ path: kicad.cliPath, sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size });
      expect(dependencies.sessionFactory).toBeTypeOf("function");
      const writeSession = await dependencies.sessionFactory!({ workspaceRoot: options.outputDir, projectRoot: project, outputRoot: path.join(options.outputDir, ".evleda-mcp-output"), mode: "write", freshProject: true, requiredTools: pcbAgentRequiredSessionTools(options) });
      expect((writeSession.identity as { launch?: { sessionAuthorityIdentity?: unknown } }).launch?.sessionAuthorityIdentity).toEqual(dependencies.sessionAuthorityIdentity);
      writeSessionIdentity = writeSession.identity as typeof writeSessionIdentity;
      await writeSession.close?.();
      await writeFile(freshProject.pcbPath, clearanceBoardSource(options.compilationBundle.contract.nets.map((net) => net.name)), "utf8");
      freshClearanceEvidenceReceipt = await dependencies.freshDesignClearanceEvidencePort!.read({ bundle: options.compilationBundle, project: freshProject });
      const snapshot = { schematic: contentIdentity(await readFile(freshProject.schematicPath)), pcb: contentIdentity(await readFile(freshProject.pcbPath)), projectSettings: contentIdentity(await readFile(path.join(project, `${freshProject.name}.kicad_pro`))) };
      let renderReceipt: SchematicRenderClearanceEvidence | undefined;
      const native = { run_erc: { status: "clean", findings: [] }, run_drc: { status: "clean", findings: [] }, pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 3, pads: 7, nets: 3, tracks: 1, shapes: 1 } }, pcb_visual_qa: { status: "clean", findings: [], footprint_count: 3, board_bounds: [0, 0, 30, 20] } };
      const harness = await runPcbAgentHarness({ userPrompt: "Transport fixture only", fixedRules: ["Fixture only; no native proof."], projectPath: project, reportPath, editsRequired: false, allowedToolNames: [{ name: "pcb_get_board_summary", description: "Read fixture", inputSchema: { type: "object" } }], maxIterations: 1 },
        { provider: "fixture", turn: async () => ({ message: { role: "assistant", content: "Validate fixture." }, stopReason: "completed", toolCalls: [] }) },
        { tools: Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS).map((name) => ({ name, description: name, inputSchema: { type: "object" } })), execute: async (call) => ({ toolCallId: call.id, content: JSON.stringify(native[call.name as keyof typeof native] ?? { status: "saved" }) }) },
        { captureValidationSource: async () => snapshot, completionGate: async (evidence) => {
          const sources = renderAttack === "stale" ? { ...snapshot, schematic: contentIdentity("stale schematic") } : snapshot;
          const expected = { sources, executable: dependencies.freshDesignClearanceEvidencePort!.kicad, validationSourceBindingIdentity: evidence.sourceBinding!.identity };
          const capture = schematicRenderCapture(expected, path.join(options.outputDir, "native-render")); await mkdir(capture.outputDirectory, { recursive: true }); await writeFile(capture.schematicSvg.path, capture.source);
          renderReceipt = createSchematicRenderClearanceEvidence(capture, expected); return { passed: true, missing: [] };
        } });
      expect(harness.status).toBe("completed");
      const report: PcbAgentCliReport = { schemaVersion: PCB_AGENT_CLI_REPORT_SCHEMA_VERSION,
        workflow: { ...workflowPayload, identity: canonicalIdentity(workflowPayload, workflowPayload.schemaVersion) },
        status: options.mode === "resume" ? "completed" : "needs_review", provider: options.provider, model: options.model,
        projectPaths: { sourceProjectPath: sources, isolatedProjectPath: project, outputPath: options.outputDir, reportPath },
        summary: "generic runtime fixture", ruleProfile: { harnessRuleIdentity: computeGenericPcbAgentHarnessRuleIdentity(options.compilationBundle) },
        harness, freshSchematicRenderClearanceEvidence: renderAttack === "clone" ? structuredClone(renderReceipt!) : renderReceipt!,
        freshAcceptance: { schemaVersion: "evleda.fresh-design-acceptance.v2", passed: true, contractIdentity: options.compilationBundle.contract.identity, acceptancePlanIdentity: options.compilationBundle.acceptancePlan.identity,
          requirements: options.compilationBundle.acceptancePlan.rows.filter((entry) => renderAttack !== "missing-row" || entry.id !== "schematic-render-clearance").map((entry) => ({ id: entry.id, kind: entry.kind, mandatory: true, status: "pass", detail: "Deterministic transport fixture only." })), missing: [],
          sourceHashes: { schematicSha256: snapshot.schematic.digest, pcbSha256: snapshot.pcb.digest, netlistSha256: contentIdentity("fixture native netlist").digest }, evidenceLimitations: ["Transport fixture only; not a native acceptance proof."] },
        ...(writeSessionIdentity === undefined ? {} : { sidecar: { identity: writeSessionIdentity }, writeSessionReceiptIdentity: writeSessionIdentity.sessionReceiptIdentity }),
        ...(freshNetClassMaterialization === undefined ? {} : { freshNetClassMaterialization }),
        freshNetClassSemanticAuthority,
        freshNetClassPreparationEvidence,
        freshProjectOpenPreparedSourceAuthority,
        ...(freshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt: tamperClearanceReport ? { ...freshClearanceEvidenceReceipt, evidenceLimitations: ["tampered"] } as never : freshClearanceEvidenceReceipt }) };
      await writeFile(reportPath, JSON.stringify(report));
      await freshProject.checkpointAfterReport(reportPath, report.status);
      return { report, reportPath, isolatedProjectPath: project, exitCode: 0 };
    };
    let previewExports = 0;
    let rejectClearanceAuthority = false;
    let rejectExecutionAdapter = false;
    const adapterConfigurations: KicadCliAdapterOptions[] = [];
    const previewDirectories: string[] = [];
    const createAdapter = async (options: KicadCliAdapterOptions): Promise<KicadCliAdapter> => {
      adapterConfigurations.push(options);
      return ({
      identity: { kind: "kicad-cli", path: kicad.cliPath, version: (rejectClearanceAuthority && options.outputRoot === options.workspaceRoot) || (rejectExecutionAdapter && path.basename(options.outputRoot ?? "") === ".runtime-adapter-output") ? "10.9.9" : kicad.toolchain.kicadCli.operationalVersion, commit: kicad.toolchain.kicadCli.operationalCommit, sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size, capabilityHelpSha256: "c".repeat(64), confirmedCapabilities: [] },
      exportPreviewArtifacts: async ({ outputDirectory }: { outputDirectory: string }): Promise<KicadPreviewExportResult> => {
        previewExports += 1;
        previewDirectories.push(outputDirectory);
        const schematicDir = path.join(outputDirectory, "schematic"); const renderDir = path.join(outputDirectory, "renders");
        await Promise.all([mkdir(schematicDir), mkdir(renderDir)]);
        const definitions = [["schematic/divider.svg", "<svg/>", "schematic/divider.svg"], ["renders/board-top.png", "top", "renders/board-top.png"], ["renders/board-bottom.png", "bottom", "renders/board-bottom.png"]] as const;
        const artifacts = [];
        for (const [relativePath, body] of definitions) {
          const target = path.join(outputDirectory, relativePath); await writeFile(target, body);
          artifacts.push({ path: target, relativePath, sizeBytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") });
        }
        return { classification: "candidate-preview", releaseAuthorized: false,
          executable: { kind: "kicad-cli", path: "redacted", version: "10.0.3", commit: "abcdef0", sha256: "a".repeat(64), sizeBytes: 1, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: [] },
          outputDirectory, sourceHashes: {}, invocations: [], artifacts };
      }
    } as unknown as KicadCliAdapter);
    };
    let launches = 0;
    const fakeMcp = createFakeFluxKicadMcpRuntime();
    const kicadMcpRuntime = fakeMcp.runtime;
    fakeMcp.setOnConnect((mode) => { clearanceOrder.push(`mcp-${mode}`); });
    const clearancePortFactory = (identity: KicadExecutableIdentity) => {
      return { kicad: identity,
        materialize: async ({ bundle, project }: Parameters<NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>["materialize"]>[0]) => { clearanceOrder.push("materialize"); return await materializeFreshNetClasses({ project, compilationBundle: bundle, kicad: identity }); },
        readSemanticAuthority: async ({ bundle, project }: Parameters<NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>["readSemanticAuthority"]>[0]) => { clearanceOrder.push("semantic"); if (rejectPrepareSemanticReadback) throw new Error("fixture semantic readback failure"); return await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad: identity }); },
        read: async ({ bundle, project }: Parameters<NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>["read"]>[0]) => { clearanceOrder.push("read"); return await readFreshClearanceEvidence({ project, compilationBundle: bundle, kicad: identity }); } };
    };
    const runtime = await createFluxRuntime({ EVLEDA_FLUX_SOURCE_ROOT: sources, EVLEDA_FLUX_WORKSPACE_ROOT: workspace }, {
      providerModel: { provider: profile.provider, model: profile.model, tier: profile.tier },
      kicadToolchain: kicad.toolchain,
      kicadMcpRuntime,
      runKicadCliIdentityProbe: kicad.runner,
      providerProfile: profile,
      contractInterpreter: { interpretCompilation: async () => ({ publicState: publicStateFor(activeBundleFixture), bundle: activeBundleFixture.bundle }) },
      compilationBundleDependencies: fixture.dependencies,
      createFreshDesignClearanceEvidencePort: clearancePortFactory,
      runCli: runCli as typeof import("../../src/cli/pcb-agent.js").runPcbAgentCli,
      checkpointOpen: async ({ expectedNetClassProjection, expectedPreparedSourceAuthority }) => { expect(expectedNetClassProjection?.netClasses.length).toBeGreaterThan(0); expect(expectedNetClassProjection?.contractNetAssignments.length).toBe(fixture.bundle.contract.nets.length); expect(expectedPreparedSourceAuthority?.schemaVersion).toBe("evleda.fresh-project-open-prepared-source-authority.v1"); return { changed: false, checkpointPath: "redacted" }; },
      createAdapter: createAdapter as typeof KicadCliAdapter.create,
      launchPcbEditor: async ({ boardPath }) => { launches += 1; await writeFile(path.join(path.dirname(boardPath), `~${path.basename(boardPath)}.lck`), "{\"fixture\":true}\n"); return { pid: process.pid, exited: new Promise<never>(() => undefined) }; },
      isPcbEditorProcessAlive: () => true,
    });
    const source = (await runtime.manager.sources()).find((entry) => entry.label === "New KiCad project")!;
    const project = await runtime.manager.createProject(source.key, "Divider"); const thread = await runtime.manager.createThread(project.id, "Divider");
    const policy = runtime.routes.policy!();
    const run = await runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt,
      providerModel: policy.providerModel, iterationCap: 2, harnessRuleIdentity: policy.harnessRuleIdentity,
      mutationAllowlist: policy.mutationAllowlist, freshAcceptanceProfileIdentity: policy.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: policy.freshPersistenceProfileIdentity, workflowKind: "generic" });
    await runtime.manager.interpretRun(run.id); const prepared = await runtime.manager.prepareRun(run.id);
    expect(prepared.phase).toBe("awaiting_open");
    expect(clearanceOrder).toEqual(["materialize", "semantic"]);
    expect(fakeMcp.connectionCount()).toBe(0); expect(launches).toBe(0);
    const preparedProjectRoot = path.join(workspace, "runs", run.id, "compilations", fixture.reference.contentIdentity.digest, "project");
    expect(await readFile(path.join(preparedProjectRoot, `${`flux-${run.id.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(-32)}`}.kicad_pro`), "utf8")).toContain("EVLEDA_");
    const initialPreview = await runtime.routes.ports!.preview!.get(run.id);
    const initialAuthorityRoot = path.dirname(path.dirname(initialPreview.root));
    expect(path.dirname(initialAuthorityRoot)).toBe(path.join(workspace, "preview-revisions"));
    const initialMarker = JSON.parse(await readFile(path.join(initialAuthorityRoot, "authority.json"), "utf8")) as Record<string, unknown>;
    expect(initialMarker).toMatchObject({ runId: run.id, workflowKind: "generic", authorityDigest: fixture.reference.contentIdentity.digest, compilationBundleIdentity: fixture.bundle.identity, providerProfileIdentity: profile.identity });
    expect(adapterConfigurations.find((entry) => entry.outputRoot === initialAuthorityRoot)).toMatchObject({
      workspaceRoot: path.join(workspace, "runs", run.id, "compilations", fixture.reference.contentIdentity.digest),
      outputRoot: initialAuthorityRoot,
    });
    expect(previewDirectories[0]).toBe(initialPreview.root);
    if (process.platform === "win32") expect(previewDirectories[0]!.length).toBeLessThanOrEqual(247);
    await runtime.manager.open(project.id, run.id); await runtime.manager.checkpointOpenRun(run.id);
    const approval = await runtime.manager.approvalSubject(run.id);
    expect(approval.subject.freshAcceptanceProfileIdentity).not.toContain("led");
    expect(approval.subject.harnessRuleIdentity).toBe(computeGenericPcbAgentHarnessRuleIdentity(fixture.bundle));
    expect(approval.subject).toMatchObject({
      freshNetClassPreparationEvidenceIdentity: { schemaVersion: "evleda.fresh-netclass-preparation-evidence.v2" },
      freshNetClassSemanticAuthorityIdentity: { schemaVersion: "evleda.fresh-netclass-semantic-authority.v2" },
      freshProjectOpenPreparedSourceAuthorityIdentity: { schemaVersion: "evleda.fresh-project-open-prepared-source-authority.v1" },
    });
    await runtime.manager.approveRun(run.id, approval.digest);
    await runtime.manager.resumeRun(run.id); await runtime.manager.waitForIdle();
    const completed = await runtime.manager.getRun(run.id);
    expect(completed.phase, completed.blockedReason).toBe("completed");
    expect(completed.reports[0]?.freshClearanceEvidenceBinding).toMatchObject({
      schemaVersion: "evleda.flux-fresh-clearance-evidence-binding.v2",
      kicad: { kind: "kicad-cli", version: kicad.toolchain.kicadCli.operationalVersion, commit: kicad.toolchain.kicadCli.operationalCommit },
      materializationIdentity: { schemaVersion: "evleda.fresh-netclass-materialization.v2" },
      receiptIdentity: { schemaVersion: "evleda.fresh-clearance-evidence-receipt.v2" },
      semanticAuthorityIdentity: { schemaVersion: "evleda.fresh-netclass-semantic-authority.v2" },
    });
    expect(completed.reports[0]).toMatchObject({
      executionBridgeIdentity: kicadMcpRuntime.executionBridgeIdentity,
      writeSessionAuthorityIdentity: expect.objectContaining({ schemaVersion: "evleda.kicad-mcp-session-authority.v1" }),
      writeSessionReceiptIdentity: expect.objectContaining({ schemaVersion: "evleda.kicad-mcp-session-receipt.v1" }),
      executionInspectionSessionReceiptIdentity: expect.objectContaining({ schemaVersion: "evleda.kicad-mcp-session-receipt.v1" }),
    });
    expect(JSON.stringify(completed.reports[0]?.freshClearanceEvidenceBinding)).not.toContain(kicad.cliPath);
    expect(JSON.stringify(completed)).not.toContain("freshClearanceEvidenceReceipt");
    expect(JSON.stringify(completed)).not.toContain("contractNetAssignments");
    const completedPrivate = (await new FluxRunStore(workspace).read()).runs[run.id];
    expect(completedPrivate?.freshClearanceEvidenceReceipt?.identity).toEqual(completed.reports[0]?.freshClearanceEvidenceBinding?.receiptIdentity);
    const publicClearanceBinding = completed.reports[0]?.freshClearanceEvidenceBinding;
    expect(completedPrivate?.freshNetClassSemanticAuthority?.identity).toEqual(publicClearanceBinding !== undefined && "semanticAuthorityIdentity" in publicClearanceBinding ? publicClearanceBinding.semanticAuthorityIdentity : undefined);
    expect(seen.map((entry) => entry.mode)).toEqual(["prepare", "resume"]);
    expect(seen.every((entry) => entry.workflowKind === "generic" && !Object.hasOwn(entry, "prompt") && !Object.hasOwn(entry, "projectDir"))).toBe(true);
    expect(launches).toBe(1);
    expect(clearanceOrder.filter((entry) => entry === "materialize")).toHaveLength(1);
    expect(clearanceOrder.indexOf("mcp-readonly")).toBeGreaterThan(clearanceOrder.indexOf("semantic"));
    expect(clearanceOrder.lastIndexOf("semantic")).toBeLessThan(clearanceOrder.indexOf("mcp-write"));
    expect(clearanceOrder.lastIndexOf("read")).toBeGreaterThan(clearanceOrder.indexOf("mcp-write"));
    const injectedAdapterConfiguration = adapterConfigurations.find((entry) => path.basename(entry.outputRoot ?? "") === ".runtime-adapter-output")!;
    expect(injectedAdapterConfiguration).toMatchObject({ executablePath: kicad.cliPath, expectedExecutableIdentity: { sha256: kicad.toolchain.kicadCli.contentIdentity.digest, sizeBytes: kicad.toolchain.kicadCli.contentIdentity.size }, runner: kicad.runner });
    expect(injectedAdapterConfiguration.environment).not.toHaveProperty("PATH");
    expect(await runtime.routes.ports!.inspector!.inspect(run.id, "post-authoring-inspection")).toMatchObject({ state: "ready", runId: run.id });
    const postAuthoringConnections = fakeMcp.connectionCount();
    await writeFile(path.join(preparedProjectRoot, "sym-lib-table"), "(sym_lib_table (version 7))\n");
    await expect(runtime.routes.ports!.inspector!.inspect(run.id, "post-authoring-table-drift")).rejects.toBeDefined();
    expect(fakeMcp.connectionCount()).toBe(postAuthoringConnections);

    const makeRun = async () => runtime.manager.createRun({ projectId: project.id, threadId: thread.id, prompt,
      providerModel: policy.providerModel, iterationCap: 2, harnessRuleIdentity: policy.harnessRuleIdentity,
      mutationAllowlist: policy.mutationAllowlist, freshAcceptanceProfileIdentity: policy.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: policy.freshPersistenceProfileIdentity, workflowKind: "generic" });
    const stale = await makeRun(); await runtime.manager.interpretRun(stale.id); await runtime.manager.prepareRun(stale.id);
    await runtime.manager.open(project.id, stale.id); await runtime.manager.checkpointOpenRun(stale.id);
    await runtime.routes.ports!.inspector!.inspect(stale.id, "stable-inspection-key");
    const stalePreview = await runtime.routes.ports!.preview!.get(stale.id);
    const staleAuthorityBefore = path.dirname(path.dirname(stalePreview.root));
    const exportsBeforeReinterpret = previewExports;
    const alternateDraft = structuredClone(genericDividerDraft()); alternateDraft.netClasses[0]!.traceWidthMm = 0.3;
    const alternateFixture = createGenericBundleFixture(alternateDraft, prompt);
    activeBundleFixture = alternateFixture;
    expect((await runtime.manager.interpretRun(stale.id)).phase).toBe("contract_ready");
    await expect(runtime.routes.ports!.preview!.get(stale.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(runtime.routes.ports!.inspector!.snapshot(stale.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(runtime.routes.ports!.inspector!.inspect(stale.id, "stale-inspect")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(previewExports).toBe(exportsBeforeReinterpret);
    expect((await runtime.manager.prepareRun(stale.id)).phase).toBe("awaiting_open");
    const alternatePreview = await runtime.routes.ports!.preview!.get(stale.id);
    const staleAuthorityAfter = path.dirname(path.dirname(alternatePreview.root));
    expect(staleAuthorityAfter).not.toBe(staleAuthorityBefore);
    expect(JSON.parse(await readFile(path.join(staleAuthorityAfter, "authority.json"), "utf8"))).toMatchObject({
      runId: stale.id,
      authorityDigest: alternateFixture.reference.contentIdentity.digest,
      compilationBundleIdentity: alternateFixture.bundle.identity,
    });
    await runtime.manager.open(project.id, stale.id); await runtime.manager.checkpointOpenRun(stale.id);
    await expect(runtime.routes.ports!.inspector!.inspect(stale.id, "stable-inspection-key")).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    activeBundleFixture = fixture;

    const profileDrift = await makeRun(); await runtime.manager.interpretRun(profileDrift.id); await runtime.manager.prepareRun(profileDrift.id);
    await runtime.manager.open(project.id, profileDrift.id); await runtime.manager.checkpointOpenRun(profileDrift.id);
    const profileDriftApproval = await runtime.manager.approvalSubject(profileDrift.id); await runtime.manager.approveRun(profileDrift.id, profileDriftApproval.digest);
    const callsBeforeProfileRestart = seen.length;
    const replacementProfile = createPcbProviderProfileBinding({ provider: profile.provider, model: profile.model, tier: profile.tier, adapterSchemaVersion: "evleda.test-provider.v2" });
    const restarted = await createFluxRuntime({ EVLEDA_FLUX_SOURCE_ROOT: sources, EVLEDA_FLUX_WORKSPACE_ROOT: workspace }, {
      providerModel: { provider: replacementProfile.provider, model: replacementProfile.model, tier: replacementProfile.tier },
      kicadToolchain: kicad.toolchain,
      kicadMcpRuntime,
      runKicadCliIdentityProbe: kicad.runner,
      providerProfile: replacementProfile,
      contractInterpreter: { interpretCompilation: async () => ({ publicState, bundle: fixture.bundle }) },
      compilationBundleDependencies: fixture.dependencies,
      createFreshDesignClearanceEvidencePort: clearancePortFactory,
      runCli: runCli as typeof import("../../src/cli/pcb-agent.js").runPcbAgentCli,
      checkpointOpen: async ({ expectedNetClassProjection, expectedPreparedSourceAuthority }) => { expect(expectedNetClassProjection).toBeDefined(); expect(expectedPreparedSourceAuthority).toBeDefined(); return { changed: false, checkpointPath: "redacted" }; },
      createAdapter: createAdapter as typeof KicadCliAdapter.create,
      launchPcbEditor: async ({ boardPath }) => { launches += 1; await writeFile(path.join(path.dirname(boardPath), `~${path.basename(boardPath)}.lck`), "{\"fixture\":true}\n"); return { pid: process.pid, exited: new Promise<never>(() => undefined) }; },
      isPcbEditorProcessAlive: () => true,
    });
    expect((await restarted.manager.getRun(profileDrift.id))).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("provider") });
    await expect(restarted.manager.resumeRun(profileDrift.id)).rejects.toBeDefined();
    expect(seen).toHaveLength(callsBeforeProfileRestart);

    const clearanceDrift = await makeRun(); await runtime.manager.interpretRun(clearanceDrift.id); await runtime.manager.prepareRun(clearanceDrift.id);
    await runtime.manager.open(project.id, clearanceDrift.id); await runtime.manager.checkpointOpenRun(clearanceDrift.id);
    const clearanceApproval = await runtime.manager.approvalSubject(clearanceDrift.id); await runtime.manager.approveRun(clearanceDrift.id, clearanceApproval.digest);
    const callsBeforeClearanceDrift = seen.length; const connectionsBeforeClearanceDrift = fakeMcp.connectionCount(); rejectClearanceAuthority = true;
    await runtime.manager.resumeRun(clearanceDrift.id); await runtime.manager.waitForIdle(); rejectClearanceAuthority = false;
    expect((await runtime.manager.getRun(clearanceDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("toolchain authority") });
    expect(seen).toHaveLength(callsBeforeClearanceDrift); expect(fakeMcp.connectionCount()).toBe(connectionsBeforeClearanceDrift);

    const executionAdapterDrift = await makeRun(); await runtime.manager.interpretRun(executionAdapterDrift.id); await runtime.manager.prepareRun(executionAdapterDrift.id);
    await runtime.manager.open(project.id, executionAdapterDrift.id); await runtime.manager.checkpointOpenRun(executionAdapterDrift.id);
    const executionAdapterApproval = await runtime.manager.approvalSubject(executionAdapterDrift.id); await runtime.manager.approveRun(executionAdapterDrift.id, executionAdapterApproval.digest);
    const connectionsBeforeExecutionAdapterDrift = fakeMcp.connectionCount(); rejectExecutionAdapter = true;
    await runtime.manager.resumeRun(executionAdapterDrift.id); await runtime.manager.waitForIdle(); rejectExecutionAdapter = false;
    expect((await runtime.manager.getRun(executionAdapterDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("adapter") });
    expect(fakeMcp.connectionCount()).toBe(connectionsBeforeExecutionAdapterDrift + 1);

    const clearanceReportDrift = await makeRun(); await runtime.manager.interpretRun(clearanceReportDrift.id); await runtime.manager.prepareRun(clearanceReportDrift.id);
    await runtime.manager.open(project.id, clearanceReportDrift.id); await runtime.manager.checkpointOpenRun(clearanceReportDrift.id);
    const clearanceReportApproval = await runtime.manager.approvalSubject(clearanceReportDrift.id); await runtime.manager.approveRun(clearanceReportDrift.id, clearanceReportApproval.digest);
    tamperClearanceReport = true; await runtime.manager.resumeRun(clearanceReportDrift.id); await runtime.manager.waitForIdle(); tamperClearanceReport = false;
    expect((await runtime.manager.getRun(clearanceReportDrift.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("clearance evidence") });
    for (const attack of ["clone", "stale", "missing-row"] as const) {
      const rejected = await makeRun(); await runtime.manager.interpretRun(rejected.id); await runtime.manager.prepareRun(rejected.id);
      await runtime.manager.open(project.id, rejected.id); await runtime.manager.checkpointOpenRun(rejected.id);
      const subject = await runtime.manager.approvalSubject(rejected.id); await runtime.manager.approveRun(rejected.id, subject.digest);
      renderAttack = attack; await runtime.manager.resumeRun(rejected.id); await runtime.manager.waitForIdle(); renderAttack = undefined;
      expect(await runtime.manager.getRun(rejected.id), attack).toMatchObject({ phase: "failed", reports: [] });
    }
    const launchesBeforePathAttacks = launches;

    const swapped = await makeRun(); await runtime.manager.interpretRun(swapped.id); await runtime.manager.prepareRun(swapped.id);
    const swappedProject = path.join(workspace, "runs", swapped.id, "compilations", fixture.reference.contentIdentity.digest, "project");
    const swappedPcb = path.join(swappedProject, (await readdir(swappedProject)).find((entry) => entry.endsWith(".kicad_pcb"))!);
    const sameBytes = await readFile(swappedPcb); await rename(swappedPcb, `${swappedPcb}.replaced`); await writeFile(swappedPcb, sameBytes);
    await expect(runtime.manager.open(project.id, swapped.id)).rejects.toMatchObject({ code: "OPEN_PREFLIGHT_FAILED" });
    expect(launches).toBe(launchesBeforePathAttacks);

    const coherentCheckpointTamper = await makeRun(); await runtime.manager.interpretRun(coherentCheckpointTamper.id); await runtime.manager.prepareRun(coherentCheckpointTamper.id);
    const tamperedOutput = path.join(workspace, "runs", coherentCheckpointTamper.id, "compilations", fixture.reference.contentIdentity.digest);
    const tamperedProject = path.join(tamperedOutput, "project");
    const tamperedSchematic = path.join(tamperedProject, (await readdir(tamperedProject)).find((entry) => entry.endsWith(".kicad_sch"))!);
    await writeFile(tamperedSchematic, `${await readFile(tamperedSchematic, "utf8")}coherent-tamper\n`);
    const checkpointPath = path.join(tamperedOutput, ".evleda-pcb-agent-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as { files: { sch: { sha256: string } } };
    checkpoint.files.sch.sha256 = createHash("sha256").update(await readFile(tamperedSchematic)).digest("hex");
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const connectionsBeforeCoherentTamper = fakeMcp.connectionCount();
    await expect(runtime.manager.open(project.id, coherentCheckpointTamper.id)).rejects.toMatchObject({ code: "OPEN_PREFLIGHT_FAILED" });
    expect(launches).toBe(launchesBeforePathAttacks); expect(fakeMcp.connectionCount()).toBe(connectionsBeforeCoherentTamper);

    const failedSemanticPrepare = await makeRun(); await runtime.manager.interpretRun(failedSemanticPrepare.id);
    const connectionsBeforeFailedSemantic = fakeMcp.connectionCount(); const launchesBeforeFailedSemantic = launches;
    rejectPrepareSemanticReadback = true;
    try { await expect(runtime.manager.prepareRun(failedSemanticPrepare.id)).rejects.toBeDefined(); }
    finally { rejectPrepareSemanticReadback = false; }
    expect(fakeMcp.connectionCount()).toBe(connectionsBeforeFailedSemantic); expect(launches).toBe(launchesBeforeFailedSemantic);

    const relocated = await makeRun(); await runtime.manager.interpretRun(relocated.id); await runtime.manager.prepareRun(relocated.id);
    const relocatedProject = path.join(workspace, "runs", relocated.id, "compilations", fixture.reference.contentIdentity.digest, "project");
    const outsideProject = path.join(root, "same-content-relocated-project"); await cp(relocatedProject, outsideProject, { recursive: true });
    await rename(relocatedProject, `${relocatedProject}.bound`); await symlink(outsideProject, relocatedProject, "junction");
    await expect(runtime.manager.open(project.id, relocated.id)).rejects.toMatchObject({ code: "OPEN_PREFLIGHT_FAILED" });
    expect(launches).toBe(launchesBeforePathAttacks);
  }), 180_000);
});
