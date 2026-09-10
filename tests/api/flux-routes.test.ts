import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../../src/api/server.js";
import type { ApplicationService } from "../../src/application/application-service.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createProviderFailureDiagnostic, createProviderFailureEvidence, PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION, PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION, PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION } from "../../src/domain/diagnostics.js";
import { PcbDesignInterpreterError } from "../../src/harness/pcb-design-interpreter.js";
import { createPcbProviderProfileBinding } from "../../src/harness/pcb-design-interpreter.js";
import { createFluxDeepRuleSummary, createFluxOpenCheckpointReceipt, createFluxOpenPreflightReceipt, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, fluxDigest, fluxOpenPreparationDigest, FluxError, FluxRunManager, FluxRunStore, registerFluxRoutes, type FluxPreviewManifestBinding, type FluxRouteManager, type FluxRunDto, type FluxRunManagerOptions, type FluxRuntimePolicyDto } from "../../src/flux/index.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION, type FluxCheckpointFailureReceiptDto } from "../../src/flux/contracts.js";

const roots: string[] = [];
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const KICAD_TOOLCHAIN_IDENTITY = canonicalIdentity({ suite: "10.0.3", installation: "test" }, "evleda.test-kicad-toolchain.v1");
const INSPECTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-readonly" }, "evleda.kicad-mcp-inspection-bridge.v2");
const EXECUTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-write" }, "evleda.kicad-mcp-execution-bridge.v1");
const IPC_SOCKET_IDENTITY = canonicalIdentity({ socket: "run-bound" }, "evleda.kicad-api-socket-binding.v1");
const WRITE_SESSION_AUTHORITY_IDENTITY = canonicalIdentity({ mode: "write" }, "evleda.kicad-mcp-session-authority.v1");
const WRITE_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "write" }, "evleda.kicad-mcp-session-receipt.v1");
const IPC_PROBE_SEMANTIC_IDENTITY = canonicalIdentity({ result: "same" }, "evleda.flux-open-ipc-probe-semantic.v2");
const CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "checkpoint-read" }, "evleda.kicad-mcp-session-receipt.v1");
const EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "execution-read" }, "evleda.kicad-mcp-session-receipt.v1");
const inspectionSnapshot = (runId: string) => ({ runId, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
  ipcSocketIdentity: IPC_SOCKET_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, connectionBudget: { used: 1, remaining: 7, limit: 8 as const },
  state: "idle" as const, busy: false as const, completedTools: 0 as const, totalTools: 6 });
const headers = (key: string) => ({ host: "localhost:8765", "idempotency-key": key });
const defaultPolicy = (): FluxRuntimePolicyDto => ({ providerModel: { provider: "server-managed", model: "generic-contract", tier: "standard" }, iterationCap: { minimum: 1, maximum: 24, recommended: 12 }, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$", checkpointOpenRequiredForFresh: true, freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" });
const privateProviderFailure = () => createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", createProviderFailureEvidence({
  adapter: "codex", boundary: "cli_turn_output", leaf: "OUTER_JSON_INVALID", providerErrorClass: "MALFORMED",
  checkpoints: { outerBytesWithinLimit: true, outerJsonParsed: false, outerShapeClosed: false, outerVersionMatched: false, outerTypesValid: false,
    argumentsStringsWithinLimit: true, argumentsJsonParsed: false, argumentsWithinLimit: true, turnSchemaValid: false, messageSchemaValid: false,
    callSchemaValid: false, toolNamesAllowed: true, callIdsUnique: true, parallelPolicyValid: true, requiredToolValid: false, stopReasonValid: false, cleanupCompleted: true },
  identities: { adapter: canonicalIdentity({ adapter: "codex" }, PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION), parser: canonicalIdentity({ parser: "closed" }, PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION), transportSchema: canonicalIdentity({ transport: "cli" }, PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION) },
  observations: { outerBytes: 7, outerSha256: "1".repeat(64), argumentsBytes: null, argumentsSha256: null, issues: [{ path: "$", code: "INVALID_JSON", observedType: "string" }] },
}));
const deepPublicRun = (): FluxRunDto => {
  const fixture = createGenericDividerBundleFixture(); const bundle = fixture.bundle;
  const profile = createPcbProviderProfileBinding({ provider: "codex", model: "gpt-test", tier: "priority", adapterSchemaVersion: "evleda.test-provider-adapter.v1" });
  const receiptPayload = { schemaVersion: "evleda.flux-interpreter-receipt.v2" as const, interpreterSchemaVersion: "evleda.pcb-design-interpreter.v1", provider: profile.provider,
    providerProfile: profile, providerProfileIdentity: profile.identity, promptDigest: fluxDigest(bundle.executionPrompt.originalPrompt), clarificationDigest: fluxDigest([]),
    compilerProfileIdentity: bundle.compilerProfile.identity, practiceProfileBindingIdentity: bundle.practiceProfileBinding.identity, bundleIdentity: bundle.identity, compiledAt: "2026-09-07T00:00:00.000Z" };
  return { id: "run_deep_contract", projectId: "project_deep", threadId: "thread_deep", phase: "contract_ready", prompt: bundle.executionPrompt.originalPrompt,
    providerModel: { provider: profile.provider, model: profile.model, tier: profile.tier }, iterationCap: 12, harnessRuleIdentity: "deep-rule-harness", mutationAllowlist: ["fresh_apply_contract_connectivity"],
    freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "generic",
    contractState: { disposition: "ready", questions: [], issues: [], contract: bundle.contract, contractIdentity: bundle.contract.identity, libraryBindingIdentity: bundle.libraryBinding.identity,
      deepRuleBindingIdentity: bundle.deepRuleBinding.identity, deepRuleSummary: createFluxDeepRuleSummary(bundle.deepRuleBinding), acceptancePlanIdentity: bundle.acceptancePlan.identity,
      interpreterReceipt: { ...receiptPayload, identity: canonicalIdentity(receiptPayload, receiptPayload.schemaVersion) } }, compilationBundleRef: fixture.reference, reports: [],
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" };
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixture = async (policyFactory: () => unknown = defaultPolicy, managerOptions: Partial<Pick<FluxRunManagerOptions, "contractInterpreter" | "compilationBundleStore" | "lifecycleObserver">> = {}) => {
  const base = await mkdtemp(path.join(tmpdir(), "evleda-flux-api-"));
  roots.push(base);
  const sourceRoot = path.join(base, "source");
  const workspaceRoot = path.join(base, "workspace");
  const previewRoot = path.join(base, "preview");
  await Promise.all([mkdir(sourceRoot), mkdir(previewRoot)]);
  const artifactData = {
    "schematic.svg": Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8"),
    "board-top.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "board-bottom.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
  } as const;
  await Promise.all(Object.entries(artifactData).map(([name, bytes]) => writeFile(path.join(previewRoot, name), bytes)));
  const manifest: FluxPreviewManifestBinding = {
    root: previewRoot,
    refreshedAt: "2026-09-06T00:00:00.000Z",
    artifacts: [
      { kind: "schematic", relativePath: "schematic.svg", mediaType: "image/svg+xml", sizeBytes: artifactData["schematic.svg"].byteLength, sha256: digest(artifactData["schematic.svg"]) },
      { kind: "pcb_top", relativePath: "board-top.png", mediaType: "image/png", sizeBytes: artifactData["board-top.png"].byteLength, sha256: digest(artifactData["board-top.png"]) },
      { kind: "pcb_bottom", relativePath: "board-bottom.png", mediaType: "image/png", sizeBytes: artifactData["board-bottom.png"].byteLength, sha256: digest(artifactData["board-bottom.png"]) },
    ],
  };
  const inspectionKeys: string[] = [];
  const fluxManagerOptions: FluxRunManagerOptions = {
    workspaceRoot,
    activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY,
    activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY,
    activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
    sources: [{ key: "reference", label: "Reference", sourceRoot, fingerprint: "a".repeat(64) }],
    ports: {
      prepare: async () => ({ isolatedFingerprint: "b".repeat(64), checkpointRequired: false, freshNetClassPreparationEvidence: null, freshNetClassSemanticAuthority: null, freshProjectOpenPreparedSourceAuthority: null, preview: { title: "Safe preview", summary: "Candidate only", artifactCount: 3, digest: "c".repeat(64) } }),
      execute: async () => ({ disposition: "completed", reports: [{ title: "Candidate report", digest: "d".repeat(64), mediaType: "text/plain", executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, writeSessionReceiptIdentity: WRITE_SESSION_RECEIPT_IDENTITY, executionInspectionSessionReceiptIdentity: EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY }] }),
      preflightOpen: async ({ projectId, runId, preparation }) => createFluxOpenPreflightReceipt({ schemaVersion: "evleda.flux-open-preflight.v5", projectId, runId: runId!, preparationDigest: fluxOpenPreparationDigest(preparation!), suiteVersion: "10.0.3", installationRootIdentity: canonicalIdentity({ installation: "test" }, "evleda.test-kicad-installation-root.v1"), inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY, freshNetClassSemanticAuthorityIdentity: null, freshProjectOpenPreparedSourceAuthorityIdentity: null, freshNetClassPreparationEvidenceIdentity: null, kicadCli: { algorithm: "sha256", digest: "4".repeat(64), size: 1 }, pcbnew: { algorithm: "sha256", digest: "5".repeat(64), size: 1 }, board: { algorithm: "sha256", digest: "6".repeat(64), size: 1 } }),
      cancelOpenPreflight: async () => undefined,
      open: async () => ({ opened: true, label: "Opened candidate", checkpointRequired: true }),
      checkpointOpen: async (request) => ({ isolatedFingerprint: "b".repeat(64), checkpointRequired: false,
        preview: { title: "Safe preview", summary: "Candidate only", artifactCount: 3, digest: "c".repeat(64) },
        openCheckpointReceipt: createFluxOpenCheckpointReceipt({ schemaVersion: "evleda.flux-open-checkpoint.v6", runId: request.runId,
          openPreflightReceiptIdentity: request.openPreflightReceipt.identity, kicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
          ipcSocketIdentity: IPC_SOCKET_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY,
          isolatedFingerprint: "b".repeat(64), board: { algorithm: "sha256", digest: "7".repeat(64), size: 1 },
          editorLock: { algorithm: "sha256", digest: "8".repeat(64), size: 1 }, ipcProbeSemanticIdentity: IPC_PROBE_SEMANTIC_IDENTITY,
          checkpointInspectionSessionReceiptIdentity: CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY, freshNetClassSemanticAuthorityIdentity: null,
          freshProjectOpenPreparedSourceAuthorityIdentity: null, freshNetClassPreparationEvidenceIdentity: null }) }),
    },
    ...managerOptions,
  };
  const manager = new FluxRunManager(fluxManagerOptions);
  const app = Fastify();
  await registerFluxRoutes(app, {
    manager,
    policy: policyFactory as () => FluxRuntimePolicyDto,
    ports: {
      preview: { get: async () => manifest, refresh: async () => manifest },
      inspector: { snapshot: (runId) => inspectionSnapshot(runId), inspect: async (runId, key) => { inspectionKeys.push(`${runId}:${key}`); return inspectionSnapshot(runId); } },
    },
  });
  return { app, sourceRoot, workspaceRoot, previewRoot, manager, fluxManagerOptions, inspectionKeys };
};

describe("Flux local API routes", () => {
  it("serves the server-owned current policy without obsolete mutation tools", async () => {
    const { app } = await fixture(); const response = await app.inject({ method: "GET", url: "/api/v1/flux/policy" });
    expect(response.statusCode).toBe(200); expect(response.json().result).toMatchObject({ iterationCap: { minimum: 1, maximum: 24, recommended: 12 }, harnessRuleIdentity: "server-rule", checkpointOpenRequiredForFresh: true, freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$" });
    expect(response.body).toContain("fresh_apply_contract_connectivity"); expect(response.body).not.toContain("sch_add_no_connect"); await app.close();
  });

  it("admits only integer iteration caps inside the exact current server range", async () => {
    const { app } = await fixture();
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("cap-project"), payload: { sourceKey: "reference", name: "Caps" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("cap-thread"), payload: { title: "Caps" } })).json().result;
    const payload = (iterationCap: unknown) => ({ projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: defaultPolicy().providerModel,
      iterationCap, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" });
    for (const cap of [1, 12, 13, 24]) expect((await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers(`cap-valid-${cap}`), payload: payload(cap) })).statusCode).toBe(200);
    for (const cap of [0, 25, 1.5, "24", null]) expect((await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers(`cap-invalid-${String(cap)}`.replace(".", "_")), payload: payload(cap) })).statusCode).toBe(400);
    await app.close();
  });

  it("rejects malformed, extended, or drifted iteration policy objects", async () => {
    const malformedPolicies = [
      () => ({ ...defaultPolicy(), iterationCap: { minimum: 1, maximum: 25, recommended: 12 } }),
      () => ({ ...defaultPolicy(), iterationCap: { minimum: 1, maximum: 24, recommended: 24 } }),
      () => ({ ...defaultPolicy(), iterationCap: { minimum: 1, maximum: 24, recommended: 12, hidden: true } }),
      () => ({ ...defaultPolicy(), iterationCap: { minimum: 1, maximum: 12 } }),
      () => ({ ...defaultPolicy(), unexpected: true }),
      () => ({ ...defaultPolicy(), mutationAllowlist: ["z_tool", "a_tool"] }),
      () => ({ ...defaultPolicy(), mutationAllowlist: ["a_tool", "a_tool"] }),
      () => ({ ...defaultPolicy(), mutationAllowlist: ["../unsafe"] })
    ];
    for (const policy of malformedPolicies) {
      const { app } = await fixture(policy);
      expect((await app.inject({ method: "GET", url: "/api/v1/flux/policy" })).statusCode).toBe(400);
      await app.close();
    }
    let calls = 0;
    const { app } = await fixture(() => ++calls === 1 ? defaultPolicy() : ({ ...defaultPolicy(), iterationCap: { minimum: 1, maximum: 11, recommended: 11 } }));
    expect((await app.inject({ method: "GET", url: "/api/v1/flux/policy" })).statusCode).toBe(200);
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("drift-project"), payload: { sourceKey: "reference", name: "Drift" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("drift-thread"), payload: { title: "Drift" } })).json().result;
    const response = await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("drift-run"), payload: { projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: defaultPolicy().providerModel, iterationCap: 12, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" } });
    expect(response.statusCode).toBe(400); expect(response.json().error.message).toContain("iteration policy");
    await app.close();
  });

  it("rejects a browser-supplied provider/model/tier that differs from server policy", async () => {
    const { app } = await fixture();
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("generic-project"), payload: { sourceKey: "reference", name: "Generic" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("generic-thread"), payload: { title: "Generic" } })).json().result;
    const response = await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("generic-run"), payload: { projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: { provider: "codex", model: "arbitrary", tier: "priority" }, iterationCap: 2, harnessRuleIdentity: "rules", mutationAllowlist: ["pcb_add_track"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("server policy");
    await app.close();
  });

  it("replays a committed interpretation failure instead of returning operation-uncertain", async () => {
    let calls = 0;
    const providerFailure = privateProviderFailure();
    const { app, workspaceRoot, fluxManagerOptions } = await fixture(defaultPolicy, {
      contractInterpreter: { interpretCompilation: async () => { calls += 1; throw new PcbDesignInterpreterError("PROVIDER_FAILED", "The PCB design-intent provider failed.", providerFailure.diagnostic, providerFailure.providerFailureEvidence); } },
      compilationBundleStore: { put: async () => { throw new Error("must not store"); }, get: async () => { throw new Error("must not read"); } }
    });
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("failure-project"), payload: { sourceKey: "reference", name: "Failure" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("failure-thread"), payload: { title: "Failure" } })).json().result;
    const run = (await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("failure-run"), payload: { projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: defaultPolicy().providerModel, iterationCap: 1, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" } })).json().result;
    const first = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/interpret`, headers: headers("failure-interpret"), payload: {} });
    const firstBody = first.json();
    const firstError = firstBody.error;
    expect(first.statusCode).toBe(422);
    expect(Object.keys(firstBody).sort()).toEqual(["error", "ok", "requestId"]);
    expect(firstBody.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    expect(firstError).toMatchObject({ code: "STAGE_BLOCKED", retryable: false, diagnostic: { schemaVersion: "evleda.flux-diagnostic.v1", code: "PROVIDER_RESPONSE_INVALID" } });
    expect(Object.keys(firstError.diagnostic).sort()).toEqual(["code", "evidenceIdentity", "schemaVersion"]);
    const terminalReceipt = firstError.terminalFailureReceipt;
    expect(Object.keys(terminalReceipt).sort()).toEqual(["completedAt", "diagnosticIdentity", "idempotencyKey", "identity", "operation", "outcome", "projectId", "requestDigest", "runId", "schemaVersion", "terminalPhase", "threadId"]);
    expect(terminalReceipt).toMatchObject({ schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "interpret_run", idempotencyKey: "failure-interpret",
      requestDigest: fluxDigest({ runId: run.id, answers: [] }), projectId: project.id, threadId: thread.id, runId: run.id, terminalPhase: "blocked", outcome: "failed" });
    expect(terminalReceipt.diagnosticIdentity).toEqual(canonicalIdentity(firstError.diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION));
    const { identity: _terminalIdentity, ...terminalSubject } = terminalReceipt;
    expect(terminalReceipt.identity).toEqual(canonicalIdentity(terminalSubject, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION));
    expect(first.body).not.toContain("providerFailureEvidence"); expect(first.body).not.toContain("operationFailureEvidence"); expect(first.body).not.toContain(providerFailure.providerFailureEvidence.leaf); expect(first.body).not.toContain(providerFailure.providerFailureEvidence.observations.outerSha256!);
    const poll = (await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/poll?afterEventSeq=0` })).json().result;
    expect(poll.run.diagnostic).toEqual(firstError.diagnostic);
    expect(poll.events.find((entry: { kind: string }) => entry.kind === "run_blocked")?.diagnostic).toEqual(firstError.diagnostic);
    expect(JSON.stringify(poll)).not.toContain("providerFailureEvidence"); expect(JSON.stringify(poll)).not.toContain("operationFailureEvidence"); expect(JSON.stringify(poll)).not.toContain(providerFailure.providerFailureEvidence.leaf); expect(JSON.stringify(poll)).not.toContain(providerFailure.providerFailureEvidence.observations.outerSha256!);
    await app.close();

    const restarted = new FluxRunManager(fluxManagerOptions);
    const restartedApp = Fastify({ genReqId: () => "req-restarted-terminal" });
    await registerFluxRoutes(restartedApp, { manager: restarted, policy: defaultPolicy });
    const replay = await restartedApp.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/interpret`, headers: headers("failure-interpret"), payload: {} });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json().requestId).toBe("req-restarted-terminal"); expect(replay.json().requestId).not.toBe(firstBody.requestId);
    expect(replay.json().error).toEqual(firstError); expect(replay.json().error.code).not.toBe("OPERATION_UNCERTAIN"); expect(calls).toBe(1);
    expect(replay.json().error.terminalFailureReceipt.identity.digest).toBe(terminalReceipt.identity.digest);
    expect((await restartedApp.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}` })).json().result.diagnostic).toEqual(firstError.diagnostic);
    const persisted = await new FluxRunStore(workspaceRoot).read();
    expect(persisted.idempotency["failure-interpret"]).toMatchObject({ status: "failed", failure: { diagnostic: firstError.diagnostic }, terminalReceipt: { outcome: "failed" } });
    expect(Object.keys(persisted.operationFailureEvidence)).toHaveLength(1);
    await restartedApp.close();

    const receiptWithoutIdentity = ({ identity: _identity, ...value }: Record<string, unknown>) => value;
    const coherentlyChanged = (changes: Record<string, unknown>) => {
      const value = { ...receiptWithoutIdentity(terminalReceipt), ...changes };
      return { ...value, identity: canonicalIdentity(value, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION) };
    };
    const invalidReceipts = [
      { ...terminalReceipt, unexpected: true },
      coherentlyChanged({ projectId: "project_other" }),
      coherentlyChanged({ requestDigest: "f".repeat(64) }),
    ];
    for (const invalidReceipt of invalidReceipts) {
      const injectedManager = new Proxy(restarted, { get(target, property, receiver) {
        if (property === "interpretRun") return async () => { throw new FluxError("ILLEGAL_TRANSITION", firstError.message, {}, firstError.diagnostic, invalidReceipt as never); };
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      } }) as unknown as FluxRouteManager;
      const invalidApp = Fastify(); await registerFluxRoutes(invalidApp, { manager: injectedManager, policy: defaultPolicy });
      const invalidResponse = await invalidApp.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/interpret`, headers: headers("failure-interpret"), payload: {} });
      expect(invalidResponse.json().error.diagnostic).toEqual(firstError.diagnostic);
      expect(invalidResponse.json().error).not.toHaveProperty("terminalFailureReceipt");
      await invalidApp.close();
    }
  });

  it.each([
    ["INVALID_DRAFT", "PROVIDER_RESPONSE_INVALID"],
    ["COMPILER_FAILED", "TOOLCHAIN_FAILURE"],
  ] as const)("projects a closed %s interpreter class without exposing private evidence or error prose", async (interpreterErrorCode, diagnosticCode) => {
    const secret = `sk-private-${interpreterErrorCode} C:\\private\\model-turn.json`;
    const { app, workspaceRoot } = await fixture(defaultPolicy, {
      contractInterpreter: { interpretCompilation: async () => { throw new PcbDesignInterpreterError(interpreterErrorCode, secret); } },
      compilationBundleStore: { put: async () => { throw new Error("must not store"); }, get: async () => { throw new Error("must not read"); } },
    });
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers(`closed-${interpreterErrorCode}-project`), payload: { sourceKey: "reference", name: "Closed" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers(`closed-${interpreterErrorCode}-thread`), payload: { title: "Closed" } })).json().result;
    const run = (await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers(`closed-${interpreterErrorCode}-run`), payload: {
      projectId: project.id, threadId: thread.id, prompt: "Generic board", providerModel: defaultPolicy().providerModel, iterationCap: 1,
      harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1",
    } })).json().result;
    const response = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/interpret`, headers: headers(`closed-${interpreterErrorCode}-interpret`), payload: {} });
    const body = response.json();

    expect(response.statusCode).toBe(422);
    expect(body.error).toMatchObject({
      code: "STAGE_BLOCKED",
      retryable: false,
      diagnostic: { schemaVersion: "evleda.flux-diagnostic.v1", code: diagnosticCode },
      terminalFailureReceipt: { operation: "interpret_run", runId: run.id, terminalPhase: "blocked", outcome: "failed" },
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toMatch(/model-turn\.json|operationFailureEvidence|interpreterErrorCode|pcb_interpreter/iu);
    const publicRun = (await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}` })).json().result;
    expect(publicRun).toMatchObject({ phase: "blocked", diagnostic: body.error.diagnostic });
    expect(JSON.stringify(publicRun)).not.toMatch(/operationFailureEvidence|interpreterErrorCode|pcb_interpreter/iu);
    const persisted = await new FluxRunStore(workspaceRoot).read();
    expect(persisted.operationFailureEvidence[body.error.diagnostic.evidenceIdentity.digest]).toMatchObject({
      schemaVersion: "evleda.flux-pcb-interpreter-failure-evidence.v1",
      kind: "pcb_interpreter",
      interpreterErrorCode,
      diagnosticCode,
    });
    expect(JSON.stringify(persisted)).not.toContain(secret);
    await app.close();
  });

  it("projects deep canonical contracts identically across GET, contract, and poll without truncation", async () => {
    const value = await fixture(); await value.app.close(); const run = deepPublicRun();
    const manager = new Proxy(value.manager, { get(target, property, receiver) {
      if (property === "getRun") return async () => structuredClone(run);
      if (property === "runs") return async () => [structuredClone(run)];
      if (property === "events") return async () => [];
      if (property === "queueSnapshot") return async () => ({ queuedRunIds: [] });
      const member = Reflect.get(target, property, receiver) as unknown; return typeof member === "function" ? member.bind(target) : member;
    } }) as unknown as FluxRouteManager;
    const app = Fastify(); await registerFluxRoutes(app, { manager, policy: defaultPolicy });
    const direct = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}` });
    const contract = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/contract` });
    const poll = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/poll?afterEventSeq=0` });
    expect([direct.statusCode, contract.statusCode, poll.statusCode]).toEqual([200, 200, 200]);
    const directRun = direct.json().result; const pollRun = poll.json().result.run;
    expect(directRun).toEqual(run); expect(pollRun).toEqual(directRun); expect(contract.json().result).toEqual(directRun.contractState);
    expect(JSON.stringify(pollRun)).toBe(JSON.stringify(directRun)); expect(JSON.stringify(contract.json().result)).toBe(JSON.stringify(directRun.contractState));
    expect(direct.body).not.toContain("[truncated]");
    expect(directRun.contractState.contract.components[0].pins[0].assignment).toEqual({ kind: "net", net: "VIN" });
    const summary = directRun.contractState.deepRuleSummary; const { identity: _identity, ...summaryPayload } = summary;
    expect(summary.identity).toEqual(canonicalIdentity(summaryPayload, "evleda.flux-deep-rule-summary.v1"));
    expect(summary.selectedRuleIds).toEqual([...summary.selectedRuleIds].sort()); expect(summary.selectedCount).toBe(summary.selectedRuleIds.length);

    const contractString = (unsafe: string) => {
      const changed = structuredClone(run) as any; const nextContract = structuredClone(changed.contractState.contract);
      nextContract.components[0].value = unsafe; const { identity: _old, ...payload } = nextContract;
      nextContract.identity = canonicalIdentity(payload, nextContract.schemaVersion); changed.contractState.contract = nextContract; changed.contractState.contractIdentity = nextContract.identity; return changed;
    };
    const deepExtra: Record<string, unknown> = {}; let cursor = deepExtra; for (let depth = 0; depth < 70; depth += 1) { const next: Record<string, unknown> = {}; cursor.next = next; cursor = next; }
    const variants: readonly FluxRunDto[] = [
      { ...run, compilationBundle: { private: true } } as never,
      contractString("C:\\private\\board.kicad_pcb"),
      contractString("sk-proj-abcdefghijklmno"),
      { ...run, unexpected: deepExtra } as never,
      { ...run, prompt: "x".repeat(300_000) },
    ];
    for (const unsafeRun of variants) {
      const unsafeManager = new Proxy(manager, { get(target, property, receiver) { if (property === "getRun") return async () => unsafeRun; const member = Reflect.get(target, property, receiver) as unknown; return typeof member === "function" ? member.bind(target) : member; } }) as unknown as FluxRouteManager;
      const unsafeApp = Fastify(); await registerFluxRoutes(unsafeApp, { manager: unsafeManager, policy: defaultPolicy });
      const response = await unsafeApp.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}` });
      expect(response.statusCode).toBe(400); expect(response.body).not.toMatch(/board\.kicad_pcb|sk-proj-|operationFailureEvidence|compilationBundle/u); await unsafeApp.close();
    }
    await app.close();
  });
  it("runs the candidate lifecycle through injected manager ports without exposing private paths", async () => {
    const { app, sourceRoot, previewRoot, manager } = await fixture();
    const projectReply = await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("project-1"), payload: { sourceKey: "reference", name: "Controller" } });
    expect(projectReply.statusCode).toBe(200);
    const project = projectReply.json().result as { id: string };
    const threadReply = await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("thread-1"), payload: { title: "Main" } });
    const thread = threadReply.json().result as { id: string };
    const runReply = await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("run-1"), payload: { projectId: project.id, threadId: thread.id, prompt: "Build a safe controller", providerModel: { provider: "server-managed", model: "generic-contract", tier: "standard" }, iterationCap: 2, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "led_compatibility_fixture" } });
    const run = runReply.json().result as { id: string };
    expect(runReply.statusCode).toBe(200);
    const prepared = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/prepare`, headers: headers("prepare-1"), payload: {} });
    const preparedReplay = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/prepare`, headers: headers("prepare-1"), payload: {} });
    expect(preparedReplay.json().result).toEqual(prepared.json().result);
    const opened = await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/open`, headers: headers("open-1"), payload: { runId: run.id } });
    expect((await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/open`, headers: headers("open-1"), payload: { runId: run.id } })).json().result).toEqual(opened.json().result);
    const checkpointed = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/checkpoint-open`, headers: headers("checkpoint-1"), payload: {} });
    expect(checkpointed.statusCode).toBe(200); expect(checkpointed.json().result.phase).toBe("awaiting_approval");
    const subjectReply = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/approval` });
    const subject = subjectReply.json().result as { digest: string };
    const approved = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/approval`, headers: headers("approval-1"), payload: { subjectDigest: subject.digest } });
    const resumed = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/resume`, headers: headers("resume-1"), payload: {} });
    await manager.waitForIdle();
    expect((await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/approval`, headers: headers("approval-1"), payload: { subjectDigest: subject.digest } })).json().result).toEqual(approved.json().result);
    expect((await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/resume`, headers: headers("resume-1"), payload: {} })).json().result).toEqual(resumed.json().result);
    const poll = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/poll?afterEventSeq=0` });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().result.run.phase).toBe("completed");
    expect(poll.json().result.events.length).toBeGreaterThan(0);
    const terminalSubject = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/approval` });
    expect(terminalSubject.statusCode).toBe(200); expect(terminalSubject.json().result.digest).toBe(subject.digest);
    const reports = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/reports` });
    expect(reports.json().result.reports).toEqual([expect.objectContaining({ title: "Candidate report", mediaType: "text/plain" })]);
    const allJson = `${projectReply.body}${threadReply.body}${runReply.body}${subjectReply.body}${poll.body}${reports.body}`;
    expect(allJson).not.toContain(sourceRoot);
    expect(allJson).not.toContain(previewRoot);
    await app.close();
  });

  it("exposes only run-bound inspection with exact authority and an eight-connection budget", async () => {
    const value = await fixture(); const { app, manager } = value;
    const project = (await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("inspection-project"), payload: { sourceKey: "reference", name: "Inspection" } })).json().result;
    const thread = (await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("inspection-thread"), payload: { title: "Inspection" } })).json().result;
    const run = (await app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("inspection-run"), payload: { projectId: project.id, threadId: thread.id,
      prompt: "Inspect a benign PCB candidate", providerModel: defaultPolicy().providerModel, iterationCap: 2, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"],
      freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "led_compatibility_fixture" } })).json().result;
    await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/prepare`, headers: headers("inspection-prepare"), payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/open`, headers: headers("inspection-open"), payload: { runId: run.id } });
    await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/checkpoint-open`, headers: headers("inspection-checkpoint"), payload: {} });

    expect((await app.inject({ method: "GET", url: "/api/v1/flux/inspect" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/flux/inspect", headers: headers("global-inspection"), payload: {} })).statusCode).toBe(404);
    const get = await app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/inspection` });
    expect(get.statusCode).toBe(200); expect(get.json()).toMatchObject({ operation: "flux_inspection_snapshot", result: { runId: run.id,
      inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY,
      writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, connectionBudget: { used: 1, remaining: 7, limit: 8 }, totalTools: 6 } });
    expect((await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/inspection`, payload: {} })).statusCode).toBe(400);
    const post = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/inspection`, headers: headers("inspection-refresh"), payload: {} });
    expect(post.statusCode).toBe(200); expect(post.json()).toMatchObject({ operation: "flux_inspection", result: { runId: run.id, connectionBudget: { used: 1, remaining: 7, limit: 8 } } });
    expect(value.inspectionKeys).toEqual([`${run.id}:inspection-refresh`]);
    await app.close();

    const invalid = Fastify(); await registerFluxRoutes(invalid, { manager, policy: defaultPolicy, ports: { inspector: {
      snapshot: async (runId) => ({ ...inspectionSnapshot(runId), connectionBudget: { used: 2, remaining: 7, limit: 8 } } as never),
      inspect: async (runId) => inspectionSnapshot(runId),
    } } });
    const rejected = await invalid.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/inspection` });
    expect(rejected.statusCode).not.toBe(200); expect(rejected.body).not.toContain("endpoint"); await invalid.close();
    const mismatched = Fastify(); await registerFluxRoutes(mismatched, { manager, policy: defaultPolicy, ports: { inspector: {
      snapshot: async (runId) => ({ ...inspectionSnapshot(runId), ipcSocketIdentity: canonicalIdentity({ socket: "other" }, "evleda.kicad-api-socket-binding.v1") }),
      inspect: async (runId) => inspectionSnapshot(runId),
    } } });
    const mismatch = await mismatched.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/inspection` });
    expect(mismatch.statusCode).toBe(422); expect(mismatch.json().error.code).toBe("STAGE_BLOCKED"); await mismatched.close();
  });

  it("replays duplicate idempotency keys and rejects changed requests and invalid transitions", async () => {
    const { app } = await fixture();
    const first = await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("same-key"), payload: { sourceKey: "reference", name: "One" } });
    const repeat = await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("same-key"), payload: { sourceKey: "reference", name: "One" } });
    expect(repeat.json().result.id).toBe(first.json().result.id);
    const conflict = await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("same-key"), payload: { sourceKey: "reference", name: "Changed" } });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/flux/runs/run_not_real/resume", headers: headers("resume-missing"), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/flux/projects", payload: { sourceKey: "reference", name: "Missing header" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("closed"), payload: { sourceKey: "reference", name: "Closed", filesystemPath: "C:\\secret" } })).statusCode).toBe(400);
    await app.close();
  });

  it("serves only the exact manifest-bound preview kinds with integrity headers", async () => {
    const { app, previewRoot } = await fixture();
    const metadata = await app.inject({ method: "GET", url: "/api/v1/flux/runs/run_preview/preview" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).not.toContain(previewRoot);
    const served = await app.inject({ method: "GET", url: "/api/v1/flux/runs/run_preview/preview/schematic" });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/svg+xml");
    expect(served.headers["content-disposition"]).toContain("inline");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers.etag).toMatch(/^"sha256:[0-9a-f]{64}"$/u);
    expect((await app.inject({ method: "GET", url: "/api/v1/flux/runs/run_preview/preview/raw-file" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/flux/files?path=C:%5Csecret" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/flux/runs/run_preview/poll?path=C:%5Csecret" })).statusCode).toBe(400);
    await app.close();
  });

  it("inherits the server's loopback host guard and mounts unavailable production Flux capability", async () => {
    const app = await buildApiServer({ service: {} as ApplicationService });
    expect((await app.inject({ method: "GET", url: "/api/v1/flux/sources", headers: { host: "evil.example" } })).statusCode).toBe(403);
    const unavailable = await app.inject({ method: "GET", url: "/api/v1/flux/sources", headers: { host: "localhost:8765" } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("TOOLCHAIN_UNAVAILABLE");
    await app.close();
  });

  it("returns the authenticated checkpoint failure receipt unchanged across replay and restart", async () => {
    let calls = 0;
    const value = await fixture(defaultPolicy, { lifecycleObserver: ({ operation, phase }) => {
      if (operation === "checkpoint_open" && phase === "side_effect_completed") { calls += 1; throw new Error("private checkpoint dependency C:/secret/project.kicad_pcb"); }
    } });
    const project = await value.manager.createProject("reference", "Checkpoint failure"); const thread = await value.manager.createThread(project.id, "Failure");
    const run = await value.manager.createRun({ projectId: project.id, threadId: thread.id, prompt: "Build a safe controller", providerModel: defaultPolicy().providerModel,
      iterationCap: 2, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1",
      freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "led_compatibility_fixture" });
    await value.manager.prepareRun(run.id); await value.manager.open(project.id, run.id);
    const request = { method: "POST" as const, url: `/api/v1/flux/runs/${run.id}/checkpoint-open`, headers: headers("checkpoint-terminal"), payload: {} };
    const first = await value.app.inject(request);
    expect(first.statusCode).toBe(409); expect(first.json().error).toMatchObject({ code: "OPERATION_UNCERTAIN", retryable: false, details: {}, message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
    expect(first.body).not.toContain("secret"); expect(first.body).not.toContain("diagnostic");
    const terminal = first.json().error.terminalFailureReceipt as FluxCheckpointFailureReceiptDto; const { identity, ...payload } = terminal;
    expect(identity).toEqual(canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION));
    expect(terminal).toMatchObject({ operation: "checkpoint_open", idempotencyKey: "checkpoint-terminal", requestDigest: fluxDigest({ runId: run.id }),
      runId: run.id, projectId: project.id, threadId: thread.id, terminalPhase: "blocked", outcome: "failed",
      failureIdentity: canonicalIdentity({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION) });
    expect((await value.app.inject(request)).json().error).toEqual(first.json().error);
    const restartedApp = Fastify(); const restarted = new FluxRunManager(value.fluxManagerOptions); await registerFluxRoutes(restartedApp, { manager: restarted });
    try {
      expect((await restartedApp.inject(request)).json().error).toEqual(first.json().error);
      expect(await restarted.getRun(run.id)).toMatchObject({ phase: "blocked", checkpointRequired: true, updatedAt: terminal.completedAt, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
      expect((await restarted.events()).filter((item) => item.runId === run.id && item.kind === "run_blocked")).toHaveLength(1); expect(calls).toBe(1);
    } finally { await restartedApp.close(); await value.app.close(); }
  });

  it.each(["unknown_field", "wrong_key", "wrong_digest", "wrong_failure_identity", "wrong_identity", "wrong_run_phase", "wrong_timestamp", "wrong_message"])("omits an unauthenticated checkpoint failure receipt: %s", async (tamper) => {
    const completedAt = "2030-01-01T00:00:00.000Z";
    const run = { ...deepPublicRun(), phase: "blocked" as const, checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, updatedAt: completedAt };
    const payload = { schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open" as const, idempotencyKey: "checkpoint-key",
      requestDigest: fluxDigest({ runId: run.id }), projectId: run.projectId, threadId: run.threadId, runId: run.id,
      failureIdentity: canonicalIdentity({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION),
      terminalPhase: "blocked" as const, outcome: "failed" as const, completedAt };
    const receipt: Record<string, unknown> = { ...payload, identity: canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION) };
    if (tamper === "unknown_field") receipt.private = true;
    if (tamper === "wrong_key") receipt.idempotencyKey = "other-key";
    if (tamper === "wrong_digest") receipt.requestDigest = "f".repeat(64);
    if (tamper === "wrong_failure_identity") receipt.failureIdentity = canonicalIdentity({}, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION);
    if (tamper === "wrong_identity") receipt.identity = canonicalIdentity({}, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION);
    const app = Fastify(); await registerFluxRoutes(app, { manager: {
      initialize: async () => undefined,
      getRun: async () => ({ ...run, ...(tamper === "wrong_run_phase" ? { phase: "checkpointing" } : {}), ...(tamper === "wrong_timestamp" ? { updatedAt: "2030-01-02T00:00:00.000Z" } : {}) }),
      checkpointOpenRun: async () => { throw new FluxError("OPERATION_UNCERTAIN", tamper === "wrong_message" ? "untrusted failure" : FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, {}, undefined, receipt as unknown as FluxCheckpointFailureReceiptDto); },
    } as unknown as FluxRouteManager });
    try {
      const response = await app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/checkpoint-open`, headers: headers("checkpoint-key"), payload: {} });
      expect(response.statusCode).toBe(409); expect(response.json().error.terminalFailureReceipt).toBeUndefined();
    } finally { await app.close(); }
  });

  it("returns checkpoint timeout as a deterministic non-retryable operation-uncertain response", async () => {
    const app = Fastify();
    await registerFluxRoutes(app, { manager: { initialize: async () => undefined, checkpointOpenRun: async () => { throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE); } } as unknown as FluxRouteManager });
    const response = await app.inject({ method: "POST", url: "/api/v1/flux/runs/run_uncertain/checkpoint-open", headers: headers("uncertain-key"), payload: {} });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ ok: false, error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, retryable: false } });
    await app.close();
  });

  it("polls an interrupted post-intent Open as uncertain and restart-blocked without replaying a launch", async () => {
    let persistedIntents = 0;
    const value = await fixture(defaultPolicy, { lifecycleObserver: ({ phase, operation }) => {
      if (phase === "intent_persisted" && operation === "open_project") { persistedIntents += 1; throw new Error("simulated process loss before launch"); }
    } });
    const project = (await value.app.inject({ method: "POST", url: "/api/v1/flux/projects", headers: headers("opening-project"), payload: { sourceKey: "reference", name: "Opening recovery" } })).json().result;
    const thread = (await value.app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/threads`, headers: headers("opening-thread"), payload: { title: "Opening recovery" } })).json().result;
    const run = (await value.app.inject({ method: "POST", url: "/api/v1/flux/runs", headers: headers("opening-run"), payload: { projectId: project.id, threadId: thread.id,
      prompt: "Open a benign PCB candidate", providerModel: defaultPolicy().providerModel, iterationCap: 2, harnessRuleIdentity: "server-rule",
      mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "led_compatibility_fixture" } })).json().result;
    await value.app.inject({ method: "POST", url: `/api/v1/flux/runs/${run.id}/prepare`, headers: headers("opening-prepare"), payload: {} });
    const interrupted = await value.app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/open`, headers: headers("opening-open"), payload: { runId: run.id } });
    expect(interrupted.statusCode).toBe(503); expect(persistedIntents).toBe(1);
    const during = await value.app.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/poll?afterEventSeq=0` });
    expect(during.statusCode).toBe(200); expect(during.json().result.run.phase).toBe("opening");
    expect(during.json().result.events.some((entry: { kind: string }) => entry.kind === "run_opened")).toBe(false);
    const replay = await value.app.inject({ method: "POST", url: `/api/v1/flux/projects/${project.id}/open`, headers: headers("opening-open"), payload: { runId: run.id } });
    expect(replay.statusCode).toBe(409); expect(replay.json().error.code).toBe("OPERATION_UNCERTAIN"); expect(persistedIntents).toBe(1);
    await value.app.close();

    const restartedManager = new FluxRunManager({ ...value.fluxManagerOptions, lifecycleObserver: undefined } as never); await restartedManager.initialize();
    const restartedApp = Fastify(); await registerFluxRoutes(restartedApp, { manager: restartedManager, policy: defaultPolicy });
    const after = await restartedApp.inject({ method: "GET", url: `/api/v1/flux/runs/${run.id}/poll?afterEventSeq=0` });
    expect(after.statusCode).toBe(200); expect(after.json().result.run).toMatchObject({ phase: "blocked", blockedReason: expect.stringMatching(/interrupted|restarted/u) });
    expect(after.json().result.events.some((entry: { kind: string }) => entry.kind === "run_opened")).toBe(false);
    await restartedApp.close();
  });

  it("returns an explicit retryable response when private evidence capacity is exhausted", async () => {
    const value = await fixture(); await value.app.close();
    const manager = new Proxy(value.manager, { get(target, property, receiver) {
      if (property === "interpretRun") return async () => { throw new FluxError("EVIDENCE_CAPACITY", "Operation failure evidence capacity is exhausted; interpretation was not started"); };
      const member = Reflect.get(target, property, receiver) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    } }) as unknown as FluxRouteManager;
    const app = Fastify({ genReqId: () => "req-evidence-capacity" }); await registerFluxRoutes(app, { manager, policy: defaultPolicy });
    const response = await app.inject({ method: "POST", url: "/api/v1/flux/runs/run_capacity/interpret", headers: headers("capacity-key"), payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, requestId: "req-evidence-capacity", error: { code: "EVIDENCE_CAPACITY", message: "Operation failure evidence capacity is exhausted; interpretation was not started", retryable: true, details: {} } });
    await app.close();
  });
});
