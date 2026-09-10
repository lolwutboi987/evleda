// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFluxApi, FLUX_RESPONSE_MAX_BYTES, FluxApiError, type FluxTerminalFailureReceiptDto } from "./api";
import type { FluxDiagnosticDto, FluxRunDto, FluxRuntimePolicyDto, FluxRuntimeReadinessDto } from "./model";

afterEach(() => vi.restoreAllMocks());

const identity = (name: string) => ({ algorithm: "sha256" as const, digest: ([...name].reduce((sum, value) => sum + value.codePointAt(0)!, 0) % 16).toString(16).repeat(64), schemaVersion: name === "kicad-runtime" ? "evleda.kicad-mcp-runtime.v1" : name === "inspection-bridge" ? "evleda.kicad-mcp-inspection-bridge.v2" : name === "execution-bridge" ? "evleda.kicad-mcp-execution-bridge.v1" : `evleda.${name}.v1`, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const policy: FluxRuntimePolicyDto = { providerModel: { provider: "openai", model: "gpt-test", tier: "priority" }, iterationCap: { minimum: 1, maximum: 12, recommended: 12 }, harnessRuleIdentity: "server-rule", mutationAllowlist: ["server-owned"], freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$", checkpointOpenRequiredForFresh: true, freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1" };
const readiness: FluxRuntimeReadinessDto = { schemaVersion: "evleda.flux-readiness.v1", configured: true, status: "ready", reasonCodes: [], provider: { provider: "openai", model: "gpt-test", requestedTier: "fast", canonicalTier: "priority", adapterSchemaVersion: "evleda.openai.v1", providerProfileIdentity: identity("provider"), localReadCapability: "none", configurationPreflight: null }, compiler: { profileIdentity: identity("compiler"), catalogIdentity: identity("catalog"), exactSymbolCount: 12, exactFootprintCount: 9, symbolNicknameCount: 2, footprintNicknameCount: 3 }, toolchain: { identity: { ...identity("toolchain"), schemaVersion: "evleda.flux-kicad-toolchain-binding.v1" }, kicadCli: { identity: { ...identity("kicad-cli"), schemaVersion: "evleda.flux-kicad-cli-binding.v1" }, operationalVersion: "10.0.3", operationalCommit: "1".repeat(40), peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" }, pcbnew: { identity: { ...identity("pcbnew"), schemaVersion: "evleda.flux-pcbnew-binding.v1" }, peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" } }, kicadMcpRuntime: { identity: identity("kicad-runtime"), inspectionBridgeIdentity: identity("inspection-bridge"), executionBridgeIdentity: identity("execution-bridge"), connectionPolicy: { maxConnections: 8, concurrency: 1, reuse: "same-live-run-bounded" as const, restart: "fail-closed-reallocate-reapprove" as const, cleanup: "after-confirmed-session-and-editor-stop" as const, unconfirmed: "retain-poison-no-retry" as const } }, diagnostic: null };
const run: FluxRunDto = { id: "run_1", projectId: "project_1", threadId: "thread_1", phase: "draft", prompt: "Board", providerModel: policy.providerModel, iterationCap: 1, workflowKind: "generic", harnessRuleIdentity: "server-rule", mutationAllowlist: ["server-owned"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", reports: [], createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
const diagnostic: FluxDiagnosticDto = { schemaVersion: "evleda.flux-diagnostic.v1", code: "PROVIDER_PROCESS_EXIT", evidenceIdentity: { algorithm: "sha256", digest: "d".repeat(64), schemaVersion: "evleda.flux-diagnostic-evidence.v1", canonicalizationVersion: "evleda-c14n-json-v1" } };
const canonicalJson = (value: unknown): string => value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
const canonicalDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const canonicalIdentity = (value: unknown, schemaVersion: string) => ({ algorithm: "sha256" as const, digest: canonicalDigest(value), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const failureReceipt = (idempotencyKey: string, request: unknown, overrides: Readonly<Record<string, unknown>> = {}): FluxTerminalFailureReceiptDto => {
  const payload = { schemaVersion: "evleda.flux-terminal-failure-receipt.v1" as const, operation: "interpret_run" as const, idempotencyKey, requestDigest: canonicalDigest(request), projectId: "project_1", threadId: "thread_1", runId: "run_1", diagnosticIdentity: canonicalIdentity(diagnostic, "evleda.flux-terminal-failure-diagnostic.v1"), terminalPhase: "blocked" as const, outcome: "failed" as const, completedAt: "2026-09-07T08:00:00.000Z", ...overrides };
  return { ...payload, identity: canonicalIdentity(payload, "evleda.flux-terminal-failure-receipt.v1") } as FluxTerminalFailureReceiptDto;
};
const envelope = (result: unknown, requestId = "req-test") => new Response(JSON.stringify({ ok: true, operation: "test_operation", requestId, result }), { headers: { "Content-Type": "application/json" } });
const failureEnvelope = (error: Readonly<Record<string, unknown>>, requestId = "req-test", status = 422) => new Response(JSON.stringify({ ok: false, requestId, error }), { status, headers: { "Content-Type": "application/json" } });

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const storedStates = (storage: MemoryStorage): readonly string[] => [...storage.values.values()].map((value) => (JSON.parse(value) as { state: string }).state);

describe("Flux generic API client", () => {
  it("loads the separate safe readiness endpoint", async () => {
    const calls: string[] = [];
    const client = createFluxApi({ fetch: vi.fn(async (input) => { calls.push(String(input)); return envelope(readiness); }) });
    await expect(client.readiness()).resolves.toEqual(readiness);
    expect(calls).toEqual(["/api/v1/flux/readiness"]);
  });

  it("constructs the closed generic run request only from exact server policy authority", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const results = [{ id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt }, { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt }, { ...run, iterationCap: 12 }];
    const client = createFluxApi({ fetch: vi.fn(async (input, init) => { calls.push({ url: String(input), ...(init === undefined ? {} : { init }) }); return envelope(results.shift()); }), storage: new MemoryStorage() });
    const policyWithExtra = { ...policy, providerModel: { ...policy.providerModel, apiKey: "must-not-cross" } } as FluxRuntimePolicyDto;
    await client.createRun({ sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 12 }, policyWithExtra);
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/flux/projects", "/api/v1/flux/projects/project_1/threads", "/api/v1/flux/runs"]);
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({ projectId: "project_1", threadId: "thread_1", prompt: "Board", providerModel: { provider: "openai", model: "gpt-test", tier: "priority" }, iterationCap: 12, harnessRuleIdentity: "server-rule", mutationAllowlist: ["server-owned"], freshAcceptanceProfileIdentity: "acceptance-v1", freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "generic" });
    expect(Object.keys(JSON.parse(String(calls[2]!.init!.body)) as object)).toHaveLength(10);
    expect(Object.keys((JSON.parse(String(calls[2]!.init!.body)) as { providerModel: object }).providerModel)).toEqual(["provider", "model", "tier"]);
    expect(String(calls[2]!.init!.body)).not.toContain("must-not-cross");
    expect(calls.map((call) => new Headers(call.init?.headers).get("Idempotency-Key"))).toEqual([expect.stringMatching(/^flux-/u), expect.stringMatching(/^flux-/u), expect.stringMatching(/^flux-/u)]);
  });

  it("sends the server-authorized minimum cap exactly", async () => {
    const bodies: unknown[] = []; const results = [{ id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt }, { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt }, run];
    const client = createFluxApi({ storage: new MemoryStorage(), fetch: vi.fn(async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return envelope(results.shift()); }) });
    await client.createRun({ sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 }, policy);
    expect(bodies[2]).toEqual(expect.objectContaining({ iterationCap: 1 }));
  });

  it.each([
    [undefined, 12],
    [null, 12],
    [{ minimum: 1, maximum: 12, recommended: 12, extra: true }, 12],
    [{ minimum: 0, maximum: 12, recommended: 12 }, 12],
    [{ minimum: 1, maximum: 0, recommended: 1 }, 1],
    [{ minimum: 1, maximum: 12, recommended: 13 }, 12],
    [{ minimum: 1, maximum: 12, recommended: 12 }, 0],
    [{ minimum: 1, maximum: 12, recommended: 12 }, 13],
    [{ minimum: 1, maximum: 12, recommended: 12 }, 1.5],
  ] as const)("rejects malformed policy or cap %# before any create fetch", async (iterationCap, selected) => {
    const fetch = vi.fn(); const malformed = { ...policy, iterationCap } as unknown as FluxRuntimePolicyDto;
    await expect(createFluxApi({ storage: new MemoryStorage(), fetch }).createRun({ sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: selected }, malformed)).rejects.toThrow("no create request was sent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes the exact cap policy in the atomic transaction identity", async () => {
    const storage = new MemoryStorage(); const project1 = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt }; const thread1 = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt }; const project2 = { ...project1, id: "project_2" }; const thread2 = { ...thread1, id: "thread_2", projectId: "project_2" }; const run2 = { ...run, id: "run_2", projectId: "project_2", threadId: "thread_2" };
    const results = [project1, thread1, run, project2, thread2, run2]; const client = createFluxApi({ storage, fetch: vi.fn(async () => envelope(results.shift())) });
    const input = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 };
    await client.createRun(input, policy);
    await client.createRun(input, { ...policy, iterationCap: { minimum: 1, maximum: 1, recommended: 1 } });
    expect(storage.values.size).toBe(2); expect(storedStates(storage)).toEqual(["consumed", "consumed"]);
  });

  it("gives a changed selected cap a new atomic create-transaction identity", async () => {
    const storage = new MemoryStorage(); const project1 = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt }; const thread1 = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt }; const project2 = { ...project1, id: "project_2" }; const thread2 = { ...thread1, id: "thread_2", projectId: "project_2" }; const run2 = { ...run, id: "run_2", projectId: "project_2", threadId: "thread_2", iterationCap: 12 };
    const results = [project1, thread1, run, project2, thread2, run2]; const client = createFluxApi({ storage, fetch: vi.fn(async () => envelope(results.shift())) }); const base = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board" };
    await client.createRun({ ...base, iterationCap: 1 }, policy); await client.createRun({ ...base, iterationCap: 12 }, policy);
    expect(storage.values.size).toBe(2); expect(storedStates(storage)).toEqual(["consumed", "consumed"]);
  });

  it("reuses a durable operation key after a lost response and client reload", async () => {
    const storage = new MemoryStorage(); const keys: string[] = [];
    const lostFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); throw new TypeError("connection lost"); });
    await expect(createFluxApi({ fetch: lostFetch, storage }).prepare("run_1")).rejects.toThrow("connection lost");
    const recoveredFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return envelope(run); });
    await expect(createFluxApi({ fetch: recoveredFetch, storage }).prepare("run_1")).resolves.toEqual(run);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it("permits only the exact retry while another durable intent is pending", async () => {
    const storage = new MemoryStorage();
    await expect(createFluxApi({ storage, fetch: vi.fn(async () => { throw new TypeError("lost"); }) }).prepare("run_1")).rejects.toThrow("lost");
    const blockedFetch = vi.fn(async () => envelope(run)); const blockedClient = createFluxApi({ storage, fetch: blockedFetch });
    await expect(blockedClient.prepare("run_2")).rejects.toThrow("remains pending"); expect(blockedFetch).not.toHaveBeenCalled();
    const retryFetch = vi.fn(async () => envelope(run)); await expect(createFluxApi({ storage, fetch: retryFetch }).prepare("run_1")).resolves.toEqual(run); expect(retryFetch).toHaveBeenCalledTimes(1);
  });

  it("retains all three multi-step create keys until the run response is known", async () => {
    const storage = new MemoryStorage(); const keys: string[] = []; const urls: string[] = [];
    const project = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt };
    const thread = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt };
    let call = 0;
    const first = createFluxApi({ storage, fetch: vi.fn(async (request, init) => { urls.push(String(request)); keys.push(new Headers(init?.headers).get("Idempotency-Key")!); call += 1; if (call === 1) return envelope(project); if (call === 2) return envelope(thread); throw new TypeError("run response lost"); }) });
    const input = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 };
    await expect(first.createRun(input, policy)).rejects.toThrow("run response lost");
    const replay = [run];
    const second = createFluxApi({ storage, fetch: vi.fn(async (request, init) => { urls.push(String(request)); keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return envelope(replay.shift()); }) });
    await expect(second.createRun(input, policy)).resolves.toEqual(run);
    expect(urls).toEqual(["/api/v1/flux/projects", "/api/v1/flux/projects/project_1/threads", "/api/v1/flux/runs", "/api/v1/flux/runs"]);
    expect(keys[2]).toBe(keys[3]);
    expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it.each([1, 2, 3, 4] as const)("recovers atomically after create-transaction manifest write %s fails", async (failedWrite) => {
    class FailOnceStorage extends MemoryStorage {
      writes = 0; failed = false;
      override setItem(key: string, value: string) { this.writes += 1; if (!this.failed && this.writes === failedWrite) { this.failed = true; throw new Error("injected write failure"); } super.setItem(key, value); }
    }
    const storage = new FailOnceStorage(); const calls: Array<{ url: string; key: string }> = [];
    const project = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt };
    const thread = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt };
    const server = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request); calls.push({ url, key: new Headers(init?.headers).get("Idempotency-Key")! });
      return envelope(url === "/api/v1/flux/projects" ? project : url.endsWith("/threads") ? thread : run);
    });
    const input = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 };
    await expect(createFluxApi({ storage, fetch: server }).createRun(input, policy)).rejects.toBeInstanceOf(Error);
    await expect(createFluxApi({ storage, fetch: server }).createRun(input, policy)).resolves.toEqual(run);
    const stageCalls = (suffix: string) => calls.filter((entry) => entry.url === suffix || entry.url.endsWith(suffix));
    expect(new Set(stageCalls("/api/v1/flux/projects").map((entry) => entry.key)).size).toBe(1);
    expect(new Set(stageCalls("/threads").map((entry) => entry.key)).size).toBe(1);
    expect(new Set(stageCalls("/api/v1/flux/runs").map((entry) => entry.key)).size).toBe(1);
    expect(stageCalls("/api/v1/flux/projects")).toHaveLength(failedWrite === 2 ? 2 : 1);
    expect(stageCalls("/threads")).toHaveLength(failedWrite === 3 ? 2 : 1);
    expect(stageCalls("/api/v1/flux/runs")).toHaveLength(failedWrite === 4 ? 2 : 1);
    expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it("uses consumed tombstones so an identical later create is new even when key removal fails", async () => {
    class RemovalFailureStorage extends MemoryStorage { override removeItem() { throw new Error("cleanup denied"); } }
    const storage = new RemovalFailureStorage(); const keys: string[] = [];
    const project1 = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt };
    const thread1 = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt };
    const run1 = run;
    const project2 = { ...project1, id: "project_2" }; const thread2 = { ...thread1, id: "thread_2", projectId: "project_2" }; const run2 = { ...run, id: "run_2", projectId: "project_2", threadId: "thread_2" };
    const firstResults = [project1, thread1, run1]; const secondResults = [project2, thread2, run2];
    const firstClient = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return envelope(firstResults.shift()); }) });
    const input = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 };
    await expect(firstClient.createRun(input, policy)).resolves.toEqual(run1);
    const reloadedClient = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return envelope(secondResults.shift()); }) });
    await expect(reloadedClient.createRun(input, policy)).resolves.toEqual(run2);
    expect(keys[0]).not.toBe(keys[3]);
    expect(keys.slice(0, 3)).not.toEqual(keys.slice(3, 6));
    expect(storedStates(storage).every((state) => state === "consumed")).toBe(true);
  });

  it("locks later mutations if a successful response cannot be terminalized", async () => {
    let writes = 0; const fetch = vi.fn(async () => envelope(run));
    const storage = { values: new Map<string, string>(), getItem(key: string) { return this.values.get(key) ?? null; }, setItem(key: string, value: string) { writes += 1; if (writes > 1) throw new Error("terminal write denied"); this.values.set(key, value); }, removeItem() { throw new Error("cleanup denied"); } };
    const client = createFluxApi({ fetch, storage });
    await expect(client.prepare("run_1")).rejects.toThrow("operation completed");
    await expect(client.prepare("run_1")).rejects.toThrow("storage is unsafe");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not-json",
    JSON.stringify({ schemaVersion: "evleda.flux-browser-intent.v999", state: "pending", idempotencyKey: "flux-old" }),
    JSON.stringify({ schemaVersion: "evleda.flux-browser-intent.v999", state: "consumed", idempotencyKey: "flux-old" }),
    JSON.stringify({ schemaVersion: "evleda.flux-browser-intent.v1", state: "pending", idempotencyKey: "flux-old", unexpected: true }),
  ])("locks a non-null malformed durable record until explicit reset", async (corrupt) => {
    const storage = new MemoryStorage();
    await expect(createFluxApi({ storage, fetch: vi.fn(async () => { throw new TypeError("lost"); }) }).prepare("run_1")).rejects.toThrow("lost");
    const key = [...storage.values.keys()][0]!; storage.values.set(key, corrupt);
    const fetch = vi.fn(async () => envelope(run)); const client = createFluxApi({ storage, fetch });
    await expect(client.prepare("run_1")).rejects.toThrow("explicit reset");
    await expect(client.prepare("run_1")).rejects.toThrow("Explicit reset");
    expect(fetch).not.toHaveBeenCalled();
    client.resetBrowserIntents();
    await expect(client.prepare("run_1")).resolves.toEqual(run);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("locks a malformed create-transaction manifest and performs no stage fetch until reset", async () => {
    const storage = new MemoryStorage(); const project = { id: "project_1", sourceKey: "source", name: "candidate", createdAt: run.createdAt }; const thread = { id: "thread_1", projectId: "project_1", title: "contract", createdAt: run.createdAt };
    let seedCalls = 0; const input = { sourceKey: "source", projectName: "candidate", threadTitle: "contract", prompt: "Board", iterationCap: 1 };
    await expect(createFluxApi({ storage, fetch: vi.fn(async () => { seedCalls += 1; if (seedCalls === 1) return envelope(project); if (seedCalls === 2) return envelope(thread); throw new TypeError("lost"); }) }).createRun(input, policy)).rejects.toThrow("lost");
    const key = [...storage.values.keys()][0]!; const manifest = JSON.parse(storage.values.get(key)!) as Record<string, unknown>; storage.values.set(key, JSON.stringify({ ...manifest, schemaVersion: "evleda.flux-browser-create-transaction.v999" }));
    const fetch = vi.fn(); const client = createFluxApi({ storage, fetch });
    await expect(client.createRun(input, policy)).rejects.toThrow("explicit reset"); expect(fetch).not.toHaveBeenCalled();
    client.resetBrowserIntents();
    const fresh = [project, thread, run]; fetch.mockImplementation(async () => envelope(fresh.shift()));
    await expect(client.createRun(input, policy)).resolves.toEqual(run);
  });

  it("audits the full Flux browser namespace and locks unknown record versions", async () => {
    const storage = new MemoryStorage(); storage.values.set("evleda.flux.pending-intent.v0.legacy", JSON.stringify({ state: "pending" }));
    const fetch = vi.fn(async () => envelope(run)); const client = createFluxApi({ storage, fetch });
    await expect(client.prepare("run_1")).rejects.toThrow("version-mismatched"); expect(fetch).not.toHaveBeenCalled();
    client.resetBrowserIntents(); await expect(client.prepare("run_1")).resolves.toEqual(run);
  });

  it("supports the backend copied-project Open boundary without inventing a run binding", async () => {
    const calls: RequestInit[] = [];
    const client = createFluxApi({ storage: new MemoryStorage(), fetch: vi.fn(async (_input, init) => { calls.push(init!); return envelope({ opened: true, label: "Opened copied candidate", checkpointRequired: false }); }) });
    await client.open("project_1");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({});
  });

  it("does not start a different route/body intent while the first remains pending", async () => {
    const storage = new MemoryStorage(); const keys: string[] = [];
    const client = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); throw new TypeError("lost"); }) });
    await expect(client.open("project_1")).rejects.toThrow("lost");
    await expect(client.open("project_2")).rejects.toThrow("remains pending");
    expect(keys).toHaveLength(1);
  });

  it("reuses the pending Open key after exact retryable preflight failure and consumes only the successful retry", async () => {
    const storage = new MemoryStorage(); const keys: string[] = []; let calls = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1; keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      return calls === 1
        ? failureEnvelope({ code: "OPEN_PREFLIGHT_FAILED", message: "private server prose", retryable: true, details: {} }, "req-open-preflight", 503)
        : envelope({ opened: true, label: "Opened isolated candidate", checkpointRequired: true });
    });
    await expect(createFluxApi({ storage, fetch }).open("project_1", "run_1")).rejects.toEqual(expect.objectContaining<Partial<FluxApiError>>({ code: "OPEN_PREFLIGHT_FAILED", retryable: true, message: "PCB editor Open preflight failed before launch; retrying this exact action is safe." }));
    expect(storedStates(storage)).toEqual(["pending"]);
    await expect(createFluxApi({ storage, fetch }).open("project_1", "run_1")).resolves.toEqual({ opened: true, label: "Opened isolated candidate", checkpointRequired: true });
    expect(keys[0]).toBe(keys[1]); expect(storedStates(storage)).toEqual(["consumed"]);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("private server prose");
  });

  it("sends no mutation when durable browser key storage cannot be proven", async () => {
    const fetch = vi.fn();
    const storage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
    const client = createFluxApi({ fetch, storage });
    await expect(client.prepare("run_1")).rejects.toThrow("explicit reset");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns structured uncertain failures without parsing provider HTML", async () => {
    const structured = createFluxApi({ storage: new MemoryStorage(), fetch: vi.fn(async () => failureEnvelope({ code: "OPERATION_UNCERTAIN", message: "Reread state", retryable: false, details: {} }, "req-uncertain", 409)) });
    await expect(structured.prepare("run_1")).rejects.toEqual(expect.objectContaining<Partial<FluxApiError>>({ code: "OPERATION_UNCERTAIN", retryable: false }));
    const html = createFluxApi({ storage: new MemoryStorage(), fetch: vi.fn(async () => new Response("<b>private provider output</b>", { status: 503, headers: { "Content-Type": "text/html" } })) });
    await expect(html.prepare("run_1")).rejects.toThrow("invalid failure envelope");
  });

  it("retains an exact safe diagnostic on an immediate failed interpretation response", async () => {
    const storage = new MemoryStorage(); const client = createFluxApi({ storage, fetch: vi.fn(async () => failureEnvelope({ code: "STAGE_BLOCKED", message: "Flux capability is unavailable", retryable: false, details: {}, diagnostic }, "req-diagnostic")) });
    await expect(client.interpret("run_1")).rejects.toEqual(expect.objectContaining<Partial<FluxApiError>>({ code: "STAGE_BLOCKED", message: "The Flux operation was blocked.", diagnostic, requestId: "req-diagnostic" }));
    expect(storedStates(storage)).toEqual(["pending"]);
  });

  it("terminalizes a failed interpretation only with the exact bound terminal receipt", async () => {
    const storage = new MemoryStorage(); let returnedReceipt: FluxTerminalFailureReceiptDto | undefined;
    const client = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => {
      const key = new Headers(init?.headers).get("Idempotency-Key")!; returnedReceipt = failureReceipt(key, { runId: "run_1", answers: [] });
      return failureEnvelope({ code: "STAGE_BLOCKED", message: "Flux capability is unavailable", retryable: false, details: {}, diagnostic, terminalFailureReceipt: returnedReceipt }, "req-terminal");
    }) });
    try { await client.interpret("run_1", undefined, { projectId: "project_1", threadId: "thread_1" }); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(FluxApiError); expect((error as FluxApiError).diagnostic).toEqual(diagnostic); expect((error as FluxApiError).terminalFailureReceipt).toEqual(returnedReceipt); }
    expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it("reuses the pending key after a lost response, then consumes the replayed exact failure receipt", async () => {
    const storage = new MemoryStorage(); const keys: string[] = [];
    await expect(createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); throw new TypeError("lost"); }) }).interpret("run_1", undefined, { projectId: "project_1", threadId: "thread_1" })).rejects.toThrow("lost");
    const client = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { const key = new Headers(init?.headers).get("Idempotency-Key")!; keys.push(key); const terminalFailureReceipt = failureReceipt(key, { runId: "run_1", answers: [] }); return failureEnvelope({ code: "STAGE_BLOCKED", message: "failed", retryable: false, details: {}, diagnostic, terminalFailureReceipt }, "req-replay"); }) });
    await expect(client.interpret("run_1", undefined, { projectId: "project_1", threadId: "thread_1" })).rejects.toBeInstanceOf(FluxApiError);
    expect(keys[0]).toBe(keys[1]); expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it("treats replay request IDs as correlation-only while preserving the stable receipt", async () => {
    const storage = new MemoryStorage(); let calls = 0; const keys: string[] = []; const errors: FluxApiError[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { calls += 1; const key = new Headers(init?.headers).get("Idempotency-Key")!; keys.push(key); const terminalFailureReceipt = failureReceipt(key, { runId: "run_1", answers: [] }); return failureEnvelope({ code: "STAGE_BLOCKED", message: "server prose", retryable: false, details: {}, diagnostic, terminalFailureReceipt }, calls === 1 ? "req-first" : "req-second"); });
    try { await createFluxApi({ storage, fetch }).interpret("run_1"); } catch (error) { errors.push(error as FluxApiError); }
    try { await createFluxApi({ storage, fetch }).interpret("run_1", undefined, { projectId: "project_1", threadId: "thread_1" }); } catch (error) { errors.push(error as FluxApiError); }
    expect(keys[0]).toBe(keys[1]); expect(errors.map((error) => error.requestId)).toEqual(["req-first", "req-second"]); expect(errors[0]!.terminalFailureReceipt?.identity.digest).toBe(errors[1]!.terminalFailureReceipt?.identity.digest); expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it("binds a clarification receipt to the exact trimmed backend request", async () => {
    const storage = new MemoryStorage(); const answers = [{ id: "  /scope/name  ", answer: "  Divider  " }];
    const client = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => { const key = new Headers(init?.headers).get("Idempotency-Key")!; const terminalFailureReceipt = failureReceipt(key, { runId: "run_1", answers: [{ id: "/scope/name", answer: "Divider" }] }, { operation: "clarify_run" }); return failureEnvelope({ code: "STAGE_BLOCKED", message: "failed", retryable: false, details: {}, diagnostic, terminalFailureReceipt }, "req-clarify"); }) });
    await expect(client.clarifications("run_1", answers, undefined, { projectId: "project_1", threadId: "thread_1" })).rejects.toBeInstanceOf(FluxApiError);
    expect(storedStates(storage)).toEqual(["consumed"]);
  });

  it.each(["project", "request", "extra", "identity"] as const)("keeps the browser intent pending for a %s-tampered terminal receipt", async (kind) => {
    const storage = new MemoryStorage();
    const client = createFluxApi({ storage, fetch: vi.fn(async (_input, init) => {
      const key = new Headers(init?.headers).get("Idempotency-Key")!; const base = failureReceipt(key, { runId: "run_1", answers: [] });
      let terminalFailureReceipt: unknown;
      if (kind === "project") terminalFailureReceipt = failureReceipt(key, { runId: "run_1", answers: [] }, { projectId: "project_other" });
      else if (kind === "request") terminalFailureReceipt = failureReceipt(key, { runId: "run_other", answers: [] });
      else if (kind === "extra") terminalFailureReceipt = { ...base, stderr: "Bearer super-secret-token" };
      else terminalFailureReceipt = { ...base, identity: { ...base.identity, digest: "e".repeat(64) } };
      return failureEnvelope({ code: "STAGE_BLOCKED", message: "failed", retryable: false, details: {}, diagnostic, terminalFailureReceipt }, "req-tampered");
    }) });
    try { await client.interpret("run_1", undefined, { projectId: "project_1", threadId: "thread_1" }); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(FluxApiError); if (kind === "project" || kind === "request") expect((error as FluxApiError).terminalFailureReceipt).toBeDefined(); else expect((error as FluxApiError).terminalFailureReceipt).toBeUndefined(); }
    expect(storedStates(storage)).toEqual(["pending"]);
  });

  it.each([
    { ...diagnostic, code: "UNKNOWN_C:\\private\\token=secret" },
    { ...diagnostic, stderr: "Bearer super-secret-token" },
    { ...diagnostic, evidenceIdentity: { ...diagnostic.evidenceIdentity, path: "/private/evidence" } },
    { ...diagnostic, evidenceIdentity: { ...diagnostic.evidenceIdentity, schemaVersion: "evleda.unknown.v1" } },
  ])("omits a malformed or malicious immediate failure diagnostic", async (malformed) => {
    const client = createFluxApi({ storage: new MemoryStorage(), fetch: vi.fn(async () => failureEnvelope({ code: "STAGE_BLOCKED", message: "Flux capability is unavailable", retryable: false, details: {}, diagnostic: malformed }, "req-malformed")) });
    try { await client.interpret("run_1"); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(FluxApiError); expect((error as FluxApiError).diagnostic).toBeUndefined(); expect(JSON.stringify(error)).not.toMatch(/UNKNOWN_|C:\\private|super-secret|\/private\/evidence/iu); }
  });

  it("rejects an oversized declared response before decoding and cancels its body", async () => {
    let cancelled = false; const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); }, cancel() { cancelled = true; } });
    const response = new Response(stream, { headers: { "Content-Type": "application/json", "Content-Length": String(FLUX_RESPONSE_MAX_BYTES + 1) } });
    const client = createFluxApi({ fetch: vi.fn(async () => response) });
    await expect(client.policy()).rejects.toEqual(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" })); expect(cancelled).toBe(true);
  });

  it("cancels a chunked response as soon as streamed bytes cross the bound", async () => {
    let pulls = 0; let cancelled = false; const chunk = new Uint8Array(Math.floor(FLUX_RESPONSE_MAX_BYTES / 2) + 1);
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(chunk); if (pulls >= 4) controller.close(); }, cancel() { cancelled = true; } });
    const client = createFluxApi({ fetch: vi.fn(async () => new Response(stream, { headers: { "Content-Type": "application/json" } })) });
    await expect(client.policy()).rejects.toEqual(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" })); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(3);
  });

  it("rejects invalid UTF-8 without retaining decoded replacement text", async () => {
    const client = createFluxApi({ fetch: vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "Content-Type": "application/json" } })) });
    await expect(client.policy()).rejects.toEqual(expect.objectContaining({ code: "INVALID_RESPONSE", message: "Flux service returned invalid UTF-8." }));
  });

  it.each([
    { requestId: "req-safe", error: { code: "SOURCE_DRIFT_C:\\private", message: "token=super-secret", retryable: false, details: {} } },
    { requestId: "req-safe", error: { code: "STAGE_BLOCKED", message: "bad\u0000message", retryable: false, details: {} } },
    { requestId: `req-${"x".repeat(129)}`, error: { code: "STAGE_BLOCKED", message: "server prose", retryable: false, details: {} } },
  ])("rejects malicious failure code/message/requestId without retaining prose", async ({ requestId, error: failure }) => {
    const client = createFluxApi({ fetch: vi.fn(async () => failureEnvelope(failure, requestId)) });
    try { await client.policy(); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(FluxApiError); expect((error as FluxApiError).code).toBe("INVALID_RESPONSE"); expect((error as FluxApiError).message).toBe("Flux service returned an invalid failure envelope."); expect(JSON.stringify(error)).not.toMatch(/SOURCE_DRIFT_C|C:\\private|super-secret|bad\u0000message/iu); if (requestId.length > 128) expect((error as FluxApiError).requestId).toBeUndefined(); }
  });
});
