import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { fluxDigest, type FluxContractStateDto, type FluxProjectDto, type FluxRunDto, type FluxRuntimePolicyDto, type FluxSourceCatalogDto, type FluxThreadDto } from "../../src/flux/contracts.js";
import { createFluxDeepRuleSummary } from "../../src/flux/deep-rule-summary.js";
import { createPcbProviderProfileBinding } from "../../src/harness/pcb-design-interpreter.js";
import { createGenericDividerBundleFixture } from "./generic-divider-bundle.js";

export const FIXTURE_TIME = "2026-09-07T00:00:00.000Z";
export const FIXTURE_SOURCE: FluxSourceCatalogDto = Object.freeze({ key: "reference", label: "Reference", fingerprint: "a".repeat(64) });
export const FIXTURE_POLICY: FluxRuntimePolicyDto = Object.freeze({
  providerModel: Object.freeze({ provider: "codex", model: "gpt-test", tier: "priority" }),
  iterationCap: Object.freeze({ minimum: 1, maximum: 24, recommended: 12 }),
  harnessRuleIdentity: "harness-v2",
  mutationAllowlist: Object.freeze(["fresh_apply_contract_connectivity", "pcb_add_track"]),
  freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$",
  checkpointOpenRequiredForFresh: true,
  freshAcceptanceProfileIdentity: "acceptance-v2",
  freshPersistenceProfileIdentity: "persistence-v2",
});

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

export interface FakeFluxRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

export class FakeFluxControlServer {
  public policy: FluxRuntimePolicyDto = structuredClone(FIXTURE_POLICY);
  public sources: FluxSourceCatalogDto[] = [structuredClone(FIXTURE_SOURCE)];
  public projects: FluxProjectDto[] = [];
  public threads: FluxThreadDto[] = [];
  public runs: FluxRunDto[] = [];
  public readonly requests: FakeFluxRequest[] = [];
  public loseNextMutationResponse = false;
  public interpretNeedsClarification = false;
  public inspectionBudgetUsed = 0;
  public mutateResponse: ((envelope: Record<string, unknown>, request: FakeFluxRequest) => Record<string, unknown>) | undefined;
  readonly #idempotent = new Map<string, Readonly<{ operation: string; result: unknown }>>();
  readonly #inspectionSnapshots = new Map<string, Record<string, unknown>>();
  #request = 0;

  public addProject(id = "project_fixture", name = "Fixture"): FluxProjectDto {
    const project = Object.freeze({ id, sourceKey: "reference", name, createdAt: FIXTURE_TIME }); this.projects.push(project); return project;
  }

  public addThread(projectId: string, id = "thread_fixture", title = "Fixture"): FluxThreadDto {
    const thread = Object.freeze({ id, projectId, title, createdAt: FIXTURE_TIME }); this.threads.push(thread); return thread;
  }

  public addRun(projectId: string, threadId: string, phase: FluxRunDto["phase"] = "draft", prompt = "private fixture prompt", id = "run_fixture"): FluxRunDto {
    const run: FluxRunDto = Object.freeze({
      id, projectId, threadId, phase, prompt,
      providerModel: structuredClone(this.policy.providerModel), iterationCap: 12,
      harnessRuleIdentity: this.policy.harnessRuleIdentity, mutationAllowlist: [...this.policy.mutationAllowlist],
      freshAcceptanceProfileIdentity: this.policy.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: this.policy.freshPersistenceProfileIdentity,
      ...(phase === "awaiting_clarification" ? { contractState: this.#pendingContractState(prompt) } : {}),
      workflowKind: "generic", reports: [], createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
    });
    this.runs.push(run); return run;
  }

  public replaceRun(id: string, changes: Partial<FluxRunDto>): FluxRunDto {
    const index = this.runs.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("unknown fake run");
    const run = Object.freeze({ ...this.runs[index]!, ...changes }); this.runs[index] = run; return run;
  }

  #providerProfile() {
    return createPcbProviderProfileBinding({ provider: "codex", model: "gpt-test", tier: "priority", adapterSchemaVersion: "fixture" });
  }

  #pendingContractState(prompt: string): FluxContractStateDto {
    const providerProfile = this.#providerProfile();
    const receiptPayload = { schemaVersion: "evleda.flux-interpreter-receipt.v2" as const, interpreterSchemaVersion: "evleda.pcb-design-interpreter.v1", provider: providerProfile.provider,
      providerProfile, providerProfileIdentity: providerProfile.identity, promptDigest: fluxDigest(prompt), clarificationDigest: fluxDigest([]), compilerProfileIdentity: null, practiceProfileBindingIdentity: null, bundleIdentity: null, compiledAt: FIXTURE_TIME };
    return Object.freeze({ disposition: "needs_clarification", questions: [{ id: "component.R1.value", path: "/components/R1/value", question: "Confirm R1 value." }, { id: "component.R2.value", path: "/components/R2/value", question: "Confirm R2 value." }],
      issues: [{ code: "UNRESOLVED_VALUE", severity: "error" as const, path: "/components/R1/value", message: "R1 value requires clarification.", clarificationId: "component.R1.value" }, { code: "UNRESOLVED_VALUE", severity: "error" as const, path: "/components/R2/value", message: "R2 value requires clarification.", clarificationId: "component.R2.value" }],
      contract: null, contractIdentity: null, libraryBindingIdentity: null, deepRuleBindingIdentity: null, acceptancePlanIdentity: null,
      interpreterReceipt: Object.freeze({ ...receiptPayload, identity: canonicalIdentity(receiptPayload, receiptPayload.schemaVersion) }) });
  }

  #genericAuthority(run: FluxRunDto, clarificationAnswers: readonly unknown[] = []) {
    const fixture = createGenericDividerBundleFixture(run.prompt);
    const providerProfile = this.#providerProfile();
    const receiptPayload = {
      schemaVersion: "evleda.flux-interpreter-receipt.v2" as const,
      interpreterSchemaVersion: "evleda.pcb-design-interpreter.v1",
      provider: providerProfile.provider,
      providerProfile,
      providerProfileIdentity: providerProfile.identity,
      promptDigest: fluxDigest(run.prompt),
      clarificationDigest: fluxDigest(clarificationAnswers),
      compilerProfileIdentity: fixture.bundle.compilerProfile.identity,
      practiceProfileBindingIdentity: fixture.bundle.practiceProfileBinding.identity,
      bundleIdentity: fixture.bundle.identity,
      compiledAt: FIXTURE_TIME,
    };
    const interpreterReceipt = Object.freeze({ ...receiptPayload, identity: canonicalIdentity(receiptPayload, receiptPayload.schemaVersion) });
    const contractState: FluxContractStateDto = Object.freeze({
      disposition: "ready", questions: [], issues: [], contract: fixture.bundle.contract,
      contractIdentity: fixture.bundle.contract.identity, libraryBindingIdentity: fixture.bundle.libraryBinding.identity,
      deepRuleBindingIdentity: fixture.bundle.deepRuleBinding.identity, acceptancePlanIdentity: fixture.bundle.acceptancePlan.identity,
      deepRuleSummary: createFluxDeepRuleSummary(fixture.bundle.deepRuleBinding),
      interpreterReceipt,
    });
    return Object.freeze({ fixture, providerProfile, contractState });
  }

  #resolvedCompilationPolicy(authority: Readonly<{ fixture: ReturnType<typeof createGenericDividerBundleFixture> }>) {
    return Object.freeze({
      harnessRuleIdentity: fluxDigest({ schemaVersion: "evleda.test-generic-harness-rule.v1", bundleIdentity: authority.fixture.bundle.identity, deepRuleBindingIdentity: authority.fixture.bundle.deepRuleBinding.identity, executionPromptContentIdentity: authority.fixture.bundle.executionPrompt.textContentIdentity }),
      freshAcceptanceProfileIdentity: fluxDigest({ schemaVersion: "evleda.flux.generic-design-acceptance-profile.v1", acceptancePlanIdentity: authority.fixture.bundle.acceptancePlan.identity, practiceProfileBindingIdentity: authority.fixture.bundle.practiceProfileBinding.identity }),
    });
  }

  #inspectionSnapshot(run: FluxRunDto, state: "idle" | "ready") {
    const persisted = this.#inspectionSnapshots.get(run.id);
    if (state === "idle" && persisted !== undefined) return persisted;
    if (state === "ready") {
      if (this.inspectionBudgetUsed >= 8) throw new Error("fake inspection connection budget exhausted");
      this.inspectionBudgetUsed += 1;
    }
    const subject = this.approvalSubject(run).subject;
    const used = this.inspectionBudgetUsed;
    const base = {
      runId: run.id,
      inspectionBridgeIdentity: subject.inspectionBridgeIdentity,
      executionBridgeIdentity: subject.executionBridgeIdentity,
      ipcSocketIdentity: subject.ipcSocketIdentity,
      writeSessionAuthorityIdentity: subject.writeSessionAuthorityIdentity,
      connectionBudget: { used, remaining: 8 - used, limit: 8 },
      state,
      busy: false,
      completedTools: state === "ready" ? 6 : 0,
      totalTools: 6,
    };
    if (state === "idle") return base;
    const ready = {
      ...base,
      capturedAt: "2026-09-07T00:00:09.000Z",
      boardSummary: { tool: "pcb_get_board_summary", value: {} }, rules: { tool: "pcb_get_design_rules", value: {} },
      footprints: { tool: "pcb_get_footprints", value: {} }, tracks: { tool: "pcb_get_tracks", value: {} },
      vias: { tool: "pcb_get_vias", value: {} }, zones: { tool: "pcb_get_zones", value: {} },
    };
    this.#inspectionSnapshots.set(run.id, ready);
    return ready;
  }

  #success(operation: string, result: unknown, request: FakeFluxRequest): Response {
    const envelope: Record<string, unknown> = { ok: true, operation, requestId: `request-${++this.#request}`, result };
    return json(this.mutateResponse?.(envelope, request) ?? envelope);
  }

  #failure(code: string, message: string, request: FakeFluxRequest, status = 422): Response {
    const envelope: Record<string, unknown> = { ok: false, requestId: `request-${++this.#request}`, error: { code, message, retryable: false, details: {} } };
    return json(this.mutateResponse?.(envelope, request) ?? envelope, status);
  }

  #mutation(operation: string, request: FakeFluxRequest, action: () => unknown): Response | Promise<Response> {
    const key = request.idempotencyKey;
    if (key === null) return this.#failure("INVALID_ARGUMENT", "missing idempotency key", request, 400);
    const replay = this.#idempotent.get(key);
    const result = replay === undefined ? action() : replay.result;
    if (replay === undefined) this.#idempotent.set(key, { operation, result });
    const response = this.#success(operation, result, request);
    if (this.loseNextMutationResponse) {
      this.loseNextMutationResponse = false;
      return Promise.reject(new TypeError("simulated lost response after server commit"));
    }
    return response;
  }

  public readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const request: FakeFluxRequest = { method, pathname: url.pathname, search: url.search, idempotencyKey: header(init, "idempotency-key"), body };
    this.requests.push(request);

    if (method === "GET" && url.pathname === "/api/v1/flux/readiness") {
      const identity = (schema: string, seed: string) => canonicalIdentity({ seed }, schema);
      return this.#success("flux_readiness", {
        schemaVersion: "evleda.flux-readiness.v1", configured: true, status: "ready", reasonCodes: [], diagnostic: null,
        provider: { provider: "codex", model: "gpt-test", requestedTier: "fast", canonicalTier: "priority", adapterSchemaVersion: "fixture", providerProfileIdentity: identity("evleda.pcb-provider-profile-binding.v1", "provider"), localReadCapability: "read_only_host_files", configurationPreflight: { status: "passed", evidenceIdentity: identity("evleda.preflight.v1", "evidence"), capabilityProfileIdentity: identity("evleda.capability.v1", "capability"), imageInspectionPolicy: "disabled_by_pinned_feature" } },
        compiler: { profileIdentity: identity("evleda.pcb-design-compiler-profile.v2", "compiler"), catalogIdentity: identity("evleda.deep-rule-catalog.v1", "catalog"), exactSymbolCount: 3, exactFootprintCount: 3, symbolNicknameCount: 2, footprintNicknameCount: 2 },
        toolchain: { identity: identity("evleda.flux-kicad-toolchain.v1", "toolchain"), kicadCli: { identity: identity("evleda.kicad-cli.v1", "cli"), operationalVersion: "10.0.3", operationalCommit: "abcdef0", peFileVersion: "10.0.3", peProductVersion: "10.0.3" }, pcbnew: { identity: identity("evleda.pcbnew.v1", "pcbnew"), peFileVersion: "10.0.3", peProductVersion: "10.0.3" } },
        kicadMcpRuntime: {
          identity: identity("evleda.kicad-mcp-runtime.v1", "mcp-runtime"),
          inspectionBridgeIdentity: identity("evleda.kicad-mcp-inspection-bridge.v2", "inspection-bridge"),
          executionBridgeIdentity: identity("evleda.kicad-mcp-execution-bridge.v1", "execution-bridge"),
          connectionPolicy: { maxConnections: 8, concurrency: 1, reuse: "same-live-run-bounded", restart: "fail-closed-reallocate-reapprove", cleanup: "after-confirmed-session-and-editor-stop", unconfirmed: "retain-poison-no-retry" },
        },
      }, request);
    }
    if (method === "GET" && url.pathname === "/api/v1/flux/policy") return this.#success("flux_policy", this.policy, request);
    if (method === "GET" && url.pathname === "/api/v1/flux/sources") return this.#success("flux_sources", this.sources, request);
    if (method === "GET" && url.pathname === "/api/v1/flux/projects") return this.#success("flux_projects", { projects: this.projects }, request);
    if (method === "POST" && url.pathname === "/api/v1/flux/projects") return this.#mutation("flux_create_project", request, () => {
      const data = body as { sourceKey: string; name: string }; return this.addProject("project_created", data.name);
    });
    const threadMatch = url.pathname.match(/^\/api\/v1\/flux\/projects\/([a-z][a-z0-9_-]*)\/threads$/u);
    if (threadMatch && method === "GET") return this.#success("flux_threads", { threads: this.threads.filter((entry) => entry.projectId === threadMatch[1]) }, request);
    if (threadMatch && method === "POST") return this.#mutation("flux_create_thread", request, () => this.addThread(threadMatch[1]!, "thread_created", (body as { title: string }).title));
    if (method === "POST" && url.pathname === "/api/v1/flux/runs") return this.#mutation("flux_create_run", request, () => {
      const data = body as { projectId: string; threadId: string; prompt: string; iterationCap: number; providerModel: FluxRunDto["providerModel"]; harnessRuleIdentity: string; mutationAllowlist: string[]; freshAcceptanceProfileIdentity: string; freshPersistenceProfileIdentity: string };
      const created = this.addRun(data.projectId, data.threadId, "draft", data.prompt, "run_created");
      return this.replaceRun(created.id, { iterationCap: data.iterationCap, providerModel: data.providerModel, harnessRuleIdentity: data.harnessRuleIdentity, mutationAllowlist: data.mutationAllowlist, freshAcceptanceProfileIdentity: data.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: data.freshPersistenceProfileIdentity });
    });
    const runMatch = url.pathname.match(/^\/api\/v1\/flux\/runs\/([a-z][a-z0-9_-]*)(?:\/(.*))?$/u);
    if (runMatch) {
      const run = this.runs.find((entry) => entry.id === runMatch[1]); if (!run) return this.#failure("NOT_FOUND", "missing run", request, 404);
      const suffix = runMatch[2] ?? "";
      if (method === "GET" && suffix === "") return this.#success("flux_get_run", run, request);
      if (method === "POST" && suffix === "interpret") return this.#mutation("flux_interpret", request, () => {
        if (this.interpretNeedsClarification) return this.replaceRun(run.id, { phase: "awaiting_clarification", contractState: this.#pendingContractState(run.prompt), updatedAt: "2026-09-07T00:00:01.000Z" });
        const authority = this.#genericAuthority(run);
        return this.replaceRun(run.id, { phase: "contract_ready", ...this.#resolvedCompilationPolicy(authority), contractState: authority.contractState, compilationBundleRef: authority.fixture.reference, updatedAt: "2026-09-07T00:00:01.000Z" });
      });
      if (method === "POST" && suffix === "clarifications") return this.#mutation("flux_clarify", request, () => {
        const answers = (body as { answers: readonly unknown[] }).answers; const authority = this.#genericAuthority(run, answers);
        return this.replaceRun(run.id, { phase: "contract_ready", ...this.#resolvedCompilationPolicy(authority), contractState: authority.contractState, compilationBundleRef: authority.fixture.reference, updatedAt: "2026-09-07T00:00:02.000Z" });
      });
      if (method === "POST" && suffix === "prepare") return this.#mutation("flux_prepare", request, () => this.replaceRun(run.id, { phase: "awaiting_open", updatedAt: "2026-09-07T00:00:03.000Z" }));
      if (method === "POST" && suffix === "checkpoint-open") return this.#mutation("flux_checkpoint_open", request, () => this.replaceRun(run.id, { phase: "awaiting_approval", updatedAt: "2026-09-07T00:00:05.000Z" }));
      if (method === "POST" && suffix === "resume") return this.#mutation("flux_resume", request, () => this.replaceRun(run.id, { phase: "queued", ...(run.approval === undefined ? {} : { approval: { ...run.approval, consumedAt: "2026-09-07T00:00:07.000Z" } }), updatedAt: "2026-09-07T00:00:07.000Z" }));
      if (method === "GET" && suffix === "contract") return this.#success("flux_contract", run.contractState ?? { disposition: "needs_clarification", questions: [], issues: [], contract: null, contractIdentity: null, libraryBindingIdentity: null, deepRuleBindingIdentity: null, acceptancePlanIdentity: null, interpreterReceipt: { schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "fixture", provider: "fixture", promptDigest: "b".repeat(64), clarificationDigest: "c".repeat(64), compiledAt: FIXTURE_TIME } }, request);
      if (method === "GET" && suffix === "reports") return this.#success("flux_reports", { reports: run.reports }, request);
      if (method === "GET" && suffix === "poll") return this.#success("flux_poll", { run, queue: { queuedRunIds: [] }, events: [], nextEventSeq: 0 }, request);
      if (method === "GET" && suffix === "preview") return this.#success("flux_preview", { refreshedAt: FIXTURE_TIME, artifacts: [] }, request);
      if (method === "POST" && suffix === "preview/refresh") return this.#mutation("flux_preview_refresh", request, () => ({ refreshedAt: FIXTURE_TIME, artifacts: [] }));
      if (method === "GET" && suffix === "approval") return this.#success("flux_approval_subject", this.approvalSubject(run), request);
      if (method === "POST" && suffix === "approval") return this.#mutation("flux_approve", request, () => this.replaceRun(run.id, { phase: "approved", approval: { id: "approval_fixture", subjectDigest: (body as { subjectDigest: string }).subjectDigest, approvedAt: "2026-09-07T00:00:06.000Z" }, updatedAt: "2026-09-07T00:00:06.000Z" }));
      if (method === "GET" && suffix === "inspection") return this.#success("flux_inspection_snapshot", this.#inspectionSnapshot(run, "idle"), request);
      if (method === "POST" && suffix === "inspection") return this.#mutation("flux_inspection", request, () => this.#inspectionSnapshot(run, "ready"));
    }
    const openMatch = url.pathname.match(/^\/api\/v1\/flux\/projects\/([a-z][a-z0-9_-]*)\/open$/u);
    if (openMatch && method === "POST") return this.#mutation("flux_open", request, () => {
      const runId = (body as { runId: string }).runId; this.replaceRun(runId, { phase: "awaiting_checkpoint", updatedAt: "2026-09-07T00:00:04.000Z" }); return { opened: true, label: "Opened isolated candidate in KiCad PCB Editor", checkpointRequired: true };
    });
    return this.#failure("NOT_FOUND", "unknown fixture route", request, 404);
  };

  public approvalSubject(run: FluxRunDto): { subject: Record<string, unknown>; digest: string } {
    const identity = (schema: string, seed: string) => canonicalIdentity({ seed }, schema);
    const authority = this.#genericAuthority(run);
    if (run.contractState?.disposition !== "ready" || run.contractState.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || run.compilationBundleRef === undefined) throw new Error("fake generic run lacks ready compilation authority");
    const receipt = run.contractState.interpreterReceipt;
    const subject = {
      schemaVersion: "evleda.flux-approval-subject.v6", runId: run.id, workflowKind: "generic", sourceKey: "reference", sourceFingerprint: "a".repeat(64), isolatedFingerprint: "d".repeat(64), promptIdentity: contentIdentity(run.prompt),
      providerModel: run.providerModel, iterationCap: run.iterationCap, harnessRuleIdentity: run.harnessRuleIdentity, mutationAllowlist: run.mutationAllowlist,
      freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity,
      contractIdentity: run.contractState.contractIdentity, libraryBindingIdentity: run.contractState.libraryBindingIdentity, deepRuleBindingIdentity: run.contractState.deepRuleBindingIdentity, acceptancePlanIdentity: run.contractState.acceptancePlanIdentity,
      kicadToolchainIdentity: identity("evleda.flux-kicad-toolchain.v1", "toolchain"),
      inspectionBridgeIdentity: identity("evleda.kicad-mcp-inspection-bridge.v2", "inspection-bridge"), executionBridgeIdentity: identity("evleda.kicad-mcp-execution-bridge.v1", "execution-bridge"),
      ipcSocketIdentity: identity("evleda.kicad-api-socket-binding.v1", "ipc-socket"), writeSessionAuthorityIdentity: identity("evleda.kicad-mcp-session-authority.v1", "write-session"),
      ipcProbeSemanticIdentity: identity("evleda.flux-open-ipc-probe-semantic.v2", "ipc-probe-semantic"),
      freshNetClassSemanticAuthorityIdentity: identity("evleda.fresh-netclass-semantic-authority.v2", "netclass-semantic"),
      freshProjectOpenPreparedSourceAuthorityIdentity: identity("evleda.fresh-project-open-prepared-source-authority.v1", "prepared-source"),
      freshNetClassPreparationEvidenceIdentity: identity("evleda.fresh-netclass-preparation-evidence.v2", "preparation-evidence"),
      openPreflightReceiptIdentity: identity("evleda.flux-open-preflight.v5", "open"), openCheckpointReceiptIdentity: identity("evleda.flux-open-checkpoint.v6", "checkpoint"),
      compilationBundleRef: run.compilationBundleRef, providerProfile: receipt.providerProfile, bundleIdentity: receipt.bundleIdentity,
      compilerProfileIdentity: receipt.compilerProfileIdentity, practiceProfileBindingIdentity: receipt.practiceProfileBindingIdentity,
      executionPromptIdentity: authority.fixture.bundle.executionPrompt.identity, executionPromptContentIdentity: authority.fixture.bundle.executionPrompt.textContentIdentity,
    };
    return { subject, digest: fluxDigest(subject) };
  }
}
