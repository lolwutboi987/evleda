import { link, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalIdentity } from "../../src/core/canonical.js";
import { validateCanonicalIdentity } from "../../src/core/portable-artifact.js";
import { createFluxDiagnostic } from "../../src/domain/diagnostics.js";
import { FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, fluxDigest } from "../../src/flux/contracts.js";
import type { FluxRunDto } from "../../src/flux/contracts.js";
import { createFluxFreshClearanceEvidenceBinding } from "../../src/flux/fresh-clearance-evidence-binding.js";
import { createPcbProviderProfileBinding } from "../../src/harness/pcb-design-interpreter.js";
import {
  FLUX_CONTROL_CHECKPOINT_TIMEOUT_MS,
  FLUX_CONTROL_INTERPRETATION_TIMEOUT_MS,
  FLUX_CONTROL_OPEN_TIMEOUT_MS,
  FLUX_CONTROL_READINESS_REASON_CODES,
  FLUX_CONTROL_REQUEST_TIMEOUT_MS,
  FluxControlClient,
  FluxControlError,
  FluxControlIntentStore,
  normalizeFluxControlBaseUrl,
  parseFluxControlResponse,
} from "../../src/integrations/flux-control-client.js";
import { FakeFluxControlServer, FIXTURE_POLICY } from "../helpers/fake-flux-control-server.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const owned = new Set<string>();
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...owned].map(async (root) => { await rm(root, { recursive: true, force: true }); owned.delete(root); }));
});

const temporary = async () => { const root = await mkdtemp(path.join(os.tmpdir(), "evleda-flux-control-")); owned.add(root); return root; };
const client = (root: string, server: FakeFluxControlServer, baseUrl = "http://127.0.0.1:8765") => new FluxControlClient({
  baseUrl,
  fetch: server.fetch,
  intentStore: new FluxControlIntentStore(path.join(root, "intents.json"), baseUrl),
});
const withClarificationDigest = (value: FluxRunDto, clarificationDigest: string): FluxRunDto => {
  const receipt = value.contractState!.interpreterReceipt; if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("expected v2 receipt");
  const { identity: _identity, ...payload } = receipt; const changed = { ...payload, clarificationDigest };
  return { ...value, contractState: { ...value.contractState!, interpreterReceipt: { ...changed, identity: canonicalIdentity(changed, changed.schemaVersion) } } };
};
const withInterpreterSchemaVersion = (value: FluxRunDto, interpreterSchemaVersion: string): FluxRunDto => {
  const receipt = value.contractState!.interpreterReceipt; if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("expected v2 receipt");
  const { identity: _identity, ...payload } = receipt; const changed = { ...payload, interpreterSchemaVersion };
  return { ...value, contractState: { ...value.contractState!, interpreterReceipt: { ...changed, identity: canonicalIdentity(changed, changed.schemaVersion) } } };
};

const checkpointFailureReceipt = (run: FluxRunDto, key: string, message = FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, changes: Record<string, unknown> = {}) => {
  const payload = {
    schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION,
    operation: "checkpoint_open" as const,
    idempotencyKey: key,
    requestDigest: fluxDigest({ runId: run.id }),
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
    failureIdentity: canonicalIdentity({ code: "OPERATION_UNCERTAIN", message, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION),
    terminalPhase: "blocked" as const,
    outcome: "failed" as const,
    completedAt: "2026-09-08T00:02:00.000Z",
    ...changes,
  };
  return { ...payload, identity: canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION) };
};

describe("Flux control transport and durable client", () => {
  it("permits loopback by default and requires an explicit HTTPS override remotely", () => {
    expect(normalizeFluxControlBaseUrl()).toBe("http://127.0.0.1:8765");
    expect(normalizeFluxControlBaseUrl("http://127.17.2.3:9000/")).toBe("http://127.17.2.3:9000");
    expect(() => normalizeFluxControlBaseUrl("http://example.test:8765")).toThrow(/explicit remote override and HTTPS/iu);
    expect(() => normalizeFluxControlBaseUrl("http://example.test:8765", true)).toThrow(/HTTPS/iu);
    expect(normalizeFluxControlBaseUrl("https://example.test:8765", true)).toBe("https://example.test:8765");
    expect(() => normalizeFluxControlBaseUrl("http://localhost:8765/api/v1/flux")).toThrow(/only an origin/iu);
    expect(() => normalizeFluxControlBaseUrl("http://user:pass@localhost:8765")).toThrow(/credentials/iu);
  });

  it("keeps exact parity with every server readiness reason and accepts the closed setup projection", async () => {
    const root = await temporary();
    const productionSource = await readFile(path.resolve("src/flux/production-composition.ts"), "utf8");
    const union = productionSource.match(/export type FluxReadinessReasonCode\s*=([\s\S]*?);/u)?.[1];
    expect(union).toBeDefined();
    const serverCodes = [...union!.matchAll(/"([A-Z][A-Z0-9_]+)"/gu)].map((match) => match[1]);
    expect(FLUX_CONTROL_READINESS_REASON_CODES).toEqual(serverCodes);
    const diagnostic = createFluxDiagnostic("TOOLCHAIN_FAILURE", { category: "termination_unconfirmed" });
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      operation: "flux_readiness",
      requestId: "request-readiness-unconfirmed",
      result: { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: FLUX_CONTROL_READINESS_REASON_CODES, provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic },
    }), { headers: { "content-type": "application/json" } });
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch, intentStore: new FluxControlIntentStore(path.join(root, "readiness.json"), "http://127.0.0.1:8765") });
    await expect(control.readiness()).resolves.toMatchObject({ result: { configured: false, status: "setup_required", reasonCodes: FLUX_CONTROL_READINESS_REASON_CODES, kicadMcpRuntime: null } });
  });

  it("requires exact path-free KiCad MCP runtime identity domains and connection policy", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    await expect(control.readiness()).resolves.toMatchObject({ result: { kicadMcpRuntime: {
      identity: { schemaVersion: "evleda.kicad-mcp-runtime.v1" },
      inspectionBridgeIdentity: { schemaVersion: "evleda.kicad-mcp-inspection-bridge.v2" },
      executionBridgeIdentity: { schemaVersion: "evleda.kicad-mcp-execution-bridge.v1" },
      connectionPolicy: { maxConnections: 8, concurrency: 1, reuse: "same-live-run-bounded", restart: "fail-closed-reallocate-reapprove", cleanup: "after-confirmed-session-and-editor-stop", unconfirmed: "retain-poison-no-retry" },
    } } });
    const attacks = [
      (runtime: Record<string, unknown>) => ({ ...runtime, identity: canonicalIdentity({ wrong: true }, "evleda.wrong-domain.v1") }),
      (runtime: Record<string, unknown>) => ({ ...runtime, inspectionBridgeIdentity: canonicalIdentity({ wrong: true }, "evleda.wrong-inspection.v1") }),
      (runtime: Record<string, unknown>) => ({ ...runtime, executionBridgeIdentity: canonicalIdentity({ wrong: true }, "evleda.wrong-execution.v1") }),
      (runtime: Record<string, unknown>) => ({ ...runtime, connectionPolicy: { ...(runtime.connectionPolicy as Record<string, unknown>), maxConnections: 7 } }),
      (runtime: Record<string, unknown>) => ({ ...runtime, endpoint: "C:\\private\\inspection.sock" }),
    ];
    for (const attack of attacks) {
      server.mutateResponse = (envelope, request) => {
        if (request.pathname !== "/api/v1/flux/readiness") return envelope;
        const result = envelope.result as Record<string, unknown>; const runtime = result.kicadMcpRuntime as Record<string, unknown>;
        return { ...envelope, result: { ...result, kicadMcpRuntime: attack(runtime) } };
      };
      let failure: FluxControlError;
      try { await control.readiness(); throw new Error("expected bridge rejection"); } catch (error) { failure = error as FluxControlError; }
      expect(failure.code).toBe("RESPONSE_MALFORMED");
      expect(JSON.stringify(failure)).not.toContain("C:\\private\\inspection.sock");
    }
    server.mutateResponse = undefined;
  });

  it("uses 30 seconds ordinarily, 120 seconds for Open, and 300 seconds for interpret, clarify, and checkpoint", async () => {
    expect(FLUX_CONTROL_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(FLUX_CONTROL_OPEN_TIMEOUT_MS).toBe(120_000);
    expect(FLUX_CONTROL_INTERPRETATION_TIMEOUT_MS).toBe(300_000);
    expect(FLUX_CONTROL_CHECKPOINT_TIMEOUT_MS).toBe(300_000);
    vi.useFakeTimers();
    const abortedResponse = (signal: AbortSignal | null | undefined, started: () => void): Promise<Response> => new Promise((_resolve, reject) => {
      started();
      if (signal?.aborted === true) { reject(new Error("aborted")); return; }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    let ordinaryStarted!: () => void; const ordinaryStart = new Promise<void>((resolve) => { ordinaryStarted = resolve; });
    const ordinaryRoot = await temporary(); const ordinary = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: async (_input, init) => abortedResponse(init?.signal, ordinaryStarted), intentStore: new FluxControlIntentStore(path.join(ordinaryRoot, "ordinary.json"), "http://127.0.0.1:8765") });
    const ordinaryRequest = ordinary.readiness(); let ordinarySettled = false; const ordinaryOutcome = ordinaryRequest.then(() => ({ error: null }), (error: unknown) => ({ error })).finally(() => { ordinarySettled = true; });
    await ordinaryStart; await vi.advanceTimersByTimeAsync(29_999); expect(ordinarySettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await ordinaryOutcome).error).toMatchObject({ code: "TRANSPORT_FAILED" }); expect(vi.getTimerCount()).toBe(0);

    const prepareRoot = await temporary(); const prepareServer = new FakeFluxControlServer(); const prepareProject = prepareServer.addProject(); const prepareThread = prepareServer.addThread(prepareProject.id); const prepareRun = prepareServer.addRun(prepareProject.id, prepareThread.id, "contract_ready");
    let prepareStarted!: () => void; const prepareStart = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const prepareFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      return method === "POST" && url.pathname.endsWith("/prepare") ? abortedResponse(init?.signal, prepareStarted) : prepareServer.fetch(input, init);
    };
    const prepareControl = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: prepareFetch, intentStore: new FluxControlIntentStore(path.join(prepareRoot, "prepare.json"), "http://127.0.0.1:8765") });
    const prepareRequest = prepareControl.prepare(prepareRun.id); let prepareSettled = false; const prepareOutcome = prepareRequest.then(() => ({ error: null }), (error: unknown) => ({ error })).finally(() => { prepareSettled = true; });
    await prepareStart; await vi.advanceTimersByTimeAsync(29_999); expect(prepareSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await prepareOutcome).error).toMatchObject({ code: "TRANSPORT_FAILED" }); expect(vi.getTimerCount()).toBe(0);

    for (const operation of ["open", "interpret", "clarify", "checkpoint"] as const) {
      const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, operation === "open" ? "awaiting_open" : operation === "interpret" ? "draft" : operation === "clarify" ? "awaiting_clarification" : "awaiting_checkpoint");
      let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const suffix = operation === "open" ? "/open" : operation === "interpret" ? "/interpret" : operation === "clarify" ? "/clarifications" : "/checkpoint-open";
        if (method === "POST" && url.pathname.endsWith(suffix)) return abortedResponse(init?.signal, postStarted);
        return server.fetch(input, init);
      };
      const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch, intentStore: new FluxControlIntentStore(path.join(root, `${operation}.json`), "http://127.0.0.1:8765") });
      const request = operation === "open" ? control.open(run.id) : operation === "interpret" ? control.interpret(run.id) : operation === "clarify" ? control.answerClarifications(run.id, [{ id: "component.R1.value", answer: "10k" }]) : control.checkpoint(run.id);
      let settled = false; const outcome = request.then(() => ({ error: null }), (error: unknown) => ({ error })).finally(() => { settled = true; });
      await postStart; await vi.advanceTimersByTimeAsync(operation === "open" ? 119_999 : 299_999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect((await outcome).error).toMatchObject({ code: "TRANSPORT_FAILED" }); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("accepts an Open response after 33 seconds and clears its observation timer on success", async () => {
    vi.useFakeTimers();
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_open");
    let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
    let releasePost!: () => void; let signal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/open")) {
        signal = init?.signal;
        await new Promise<void>((resolve, reject) => { releasePost = resolve; signal?.addEventListener("abort", () => reject(new Error("Open aborted")), { once: true }); postStarted(); });
      }
      return server.fetch(input, init);
    };
    const baseUrl = "http://127.0.0.1:8765"; const control = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(path.join(root, "open-33s.json"), baseUrl) });
    const request = control.open(run.id); let settled = false; const outcome = request.finally(() => { settled = true; });
    await postStart; await vi.advanceTimersByTimeAsync(30_000); expect(settled).toBe(false); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000); expect(settled).toBe(false); expect(signal?.aborted).toBe(false); releasePost();
    await expect(outcome).resolves.toMatchObject({ result: { opened: true, checkpointRequired: true }, intent: { status: "completed" } });
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(120_000); expect(signal?.aborted).toBe(false);
  });

  it.each(["transport", "headers", "body"] as const)("keeps a committed Open pending after %s observation failure and replays the same key after restart", async (failureStage) => {
    vi.useFakeTimers();
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_open");
    const statePath = path.join(root, `open-${failureStage}.json`); const baseUrl = "http://127.0.0.1:8765";
    let failObservation = true; let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (failObservation && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/open")) {
        await server.fetch(input, init);
        if (failureStage === "transport") { postStarted(); throw new Error("lost Open response after commit"); }
        if (failureStage === "headers") return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("Open response timed out")), { once: true }); postStarted(); });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("Open body timed out")), { once: true }); postStarted(); } }), { headers: { "content-type": "application/json" } });
      }
      return server.fetch(input, init);
    };
    const createClient = () => new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    let settled = false; const outcome = createClient().open(run.id).then(() => ({ error: null }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    await postStart;
    if (failureStage !== "transport") {
      await vi.advanceTimersByTimeAsync(30_000); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(89_999); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect((await outcome).error).toMatchObject({ code: "TRANSPORT_FAILED", retryable: true }); expect(vi.getTimerCount()).toBe(0);
    expect(server.runs[0]?.phase).toBe("awaiting_checkpoint");
    let manifest = JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, { operation: string; status: string }> };
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "open_project")?.status).toBe("pending");
    failObservation = false;
    await expect(createClient().open(run.id)).resolves.toMatchObject({ result: { opened: true, checkpointRequired: true }, intent: { status: "completed" } });
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/open"));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1); expect(vi.getTimerCount()).toBe(0);
    manifest = JSON.parse(await readFile(statePath, "utf8")) as typeof manifest;
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "open_project")?.status).toBe("completed");
  });

  it("keeps a timed-out committed interpretation pending and replays its same long-operation key", async () => {
    vi.useFakeTimers();
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id); const statePath = path.join(root, "timed-interpret.json");
    let hang = true; let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (hang && method === "POST" && url.pathname.endsWith("/interpret")) {
        await server.fetch(input, init); postStarted();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted after commit")), { once: true }));
      }
      return server.fetch(input, init);
    };
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    const first = control.interpret(run.id); const firstOutcome = first.then(() => ({ error: null }), (error: unknown) => ({ error })); await postStart;
    await vi.advanceTimersByTimeAsync(299_999); expect(server.runs.find((entry) => entry.id === run.id)?.phase).toBe("contract_ready");
    await vi.advanceTimersByTimeAsync(1); expect((await firstOutcome).error).toMatchObject({ code: "TRANSPORT_FAILED" }); expect(vi.getTimerCount()).toBe(0);
    let manifest = JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, { operation: string; status: string }> };
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "interpret_run")?.status).toBe("pending");
    hang = false;
    const restarted = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    await expect(restarted.interpret(run.id)).resolves.toMatchObject({ result: { phase: "contract_ready" }, intent: { status: "completed" } });
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/interpret"));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1); expect(vi.getTimerCount()).toBe(0);
    manifest = JSON.parse(await readFile(statePath, "utf8")) as typeof manifest;
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "interpret_run")?.status).toBe("completed");
  });

  it("keeps a timed-out committed checkpoint pending and replays its same 300-second key after restart", async () => {
    vi.useFakeTimers();
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_checkpoint"); const statePath = path.join(root, "timed-checkpoint.json"); const baseUrl = "http://127.0.0.1:8765";
    let hang = true; let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (hang && method === "POST" && url.pathname.endsWith("/checkpoint-open")) {
        await server.fetch(input, init); postStarted();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted checkpoint after commit")), { once: true }));
      }
      return server.fetch(input, init);
    };
    const control = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const first = control.checkpoint(run.id); const firstOutcome = first.then(() => ({ error: null }), (error: unknown) => ({ error })); await postStart;
    await vi.advanceTimersByTimeAsync(299_999); expect(server.runs.find((entry) => entry.id === run.id)?.phase).toBe("awaiting_approval");
    await vi.advanceTimersByTimeAsync(1); expect((await firstOutcome).error).toMatchObject({ code: "TRANSPORT_FAILED" }); expect(vi.getTimerCount()).toBe(0);
    let manifest = JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, { operation: string; status: string }> };
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "checkpoint_open")?.status).toBe("pending");
    hang = false;
    const restarted = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    await expect(restarted.checkpoint(run.id)).resolves.toMatchObject({ result: { phase: "awaiting_approval" }, intent: { status: "completed" } });
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/checkpoint-open"));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1); expect(vi.getTimerCount()).toBe(0);
    manifest = JSON.parse(await readFile(statePath, "utf8")) as typeof manifest;
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "checkpoint_open")?.status).toBe("completed");
  });

  it("allows one authenticated pending-to-resolved compilation transition and pins it thereafter", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); server.interpretNeedsClarification = true;
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id); const control = client(root, server);
    const pendingHarness = run.harnessRuleIdentity; const pendingAcceptance = run.freshAcceptanceProfileIdentity;
    const unresolved = await control.interpret(run.id);
    expect(unresolved.result).toMatchObject({ phase: "awaiting_clarification", harnessRuleIdentity: pendingHarness, freshAcceptanceProfileIdentity: pendingAcceptance });
    expect(Object.hasOwn(unresolved.result, "compilationBundleRef")).toBe(false);
    server.interpretNeedsClarification = false;
    const answers = [{ id: "component.R1.value", answer: "10k" }];
    const resolved = await control.answerClarifications(run.id, answers);
    expect(resolved.result).toMatchObject({ phase: "contract_ready", harnessRuleIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u), freshAcceptanceProfileIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u), compilationBundleRef: { schemaVersion: "evleda.pcb-design-compilation-bundle-ref.v1" } });
    expect((resolved.result as Record<string, unknown>).harnessRuleIdentity).not.toBe(pendingHarness);
    expect((resolved.result as Record<string, unknown>).freshAcceptanceProfileIdentity).not.toBe(pendingAcceptance);
    await expect(control.answerClarifications(run.id, answers)).resolves.toMatchObject({ result: resolved.result, intent: { status: "completed" } });
    const attacks = [
      (value: FluxRunDto): FluxRunDto => ({ ...value, harnessRuleIdentity: "f".repeat(64) }),
      (value: FluxRunDto): FluxRunDto => ({ ...value, freshAcceptanceProfileIdentity: "e".repeat(64) }),
      (value: FluxRunDto): FluxRunDto => { const { compilationBundleRef: _bundle, ...without } = value; return without as FluxRunDto; },
      (value: FluxRunDto): FluxRunDto => ({ ...value, contractState: { ...value.contractState!, acceptancePlanIdentity: canonicalIdentity({ wrong: true }, "evleda.wrong-acceptance-plan.v1") } }),
      (value: FluxRunDto): FluxRunDto => withClarificationDigest(value, "0".repeat(64)),
    ];
    for (const attack of attacks) {
      server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/clarifications") ? { ...envelope, result: attack(envelope.result as FluxRunDto) } : envelope;
      await expect(control.answerClarifications(run.id, answers)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    }
    server.mutateResponse = undefined;
  });

  it("rejects success-shaped blocked, unsupported clarification, and non-digest initial harness resolution", async () => {
    const attacks = ["blocked", "unsupported", "harness-domain", "clarification-digest", "interpreter-schema"] as const;
    for (const attack of attacks) {
      const root = await temporary(); const server = new FakeFluxControlServer(); server.interpretNeedsClarification = attack === "unsupported";
      const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id); const statePath = path.join(root, `${attack}.json`);
      server.mutateResponse = (envelope, request) => {
        if (request.method !== "POST" || !request.pathname.endsWith("/interpret")) return envelope;
        const result = envelope.result as FluxRunDto;
        if (attack === "blocked") return { ...envelope, result: { ...result, phase: "blocked", harnessRuleIdentity: server.policy.harnessRuleIdentity, freshAcceptanceProfileIdentity: server.policy.freshAcceptanceProfileIdentity } };
        if (attack === "unsupported") return { ...envelope, result: { ...result, contractState: { ...result.contractState!, disposition: "unsupported" } } };
        if (attack === "harness-domain") return { ...envelope, result: { ...result, harnessRuleIdentity: "evleda.not-a-canonical-harness-digest" } };
        if (attack === "clarification-digest") return { ...envelope, result: withClarificationDigest(result, "0".repeat(64)) };
        return { ...envelope, result: withInterpreterSchemaVersion(result, "evleda.pcb-design-interpreter.v999") };
      };
      const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
      await expect(control.interpret(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      expect(await readFile(statePath, "utf8")).toContain('"status":"pending"');
    }
  });

  it("binds a clarification receipt to the exact normalized answer batch and order", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_clarification"); const statePath = path.join(root, "clarification-digest.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    const answers = [{ id: " component.R1.value ", answer: " 10k " }, { id: " component.R2.value ", answer: " 20k " }];
    const normalizedAnswers = [{ id: "component.R1.value", answer: "10k" }, { id: "component.R2.value", answer: "20k" }];
    const wrongDigests = [fluxDigest([{ id: "component.R1.value", answer: "11k" }, normalizedAnswers[1]!]), fluxDigest([...normalizedAnswers].reverse())];
    for (const wrongDigest of wrongDigests) {
      server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/clarifications") ? { ...envelope, result: withClarificationDigest(envelope.result as FluxRunDto, wrongDigest) } : envelope;
      await expect(control.answerClarifications(run.id, answers)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      expect(await readFile(statePath, "utf8")).toContain('"status":"pending"');
    }
    server.mutateResponse = undefined;
    await expect(control.answerClarifications(run.id, answers)).resolves.toMatchObject({ result: { phase: "contract_ready" }, intent: { status: "completed" } });
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/clarifications"));
    expect(attempts).toHaveLength(3); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
  });

  it("allows two clients sharing one pending interpretation intent to accept the same resolved bundle", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id); const statePath = path.join(root, "two-client-interpret.json"); const baseUrl = "http://127.0.0.1:8765";
    let posts = 0; let firstStarted!: () => void; const firstPost = new Promise<void>((resolve) => { firstStarted = resolve; }); let bothStarted!: () => void; const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let releaseFirst!: () => void; const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; }); let releaseSecond!: () => void; const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "POST" && url.pathname.endsWith("/interpret")) { posts += 1; const ordinal = posts; if (ordinal === 1) firstStarted(); if (ordinal === 2) bothStarted(); await (ordinal === 1 ? firstReleased : secondReleased); }
      return server.fetch(input, init);
    };
    const first = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const second = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const firstResult = first.interpret(run.id); await firstPost;
    const secondResult = second.interpret(run.id); await started; releaseFirst(); const left = await firstResult; releaseSecond(); const right = await secondResult;
    expect(left.result).toEqual(right.result); expect(left.result).toMatchObject({ phase: "contract_ready" });
    expect(left.intent?.idempotencyKey).toBe(right.intent?.idempotencyKey);
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/interpret"))).toHaveLength(2);
  });

  it("keeps the owned deadline active through bounded response-body parsing and clears it", async () => {
    vi.useFakeTimers();
    const root = await temporary(); let bodyStarted!: () => void; const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyStarted();
        init?.signal?.addEventListener("abort", () => controller.error(new Error("private body stream abort detail")), { once: true });
      },
    }), { headers: { "content-type": "application/json" } });
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch, intentStore: new FluxControlIntentStore(path.join(root, "body-timeout.json"), "http://127.0.0.1:8765") });
    const request = control.readiness(); const outcome = request.then(() => ({ error: null }), (error: unknown) => ({ error })); await started;
    await vi.advanceTimersByTimeAsync(29_999); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect((await outcome).error).toMatchObject({ code: "TRANSPORT_FAILED", message: "Flux response stream failed before a complete envelope was received." });
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify((await outcome).error)).not.toContain("private body stream abort detail");
  });

  it("enforces raw bytes, per-chunk limits, fatal UTF-8, duplicate-key rejection, and exact envelopes", async () => {
    const success = { ok: true, operation: "flux_policy", requestId: "request-1", result: {} };
    await expect(parseFluxControlResponse(new Response(JSON.stringify(success), { headers: { "content-type": "application/json" } }), "flux_policy")).resolves.toMatchObject({ ok: true, requestId: "request-1" });
    await expect(parseFluxControlResponse(new Response(JSON.stringify({ ...success, extra: true }), { headers: { "content-type": "application/json" } }), "flux_policy")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(parseFluxControlResponse(new Response(JSON.stringify(success), { headers: { "content-type": "application/json" } }), "flux_sources")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(parseFluxControlResponse(new Response('{"ok":true,"ok":false,"requestId":"request-1","error":{}}', { status: 400, headers: { "content-type": "application/json" } }), "flux_policy")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(parseFluxControlResponse(new Response(Buffer.from([0xff]), { headers: { "content-type": "application/json" } }), "flux_policy")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(parseFluxControlResponse(new Response(JSON.stringify(success), { headers: { "content-type": "text/plain" } }), "flux_policy")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    const oneChunk = new Response("x".repeat(33), { headers: { "content-type": "application/json" } });
    await expect(parseFluxControlResponse(oneChunk, "flux_policy", { responseChunkBytes: 32 })).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
    const tooLarge = new Response("{}", { headers: { "content-type": "application/json", "content-length": "99999999" } });
    await expect(parseFluxControlResponse(tooLarge, "flux_policy")).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
    const root = await temporary();
    const transport = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: async () => { throw new Error("SECRET_PROVIDER_TEXT"); }, intentStore: new FluxControlIntentStore(path.join(root, "transport.json"), "http://127.0.0.1:8765") });
    let transportFailure: FluxControlError;
    try { await transport.readiness(); throw new Error("expected transport failure"); }
    catch (error) { transportFailure = error as FluxControlError; }
    expect(transportFailure).toMatchObject({ code: "TRANSPORT_FAILED", message: "Flux request did not return a trusted response." });
    expect(transportFailure.message).not.toContain("SECRET_PROVIDER_TEXT");

    const streamSecret = "SECRET_STREAM_ERROR_TEXT";
    const brokenStream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(streamSecret)); } });
    let streamFailure: FluxControlError;
    try { await parseFluxControlResponse(new Response(brokenStream, { headers: { "content-type": "application/json" } }), "flux_policy"); throw new Error("expected stream failure"); }
    catch (error) { streamFailure = error as FluxControlError; }
    expect(streamFailure).toMatchObject({ code: "TRANSPORT_FAILED", message: "Flux response stream failed before a complete envelope was received." });
    expect(streamFailure.message).not.toContain(streamSecret);

    const receiptSecret = "SECRET_PROMPT_C:/private/key.pem";
    const diagnostic = createFluxDiagnostic("PROVIDER_REQUEST_FAILED", { category: "fixture" });
    const maliciousReceipt = { schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "interpret_run", idempotencyKey: "key", requestDigest: "0".repeat(64), projectId: "project_x", threadId: "thread_x", runId: "run_x", diagnosticIdentity: canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION), terminalPhase: "blocked", outcome: "failed", completedAt: "2026-09-07T00:00:00.000Z", identity: canonicalIdentity({}, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION), prompt: receiptSecret };
    let receiptFailure: FluxControlError;
    try { await parseFluxControlResponse(new Response(JSON.stringify({ ok: false, requestId: "receipt-current-1", error: { code: "BAD", message: "fixed", retryable: false, details: {}, diagnostic, terminalFailureReceipt: maliciousReceipt } }), { status: 409, headers: { "content-type": "application/json" } }), "flux_interpret"); throw new Error("expected receipt failure"); }
    catch (error) { receiptFailure = error as FluxControlError; }
    expect(receiptFailure.code).toBe("RESPONSE_MALFORMED");
    expect(receiptFailure.message).not.toContain(receiptSecret);
  });

  it("maps unknown remote error codes to one fixed safe code for every operation", async () => {
    const secretCode = "SECRET_PROMPT_CODE_LEAK";
    const secretPath = "C:\\private\\prompt-and-key.pem";
    const secretCredential = "Bearer sk-proj-not-for-output";
    const operations = [
      "flux_readiness", "flux_policy", "flux_sources", "flux_projects", "flux_threads",
      "flux_create_project", "flux_create_thread", "flux_create_run", "flux_get_run",
      "flux_interpret", "flux_clarify", "flux_prepare", "flux_open", "flux_checkpoint_open",
      "flux_approval_subject", "flux_approve", "flux_resume", "flux_contract", "flux_poll",
      "flux_reports", "flux_preview", "flux_preview_refresh", "flux_inspection_snapshot", "flux_inspection",
    ] as const;
    for (const operation of operations) {
      const parsed = await parseFluxControlResponse(new Response(JSON.stringify({
        ok: false,
        requestId: `request-${operation}`,
        error: { code: secretCode, message: secretPath, retryable: false, details: { credential: secretCredential } },
      }), { status: 422, headers: { "content-type": "application/json" } }), operation);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("expected a remote failure envelope");
      expect(parsed.error).toEqual({ code: "REMOTE_FAILURE", message: "Flux server rejected the request.", retryable: false, details: {} });
      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain(secretCode);
      expect(serialized).not.toContain(secretPath);
      expect(serialized).not.toContain(secretCredential);
    }
  });

  it("rejects swapped IDs before authority lookup, intent persistence, or mutation", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer();
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname === `/api/v1/flux/runs/${run.id}`
      ? { ...envelope, result: { ...(envelope.result as FluxRunDto), id: "run_swapped" } }
      : envelope;
    const statePath = path.join(root, "swapped.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    await expect(control.status(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    await expect(control.interpret(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(server.requests.filter((entry) => entry.method === "POST")).toHaveLength(0);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists one idempotency key before a lost response and reuses it after restart without storing the prompt", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer();
    const project = server.addProject(); const thread = server.addThread(project.id);
    const secretPrompt = "SECRET_PROMPT_does_not_belong_in_the_intent_store";
    server.loseNextMutationResponse = true;
    await expect(client(root, server).createGenericRun(project.id, thread.id, secretPrompt)).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    const firstPosts = server.requests.filter((entry) => entry.method === "POST" && entry.pathname.endsWith("/runs"));
    expect(firstPosts).toHaveLength(1);
    const stateAfterLoss = await readFile(path.join(root, "intents.json"), "utf8");
    expect(stateAfterLoss).not.toContain(secretPrompt);
    expect(stateAfterLoss).toContain('"status":"pending"');

    const replay = await client(root, server).createGenericRun(project.id, thread.id, secretPrompt);
    const posts = server.requests.filter((entry) => entry.method === "POST" && entry.pathname.endsWith("/runs"));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);
    expect(replay.result).not.toHaveProperty("prompt");
    expect(JSON.stringify(replay)).not.toContain(secretPrompt);
    const settledState = await readFile(path.join(root, "intents.json"), "utf8");
    expect(settledState).toContain('"status":"completed"');
    expect(settledState).toContain(`"lastRequestId":"${replay.requestId}"`);
  });

  it("creates a policy-bound project, thread, and generic run without accepting caller-selected provider policy", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    const project = (await control.createProject("reference", "ChatGPT control")).result;
    const thread = (await control.createThread(project.id, "Generic design")).result;
    const run = (await control.createGenericRun(project.id, thread.id, "private prompt", 3)).result;
    expect(run).toMatchObject({ projectId: project.id, threadId: thread.id, workflowKind: "generic", providerModel: FIXTURE_POLICY.providerModel, iterationCap: 3 });
    expect(run).not.toHaveProperty("prompt");
    expect(server.requests.find((entry) => entry.pathname === "/api/v1/flux/runs" && entry.method === "POST")?.body).toMatchObject({ providerModel: FIXTURE_POLICY.providerModel, workflowKind: "generic", iterationCap: 3 });
  });

  it("keeps the recommended budget at twelve and creates a distinct approved-policy intent for twenty-four", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    const project = server.addProject(); const thread = server.addThread(project.id);
    expect((await control.policy()).result).toMatchObject({ iterationCap: { minimum: 1, maximum: 24, recommended: 12 } });
    expect((await control.createGenericRun(project.id, thread.id, "same design")).result).toMatchObject({ iterationCap: 12 });
    expect((await control.createGenericRun(project.id, thread.id, "same design", 24)).result).toMatchObject({ iterationCap: 24 });
    const posts = server.requests.filter((request) => request.method === "POST" && request.pathname === "/api/v1/flux/runs");
    expect(posts).toHaveLength(2); expect(posts[0]!.idempotencyKey).not.toBe(posts[1]!.idempotencyKey);
    await expect(control.createGenericRun(project.id, thread.id, "same design", 25)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname === "/api/v1/flux/runs")).toHaveLength(2);
  });

  it("rejects separate and combined fresh-profile drift without consuming create-run intent", async () => {
    for (const [label, drift] of [
      ["acceptance", { freshAcceptanceProfileIdentity: "wrong-acceptance" }],
      ["persistence", { freshPersistenceProfileIdentity: "wrong-persistence" }],
      ["combined", { freshAcceptanceProfileIdentity: "wrong-acceptance", freshPersistenceProfileIdentity: "wrong-persistence" }],
    ] as const) {
      const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id);
      server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname === "/api/v1/flux/runs"
        ? { ...envelope, result: { ...(envelope.result as FluxRunDto), ...drift } }
        : envelope;
      await expect(client(root, server).createGenericRun(project.id, thread.id, `profile drift ${label}`)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      expect(await readFile(path.join(root, "intents.json"), "utf8")).toContain('"status":"pending"');
    }
  });

  it("rejects source, policy, origin, malformed receipt, and consumed-result drift", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer();
    const project = server.addProject(); const thread = server.addThread(project.id);
    server.loseNextMutationResponse = true;
    await expect(client(root, server).createGenericRun(project.id, thread.id, "stable logical request")).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    server.sources[0] = { ...server.sources[0]!, fingerprint: "f".repeat(64) };
    await expect(client(root, server).createGenericRun(project.id, thread.id, "stable logical request")).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    await expect(client(root, server, "http://localhost:8765").createGenericRun(project.id, thread.id, "stable logical request")).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });

    const malformedRoot = await temporary(); const malformedServer = new FakeFluxControlServer();
    malformedServer.mutateResponse = (envelope, request) => request.method === "POST" ? { ...envelope, extra: "unbound" } : envelope;
    await expect(client(malformedRoot, malformedServer).createProject("reference", "Exact")).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    expect(await readFile(path.join(malformedRoot, "intents.json"), "utf8")).toContain('"status":"pending"');
    malformedServer.mutateResponse = undefined;
    const completed = await client(malformedRoot, malformedServer).createProject("reference", "Exact");
    expect(completed.intent?.status).toBe("completed");
    malformedServer.mutateResponse = (envelope, request) => request.method === "POST" && envelope.ok === true
      ? { ...envelope, result: { ...(envelope.result as object), createdAt: "2026-09-07T00:01:00.000Z" } }
      : envelope;
    await expect(client(malformedRoot, malformedServer).createProject("reference", "Exact")).rejects.toMatchObject({ code: "INTENT_CONFLICT" });

    const policyRoot = await temporary(); const policyServer = new FakeFluxControlServer();
    const policyProject = policyServer.addProject(); const policyThread = policyServer.addThread(policyProject.id);
    policyServer.loseNextMutationResponse = true;
    await expect(client(policyRoot, policyServer).createGenericRun(policyProject.id, policyThread.id, "policy-bound")).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    policyServer.policy = { ...FIXTURE_POLICY, harnessRuleIdentity: "changed-policy" };
    await expect(client(policyRoot, policyServer).createGenericRun(policyProject.id, policyThread.id, "policy-bound")).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });

    const runRoot = await temporary(); const runServer = new FakeFluxControlServer();
    const runProject = runServer.addProject(); const runThread = runServer.addThread(runProject.id); const run = runServer.addRun(runProject.id, runThread.id);
    runServer.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/interpret")
      ? { ...envelope, result: { ...(envelope.result as FluxRunDto), providerModel: { provider: "codex", model: "misbound", tier: "priority" } } }
      : envelope;
    await expect(client(runRoot, runServer).interpret(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(await readFile(path.join(runRoot, "intents.json"), "utf8")).toContain('"status":"pending"');
  });

  it("rejects descriptor-read pathname swaps for intent manifests and approval views", async () => {
    for (const target of ["intent", "approval-view"] as const) {
      const root = await temporary(); const statePath = path.join(root, `${target}.json`); const baseUrl = "http://127.0.0.1:8765";
      const initial = new FluxControlIntentStore(statePath, baseUrl);
      if (target === "intent") {
        await initial.begin({ operation: "create_project", logicalDigest: "1".repeat(64), requestDigest: "2".repeat(64), authority: { baseUrl, policyDigest: "3".repeat(64), sourceKey: "reference", sourceFingerprint: "4".repeat(64), projectDigest: null, threadDigest: null, runDigest: null } });
      } else {
        await initial.recordApprovalView("run_fixture", "5".repeat(64), "6".repeat(64), "request-view-1");
      }
      let swapped = false;
      const store = new FluxControlIntentStore(statePath, baseUrl, { afterManifestReadForTesting: async (_label, filePath) => {
        if (swapped) return; swapped = true; const bytes = await readFile(filePath); await rename(filePath, `${filePath}.preimage`); await writeFile(filePath, bytes);
      } });
      const read = target === "intent" ? store.getIntent("intent_missing_00000000000000000000000000000000") : store.approvalView("run_fixture");
      await expect(read).rejects.toMatchObject({ code: "STORE_CORRUPT" });
      expect(swapped).toBe(true);
    }
  });

  it("verifies an atomically published intent through a descriptor-bound readback", async () => {
    const root = await temporary(); const statePath = path.join(root, "write-readback.json"); const baseUrl = "http://127.0.0.1:8765"; let swapped = false;
    const store = new FluxControlIntentStore(statePath, baseUrl, { afterManifestReadForTesting: async (_label, filePath) => {
      if (swapped) return; swapped = true; const bytes = await readFile(filePath); await rename(filePath, `${filePath}.published`); await writeFile(filePath, bytes);
    } });
    await expect(store.begin({ operation: "create_project", logicalDigest: "7".repeat(64), requestDigest: "8".repeat(64), authority: { baseUrl, policyDigest: "9".repeat(64), sourceKey: "reference", sourceFingerprint: "a".repeat(64), projectDigest: null, threadDigest: null, runDigest: null } })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect(swapped).toBe(true);
  });

  it("preflights intent and approval-view cardinality without corrupting a full readable store", async () => {
    const root = await temporary(); const baseUrl = "http://127.0.0.1:8765";
    const authority = { baseUrl, policyDigest: "3".repeat(64), sourceKey: "reference", sourceFingerprint: "4".repeat(64), projectDigest: null, threadDigest: null, runDigest: null };
    const intentPath = path.join(root, "intent-cap.json");
    const intents = new FluxControlIntentStore(intentPath, baseUrl, { maximumIntentsForTesting: 1 });
    const first = await intents.begin({ operation: "create_project", logicalDigest: "1".repeat(64), requestDigest: "2".repeat(64), authority });
    const intentPreimage = await readFile(intentPath);
    await expect(intents.begin({ operation: "create_project", logicalDigest: "5".repeat(64), requestDigest: "6".repeat(64), authority })).rejects.toMatchObject({ code: "STORE_CAPACITY" });
    expect(await readFile(intentPath)).toEqual(intentPreimage);
    await expect(intents.getIntent(first.intentId)).resolves.toEqual(first);

    const viewPath = path.join(root, "view-cap.json");
    const views = new FluxControlIntentStore(viewPath, baseUrl, { maximumApprovalViewsForTesting: 1 });
    const firstView = await views.recordApprovalView("run_first", "7".repeat(64), "8".repeat(64), "request-view-1");
    const viewPreimage = await readFile(viewPath);
    await expect(views.recordApprovalView("run_second", "9".repeat(64), "a".repeat(64), "request-view-2")).rejects.toMatchObject({ code: "STORE_CAPACITY" });
    expect(await readFile(viewPath)).toEqual(viewPreimage);
    await expect(views.approvalView("run_first")).resolves.toEqual(firstView);
  });

  it("fails closed when the held lock pathname is renamed, replaced, or hard-linked", async () => {
    for (const attack of ["rename", "replace", "hardlink"] as const) {
      const root = await temporary(); const baseUrl = "http://127.0.0.1:8765"; const statePath = path.join(root, `${attack}.json`);
      const initial = new FluxControlIntentStore(statePath, baseUrl);
      const authority = { baseUrl, policyDigest: "3".repeat(64), sourceKey: "reference", sourceFingerprint: "4".repeat(64), projectDigest: null, threadDigest: null, runDigest: null };
      await initial.begin({ operation: "create_project", logicalDigest: "1".repeat(64), requestDigest: "2".repeat(64), authority });
      const statePreimage = await readFile(statePath); const lockPath = `${statePath}.lock`; const displaced = `${lockPath}.displaced`; let attacked = false;
      const store = new FluxControlIntentStore(statePath, baseUrl, { afterManifestReadForTesting: async (label) => {
        if (attacked || label !== "Flux intent store") return;
        attacked = true;
        if (attack === "hardlink") await link(lockPath, displaced);
        else {
          await rename(lockPath, displaced);
          if (attack === "replace") await writeFile(lockPath, "replacement-lock-token\n", "utf8");
        }
      } });
      await expect(store.begin({ operation: "create_project", logicalDigest: "5".repeat(64), requestDigest: "6".repeat(64), authority })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
      expect(attacked).toBe(true);
      expect(await readFile(statePath)).toEqual(statePreimage);
      expect((await readFile(displaced, "utf8")).length).toBeGreaterThan(0);
      if (attack === "replace") await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement-lock-token\n");
      if (attack === "rename") await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      if (attack === "hardlink") await expect(readFile(lockPath, "utf8")).resolves.toMatch(/^evleda-flux-control-lock-v1:/u);
    }
  });

  it("admits only one client while an exact descriptor-bound lock lease is held", async () => {
    const root = await temporary(); const baseUrl = "http://127.0.0.1:8765"; const statePath = path.join(root, "concurrent.json");
    const authority = { baseUrl, policyDigest: "3".repeat(64), sourceKey: "reference", sourceFingerprint: "4".repeat(64), projectDigest: null, threadDigest: null, runDigest: null };
    await new FluxControlIntentStore(statePath, baseUrl).begin({ operation: "create_project", logicalDigest: "1".repeat(64), requestDigest: "2".repeat(64), authority });
    let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    const first = new FluxControlIntentStore(statePath, baseUrl, { afterManifestReadForTesting: async (label) => {
      if (paused || label !== "Flux intent store") return;
      paused = true; enter(); await released;
    } });
    const transaction = first.begin({ operation: "create_project", logicalDigest: "5".repeat(64), requestDigest: "6".repeat(64), authority });
    await entered;
    const second = new FluxControlIntentStore(statePath, baseUrl);
    await expect(second.begin({ operation: "create_project", logicalDigest: "7".repeat(64), requestDigest: "8".repeat(64), authority })).rejects.toMatchObject({ code: "STORE_BUSY" });
    release();
    await expect(transaction).resolves.toMatchObject({ logicalDigest: "5".repeat(64) });
    await expect(readFile(`${statePath}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps lifecycle commands phase-aware and requires a persisted exact approval-subject observation", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await expect(control.prepare(run.id)).rejects.toMatchObject({ code: "PHASE_MISMATCH" });
    expect((await control.interpret(run.id)).result).toMatchObject({ phase: "contract_ready" });
    expect((await control.prepare(run.id)).result).toMatchObject({ phase: "awaiting_open" });
    expect((await control.open(run.id)).result).toMatchObject({ opened: true, checkpointRequired: true });
    expect((await control.checkpoint(run.id)).result).toMatchObject({ phase: "awaiting_approval" });
    const subject = server.approvalSubject(server.runs.find((entry) => entry.id === run.id)!);
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/approval")
      ? { ...envelope, result: { ...(envelope.result as { subject: object; digest: string }), subject: { ...(envelope.result as { subject: object }).subject, sourceFingerprint: "f".repeat(64) } } }
      : envelope;
    await expect(control.approvalSubject(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    server.mutateResponse = undefined;
    await expect(control.approve(run.id, subject.digest)).rejects.toMatchObject({ code: "APPROVAL_NOT_OBSERVED" });
    const observed = await control.approvalSubject(run.id);
    expect(observed.result.digest).toBe(subject.digest);
    expect(observed.result.subject.schemaVersion).toBe("evleda.flux-approval-subject.v6");
    expect(observed.result.subject.ipcProbeSemanticIdentity.schemaVersion).toBe("evleda.flux-open-ipc-probe-semantic.v2");
    expect(observed.result.subject.freshNetClassSemanticAuthorityIdentity?.schemaVersion).toBe("evleda.fresh-netclass-semantic-authority.v2");
    expect(observed.result.subject.freshProjectOpenPreparedSourceAuthorityIdentity?.schemaVersion).toBe("evleda.fresh-project-open-prepared-source-authority.v1");
    expect(observed.result.subject.freshNetClassPreparationEvidenceIdentity?.schemaVersion).toBe("evleda.fresh-netclass-preparation-evidence.v2");
    await expect(control.approve(run.id, "0".repeat(64))).rejects.toMatchObject({ code: "APPROVAL_NOT_OBSERVED" });
    expect((await control.approve(run.id, observed.result.digest)).result).toMatchObject({ phase: "approved" });
    expect((await control.resume(run.id)).result).toMatchObject({ phase: "queued" });
    const mutationPaths = server.requests.filter((entry) => entry.method === "POST").map((entry) => entry.pathname);
    expect(mutationPaths).toEqual([
      `/api/v1/flux/runs/${run.id}/interpret`, `/api/v1/flux/runs/${run.id}/prepare`,
      `/api/v1/flux/projects/${project.id}/open`, `/api/v1/flux/runs/${run.id}/checkpoint-open`,
      `/api/v1/flux/runs/${run.id}/approval`, `/api/v1/flux/runs/${run.id}/resume`,
    ]);
  });

  it("rejects legacy approval envelopes and v6 subjects with cache-based child identities before client resume", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "legacy-resume.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const observed = await control.approvalSubject(run.id); await control.approve(run.id, observed.result.digest);
    const current = server.runs.find((entry) => entry.id === run.id)!; const currentSubject = server.approvalSubject(current).subject;
    const { freshNetClassPreparationEvidenceIdentity: _preparationEvidence, ...legacyV5Fields } = currentSubject;
    const legacyV5Subject = { ...legacyV5Fields, schemaVersion: "evleda.flux-approval-subject.v5" };
    const { freshProjectOpenPreparedSourceAuthorityIdentity: _preparedSource, ...legacyV4Fields } = legacyV5Fields;
    const legacyV4Subject = { ...legacyV4Fields, schemaVersion: "evleda.flux-approval-subject.v4" };
    const { freshNetClassSemanticAuthorityIdentity: _semantic, ...legacyV3Fields } = legacyV4Fields;
    const legacyV3Subject = { ...legacyV3Fields, schemaVersion: "evleda.flux-approval-subject.v3" };
    const legacyChildrenSubject = { ...currentSubject,
      freshNetClassSemanticAuthorityIdentity: canonicalIdentity({ historical: "semantic" }, "evleda.fresh-netclass-semantic-authority.v1"),
      freshNetClassPreparationEvidenceIdentity: canonicalIdentity({ historical: "preparation" }, "evleda.fresh-netclass-preparation-evidence.v1") };
    for (const legacySubject of [legacyV3Subject, legacyV4Subject, legacyV5Subject, legacyChildrenSubject,
      { ...currentSubject, freshNetClassSemanticAuthorityIdentity: legacyChildrenSubject.freshNetClassSemanticAuthorityIdentity },
      { ...currentSubject, freshNetClassPreparationEvidenceIdentity: legacyChildrenSubject.freshNetClassPreparationEvidenceIdentity }]) {
      server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/approval") ? { ...envelope, result: { subject: legacySubject, digest: fluxDigest(legacySubject) } } : envelope;
      await expect(control.resume(run.id)).rejects.toMatchObject({ code: (legacySubject as Record<string, unknown>).schemaVersion === "evleda.flux-approval-subject.v6" ? "AUTHORITY_DRIFT" : "RESPONSE_MALFORMED" });
      expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/resume"))).toHaveLength(0);
      expect(await readFile(statePath, "utf8")).not.toContain('"operation":"resume_run"');
    }
    server.mutateResponse = undefined;
    await expect(control.resume(run.id)).resolves.toMatchObject({ result: { phase: "queued" }, intent: { status: "completed" } });
  });

  it("rejects legacy Open/checkpoint receipt domains inside a self-consistent v6 subject before approve or resume", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "legacy-receipt-chain.json"); const baseUrl = "http://127.0.0.1:8765";
    const control = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const forgedSubject = () => {
      const current = server.runs.find((entry) => entry.id === run.id)!; const subject = server.approvalSubject(current).subject;
      return { ...subject, openPreflightReceiptIdentity: canonicalIdentity({ legacy: "preflight" }, "evleda.flux-open-preflight.v3"), openCheckpointReceiptIdentity: canonicalIdentity({ legacy: "checkpoint" }, "evleda.flux-open-checkpoint.v4") };
    };
    let forged = forgedSubject();
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/approval") ? { ...envelope, result: { subject: forged, digest: fluxDigest(forged) } } : envelope;
    await expect(control.approvalSubject(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    await expect(control.approve(run.id, fluxDigest(forged))).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/approval"))).toHaveLength(0);
    expect(await readFile(statePath, "utf8")).not.toContain('"operation":"approve_run"');
    server.mutateResponse = undefined;
    const observed = await control.approvalSubject(run.id); await control.approve(run.id, observed.result.digest);
    forged = forgedSubject();
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/approval") ? { ...envelope, result: { subject: forged, digest: fluxDigest(forged) } } : envelope;
    await expect(control.resume(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/resume"))).toHaveLength(0);
    expect(await readFile(statePath, "utf8")).not.toContain('"operation":"resume_run"');
    server.mutateResponse = undefined;
    await expect(control.resume(run.id)).resolves.toMatchObject({ result: { phase: "queued" }, intent: { status: "completed" } });
  });

  it("replays a lost resume response from queued only through the exact pending durable intent", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "resume-replay.json"); const baseUrl = "http://127.0.0.1:8765";
    const control = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const observed = await control.approvalSubject(run.id); await control.approve(run.id, observed.result.digest);
    server.loseNextMutationResponse = true;
    await expect(control.resume(run.id)).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    expect(server.runs.find((entry) => entry.id === run.id)).toMatchObject({ phase: "queued", approval: { consumedAt: "2026-09-07T00:00:07.000Z" } });
    let manifest = JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, { operation: string; status: string }> };
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "resume_run")?.status).toBe("pending");
    const restarted = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    await expect(restarted.resume(run.id)).resolves.toMatchObject({ result: { phase: "queued" }, intent: { status: "completed" } });
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/resume"));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
    manifest = JSON.parse(await readFile(statePath, "utf8")) as typeof manifest;
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "resume_run")?.status).toBe("completed");
    const emptyStatePath = path.join(root, "resume-no-intent.json");
    const noIntent = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(emptyStatePath, baseUrl) });
    await expect(noIntent.resume(run.id)).rejects.toMatchObject({ code: "APPROVAL_NOT_OBSERVED" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/resume"))).toHaveLength(2);
    await expect(readFile(emptyStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects every generic approval artifact that drifts from the run's v2 interpreter receipt", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const store = new FluxControlIntentStore(path.join(root, "intents.json"), "http://127.0.0.1:8765");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: store });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const current = server.runs.find((entry) => entry.id === run.id)!;
    const baseline = server.approvalSubject(current).subject;
    const alternateBundle = createGenericDividerBundleFixture("Build a distinct generic divider candidate.");
    const alternateProvider = createPcbProviderProfileBinding({ provider: "codex", model: "gpt-test", tier: "priority", adapterSchemaVersion: "different-fixture" });
    const alternateIdentity = (key: string) => {
      const currentIdentity = baseline[key] as { schemaVersion: string };
      return canonicalIdentity({ key, drift: true }, currentIdentity.schemaVersion);
    };
    const drifted: readonly (readonly [string, unknown])[] = [
      ["compilationBundleRef", alternateBundle.reference], ["bundleIdentity", alternateBundle.bundle.identity],
      ["compilerProfileIdentity", alternateIdentity("compilerProfileIdentity")],
      ["practiceProfileBindingIdentity", alternateIdentity("practiceProfileBindingIdentity")],
      ["providerProfile", alternateProvider], ["contractIdentity", alternateIdentity("contractIdentity")],
      ["libraryBindingIdentity", alternateIdentity("libraryBindingIdentity")],
      ["deepRuleBindingIdentity", alternateIdentity("deepRuleBindingIdentity")],
      ["acceptancePlanIdentity", alternateIdentity("acceptancePlanIdentity")],
      ["kicadToolchainIdentity", alternateIdentity("kicadToolchainIdentity")],
      ["inspectionBridgeIdentity", alternateIdentity("inspectionBridgeIdentity")],
      ["executionBridgeIdentity", alternateIdentity("executionBridgeIdentity")],
      ["ipcProbeSemanticIdentity", canonicalIdentity({ drift: true }, "evleda.wrong-ipc-probe-semantic.v1")],
      ["freshNetClassSemanticAuthorityIdentity", canonicalIdentity({ drift: true }, "evleda.wrong-netclass-semantic.v1")],
      ["freshProjectOpenPreparedSourceAuthorityIdentity", canonicalIdentity({ drift: true }, "evleda.wrong-prepared-source.v1")],
      ["freshNetClassPreparationEvidenceIdentity", canonicalIdentity({ drift: true }, "evleda.wrong-preparation-evidence.v1")],
      ["openPreflightReceiptIdentity", canonicalIdentity({ legacy: true }, "evleda.flux-open-preflight.v4")],
      ["openCheckpointReceiptIdentity", canonicalIdentity({ legacy: true }, "evleda.flux-open-checkpoint.v5")],
    ];
    for (const [key, value] of drifted) {
      const forged = { ...baseline, [key]: value };
      server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/approval")
        ? { ...envelope, result: { subject: forged, digest: fluxDigest(forged) } }
        : envelope;
      await expect(control.approvalSubject(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      await expect(store.approvalView(run.id)).resolves.toBeUndefined();
    }
    server.mutateResponse = undefined;
  });

  it("rejects an Open label carrying the prompt and leaves its intent unconsumed", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer();
    const project = server.addProject(); const thread = server.addThread(project.id); const prompt = "SECRET_OPEN_PROMPT"; const run = server.addRun(project.id, thread.id, "awaiting_open", prompt);
    server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/open")
      ? { ...envelope, result: { opened: true, label: prompt, checkpointRequired: true } }
      : envelope;
    const statePath = path.join(root, "open.json"); const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    let failure: FluxControlError;
    try { await control.open(run.id); throw new Error("expected Open rejection"); } catch (error) { failure = error as FluxControlError; }
    expect(failure).toMatchObject({ code: "RESPONSE_MALFORMED", message: "Flux open result did not match the fixed server confirmation." });
    expect(failure.message).not.toContain(prompt);
    const state = await readFile(statePath, "utf8"); expect(state).toContain('"status":"pending"'); expect(state).not.toContain(prompt);
  });

  it("consumes only a terminal receipt authenticated by the current response and blocked run", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer();
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    const baseFetch = server.fetch;
    const terminalFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/interpret")) return baseFetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key")!;
      const completedAt = "2026-09-07T00:02:00.000Z";
      const diagnostic = createFluxDiagnostic("PROVIDER_REQUEST_FAILED", { category: "fixture" });
      server.replaceRun(run.id, { phase: "blocked", diagnostic, updatedAt: completedAt });
      const payload = {
        schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
        operation: "interpret_run" as const,
        idempotencyKey: key,
        requestDigest: fluxDigest({ runId: run.id, answers: [] }),
        projectId: project.id,
        threadId: thread.id,
        runId: run.id,
        diagnosticIdentity: canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION),
        terminalPhase: "blocked" as const,
        outcome: "failed" as const,
        completedAt,
      };
      const receipt = { ...payload, identity: canonicalIdentity(payload, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION) };
      return new Response(JSON.stringify({ ok: false, requestId: "terminal-response-1", error: { code: "OPERATION_UNCERTAIN", message: "fixed", retryable: false, details: {}, diagnostic, terminalFailureReceipt: receipt } }), { status: 409, headers: { "content-type": "application/json" } });
    };
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: terminalFetch, intentStore: new FluxControlIntentStore(path.join(root, "terminal.json"), "http://127.0.0.1:8765") });
    await expect(control.interpret(run.id)).rejects.toMatchObject({ code: "REMOTE_ERROR", requestId: "terminal-response-1" });
    const stored = await readFile(path.join(root, "terminal.json"), "utf8");
    expect(stored).toContain('"status":"terminal"');
    expect(stored).toContain('"lastRequestId":"terminal-response-1"');

    const badRoot = await temporary(); const badServer = new FakeFluxControlServer();
    const badProject = badServer.addProject(); const badThread = badServer.addThread(badProject.id); const badRun = badServer.addRun(badProject.id, badThread.id);
    const badBase = badServer.fetch;
    const badFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/interpret")) return badBase(input, init);
      const diagnostic = createFluxDiagnostic("PROVIDER_REQUEST_FAILED", { category: "fixture" });
      const fake = { schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "interpret_run", idempotencyKey: "wrong", requestDigest: "0".repeat(64), projectId: badProject.id, threadId: badThread.id, runId: badRun.id, diagnosticIdentity: canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION), terminalPhase: "blocked", outcome: "failed", completedAt: "2026-09-07T00:03:00.000Z", identity: canonicalIdentity({}, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION) };
      return new Response(JSON.stringify({ ok: false, requestId: "terminal-bad-1", error: { code: "OPERATION_UNCERTAIN", message: "fixed", retryable: false, details: {}, diagnostic, terminalFailureReceipt: fake } }), { status: 409, headers: { "content-type": "application/json" } });
    };
    const badControl = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: badFetch, intentStore: new FluxControlIntentStore(path.join(badRoot, "bad.json"), "http://127.0.0.1:8765") });
    await expect(badControl.interpret(badRun.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    expect(await readFile(path.join(badRoot, "bad.json"), "utf8")).toContain('"status":"pending"');
  });

  it.each([FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE])("settles a checkpoint failure and replays its exact key after restart: %s", async (message) => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_checkpoint");
    const statePath = path.join(root, "checkpoint-terminal.json"); const baseUrl = "http://127.0.0.1:8765";
    const keys: string[] = []; let sideEffects = 0; let receipt: ReturnType<typeof checkpointFailureReceipt> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/checkpoint-open")) return server.fetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key")!; keys.push(key); expect(JSON.parse(String(init?.body))).toEqual({});
      if (receipt === undefined) {
        sideEffects += 1; receipt = checkpointFailureReceipt(run, key, message);
        server.replaceRun(run.id, { phase: "blocked", checkpointRequired: true, blockedReason: message, updatedAt: receipt.completedAt });
      }
      return new Response(JSON.stringify({ ok: false, requestId: `checkpoint-terminal-${keys.length}`, error: { code: "OPERATION_UNCERTAIN", message, retryable: false, details: {}, terminalFailureReceipt: receipt } }), { status: 409, headers: { "content-type": "application/json" } });
    };
    const createClient = () => new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const control = createClient();
    await expect(control.checkpoint(run.id)).rejects.toMatchObject({ code: "REMOTE_ERROR", requestId: "checkpoint-terminal-1", retryable: false, remote: { code: "OPERATION_UNCERTAIN", terminalFailureReceipt: { schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open" } } });
    const readIntent = async () => Object.values((JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, Record<string, unknown>> }).intents)[0]!;
    const first = await readIntent();
    expect(first).toMatchObject({ operation: "checkpoint_open", status: "terminal", lastRequestId: "checkpoint-terminal-1", terminalReceiptIdentity: receipt!.identity });
    await expect(control.checkpoint(run.id)).rejects.toMatchObject({ code: "REMOTE_ERROR", requestId: "checkpoint-terminal-2", retryable: false });
    await expect(createClient().checkpoint(run.id)).rejects.toMatchObject({ code: "REMOTE_ERROR", requestId: "checkpoint-terminal-3", retryable: false });
    expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(1); expect(sideEffects).toBe(1);
    expect(await readIntent()).toMatchObject({ intentId: first.intentId, idempotencyKey: first.idempotencyKey, status: "terminal", resultDigest: first.resultDigest, terminalReceiptIdentity: first.terminalReceiptIdentity, lastRequestId: "checkpoint-terminal-3" });
    expect(server.runs[0]).toMatchObject({ phase: "blocked", checkpointRequired: true, iterationCap: 12, reports: [] });
    expect(server.runs[0]?.approval).toBeUndefined();
  });

  it("keeps a lost checkpoint failure response pending until same-key replay authenticates the receipt", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_checkpoint");
    const statePath = path.join(root, "checkpoint-lost-failure.json"); const baseUrl = "http://127.0.0.1:8765"; const keys: string[] = [];
    let receipt: ReturnType<typeof checkpointFailureReceipt> | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/checkpoint-open")) return server.fetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key")!; keys.push(key);
      if (receipt === undefined) {
        receipt = checkpointFailureReceipt(run, key);
        server.replaceRun(run.id, { phase: "blocked", checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, updatedAt: receipt.completedAt });
        throw new TypeError("lost response after terminal commit");
      }
      return new Response(JSON.stringify({ ok: false, requestId: "checkpoint-recovered-failure", error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, retryable: false, details: {}, terminalFailureReceipt: receipt } }), { status: 409, headers: { "content-type": "application/json" } });
    };
    const createClient = () => new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    await expect(createClient().checkpoint(run.id)).rejects.toMatchObject({ code: "TRANSPORT_FAILED", retryable: true });
    expect(await readFile(statePath, "utf8")).toContain('"status":"pending"');
    await expect(createClient().checkpoint(run.id)).rejects.toMatchObject({ code: "REMOTE_ERROR", retryable: false, requestId: "checkpoint-recovered-failure" });
    expect(await readFile(statePath, "utf8")).toContain('"status":"terminal"');
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  });

  it("rejects malformed or misbound checkpoint failures without settling the pending intent", async () => {
    const cases: readonly { receipt?: Record<string, unknown>; error?: Record<string, unknown>; identity?: boolean }[] = [
      { receipt: { idempotencyKey: `fluxctl.${"0".repeat(32)}` } }, { receipt: { requestDigest: "0".repeat(64) } },
      { receipt: { projectId: "project_other" } }, { receipt: { threadId: "thread_other" } }, { receipt: { runId: "run_other" } },
      { receipt: { operation: "interpret_run" } }, { receipt: { schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION } },
      { receipt: { terminalPhase: "awaiting_checkpoint" } }, { receipt: { outcome: "succeeded" } }, { receipt: { completedAt: "not-a-time" } },
      { receipt: { failureIdentity: canonicalIdentity({}, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION) } }, { identity: true },
      { receipt: { diagnosticIdentity: canonicalIdentity({}, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION) } },
      { receipt: { privatePath: "C:/private/checkpoint-secret" } },
      { error: { code: "TOOLCHAIN_UNAVAILABLE" } }, { error: { retryable: true } }, { error: { message: "C:/private/checkpoint-secret" } },
      { error: { details: { path: "C:/private/checkpoint-secret" } } }, { error: { diagnostic: createFluxDiagnostic("TOOLCHAIN_FAILURE", { category: "fixture" }) } },
    ];
    for (const attack of cases) {
      const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_checkpoint");
      const statePath = path.join(root, "checkpoint-rejected.json"); const baseUrl = "http://127.0.0.1:8765";
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/checkpoint-open")) return server.fetch(input, init);
        const key = new Headers(init?.headers).get("idempotency-key")!;
        const receipt = checkpointFailureReceipt(run, key, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, attack.receipt);
        if (attack.identity) receipt.identity = canonicalIdentity({}, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION);
        server.replaceRun(run.id, { phase: "blocked", checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, updatedAt: "2026-09-08T00:02:00.000Z" });
        return new Response(JSON.stringify({ ok: false, requestId: "checkpoint-rejected", error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, retryable: false, details: {}, terminalFailureReceipt: receipt, ...attack.error } }), { status: 409, headers: { "content-type": "application/json" } });
      };
      const control = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
      await expect(control.checkpoint(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED", retryable: false });
      const stored = await readFile(statePath, "utf8"); expect(stored).toContain('"status":"pending"'); expect(stored).not.toContain("checkpoint-secret");
    }
  });

  it("requires a fresh matching blocked checkpoint snapshot before terminal settlement", async () => {
    const cases: readonly Partial<FluxRunDto>[] = [
      { phase: "awaiting_checkpoint" }, { phase: "awaiting_approval" }, { checkpointRequired: false },
      { updatedAt: "2026-09-08T00:03:00.000Z" }, { blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE },
      { projectId: "project_other" }, { threadId: "thread_other" }, { prompt: "changed prompt" }, { iterationCap: 11 },
      { approval: { id: "approval_unexpected", subjectDigest: "0".repeat(64), approvedAt: "2026-09-08T00:01:00.000Z" } },
    ];
    for (const changes of cases) {
      const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_checkpoint");
      const statePath = path.join(root, "checkpoint-snapshot-rejected.json"); const baseUrl = "http://127.0.0.1:8765";
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/checkpoint-open")) return server.fetch(input, init);
        const receipt = checkpointFailureReceipt(run, new Headers(init?.headers).get("idempotency-key")!);
        server.replaceRun(run.id, { phase: "blocked", checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, updatedAt: receipt.completedAt, ...changes });
        return new Response(JSON.stringify({ ok: false, requestId: "checkpoint-snapshot-rejected", error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, retryable: false, details: {}, terminalFailureReceipt: receipt } }), { status: 409, headers: { "content-type": "application/json" } });
      };
      const control = new FluxControlClient({ baseUrl, fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
      await expect(control.checkpoint(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      expect(await readFile(statePath, "utf8")).toContain('"status":"pending"');
    }
  });

  it("separates run-bound inspection status from explicit active inspection and exposes exact budget authority", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    server.replaceRun(run.id, { reports: [{ reportId: "report_fixture", title: "Candidate", digest: "d".repeat(64), mediaType: "application/json", createdAt: "2026-09-07T00:00:08.000Z", summary: run.prompt }] });
    const inspectionSecret = "Bearer SECRET_TOKEN_VALUE";
    server.mutateResponse = (envelope, request) => request.pathname.endsWith("/inspection") ? { ...envelope, result: {
      ...(envelope.result as Record<string, unknown>), state: "ready", busy: false, completedTools: 6, totalTools: 6, capturedAt: "2026-09-07T00:00:09.000Z",
      boardSummary: { tool: "pcb_get_board_summary", value: { note: inspectionSecret, echoed: run.prompt } }, rules: { tool: "pcb_get_design_rules", value: { path: "/etc/private-board", secretToken: "opaque-secret" } },
      footprints: { tool: "pcb_get_footprints", value: {} }, tracks: { tool: "pcb_get_tracks", value: {} }, vias: { tool: "pcb_get_vias", value: {} }, zones: { tool: "pcb_get_zones", value: {} },
    } } : envelope;
    const status = (await control.inspectionStatus(run.id)).result;
    expect(status).toMatchObject({ runId: run.id, state: "ready", connectionBudget: { used: 0, remaining: 8, limit: 8 }, inspectionBridgeIdentity: { schemaVersion: "evleda.kicad-mcp-inspection-bridge.v2" }, executionBridgeIdentity: { schemaVersion: "evleda.kicad-mcp-execution-bridge.v1" }, ipcSocketIdentity: { schemaVersion: "evleda.kicad-api-socket-binding.v1" }, writeSessionAuthorityIdentity: { schemaVersion: "evleda.kicad-mcp-session-authority.v1" } });
    expect(JSON.stringify(status)).not.toContain(inspectionSecret);
    expect(JSON.stringify(status)).not.toContain("/etc/private-board");
    expect(JSON.stringify(status)).not.toContain("opaque-secret");
    expect(JSON.stringify(status)).not.toContain(run.prompt);
    const active = await control.inspect(run.id);
    expect(active.result).toMatchObject({ runId: run.id, state: "ready", connectionBudget: { used: 1, remaining: 7, limit: 8 } });
    expect(JSON.stringify(active.result)).not.toContain(inspectionSecret);
    expect(JSON.stringify(active.result)).not.toContain("/etc/private-board");
    expect(JSON.stringify(active.result)).not.toContain(run.prompt);
    expect(active.intent).toMatchObject({ status: "completed" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"))).toHaveLength(1);
    server.mutateResponse = undefined;
    expect((await control.previews(run.id)).result).toEqual({ refreshedAt: "2026-09-07T00:00:00.000Z", artifacts: [] });
    const reports = (await control.reports(run.id)).result;
    expect(JSON.stringify(reports)).not.toContain(run.prompt);
    expect(JSON.stringify(reports)).toContain("[redacted prompt]");
    expect((await control.poll(run.id)).result).toMatchObject({ run: { id: run.id }, events: [], nextEventSeq: 0 });
    expect(JSON.stringify((await control.status(run.id)).result)).not.toContain(run.prompt);
  });

  it("keeps active inspection pending until ready six-tool evidence advances the current budget", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "incomplete-inspection.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const authorityOnly = (result: Record<string, unknown>) => ({
      runId: result.runId, inspectionBridgeIdentity: result.inspectionBridgeIdentity, executionBridgeIdentity: result.executionBridgeIdentity,
      ipcSocketIdentity: result.ipcSocketIdentity, writeSessionAuthorityIdentity: result.writeSessionAuthorityIdentity,
      connectionBudget: result.connectionBudget, totalTools: 6,
    });
    const cases: readonly (readonly [string, "INCOMPLETE" | "AUTHORITY_DRIFT", (result: Record<string, unknown>) => Record<string, unknown>])[] = [
      ["idle", "INCOMPLETE", (result) => ({ ...authorityOnly(result), state: "idle", busy: false, completedTools: 0 })],
      ["busy", "INCOMPLETE", (result) => ({ ...authorityOnly(result), state: "busy", busy: true, completedTools: 2, activeTool: "pcb_get_footprints" })],
      ["budget-no-change", "AUTHORITY_DRIFT", (result) => ({ ...result, connectionBudget: { used: 0, remaining: 8, limit: 8 } })],
      ["forged-replay-advance", "AUTHORITY_DRIFT", (result) => ({ ...result, connectionBudget: { used: 2, remaining: 6, limit: 8 } })],
      ["missing-tool", "INCOMPLETE", (result) => { const { zones: _zones, ...missing } = result; return missing; }],
    ];
    for (const [_name, code, mutate] of cases) {
      server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/inspection")
        ? { ...envelope, result: mutate(envelope.result as Record<string, unknown>) }
        : envelope;
      await expect(control.inspect(run.id)).rejects.toMatchObject({ code });
      const persisted = await readFile(statePath, "utf8");
      expect(persisted).toContain('"operation":"inspect_run"');
      expect(persisted).toContain('"status":"pending"');
    }
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"));
    expect(attempts).toHaveLength(cases.length);
    expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
    server.mutateResponse = undefined;
    await expect(control.inspect(run.id)).resolves.toMatchObject({ result: { state: "ready", completedTools: 6, connectionBudget: { used: 1, remaining: 7, limit: 8 } }, intent: { status: "completed" } });
    const allAttempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"));
    expect(new Set(allAttempts.map((request) => request.idempotencyKey)).size).toBe(1);
  });

  it("replays an exact lost-response inspection receipt after consuming the last budget unit", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "last-budget-replay.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, "http://127.0.0.1:8765") });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    server.inspectionBudgetUsed = 7; server.loseNextMutationResponse = true;
    await expect(control.inspect(run.id)).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    expect(server.inspectionBudgetUsed).toBe(8);
    let manifest = JSON.parse(await readFile(statePath, "utf8")) as { intents: Record<string, { operation: string; status: string }> };
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "inspect_run")?.status).toBe("pending");
    server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/inspection")
      ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), capturedAt: "2026-09-07T00:00:10.000Z" } }
      : envelope;
    await expect(control.inspect(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    manifest = JSON.parse(await readFile(statePath, "utf8")) as typeof manifest;
    expect(Object.values(manifest.intents).find((intent) => intent.operation === "inspect_run")?.status).toBe("pending");
    server.mutateResponse = undefined;
    await expect(control.inspect(run.id)).resolves.toMatchObject({ result: { state: "ready", completedTools: 6, connectionBudget: { used: 8, remaining: 0, limit: 8 } }, intent: { status: "completed" } });
    expect(server.inspectionBudgetUsed).toBe(8);
    const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"));
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
    const freshState = path.join(root, "fresh-at-zero.json");
    const freshControl = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(freshState, "http://127.0.0.1:8765") });
    await expect(freshControl.inspect(run.id)).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"))).toHaveLength(3);
    await expect(readFile(freshState, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives replay mode atomically when another client completes during the baseline GET", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const statePath = path.join(root, "two-client-inspection.json"); const baseUrl = "http://127.0.0.1:8765";
    const setup = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await setup.interpret(run.id); await setup.prepare(run.id); await setup.open(run.id); await setup.checkpoint(run.id);
    let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    const delayedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!paused && method === "GET" && url.pathname.endsWith("/inspection")) { paused = true; enter(); await released; }
      return server.fetch(input, init);
    };
    const first = new FluxControlClient({ baseUrl, fetch: delayedFetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const second = new FluxControlClient({ baseUrl, fetch: server.fetch, intentStore: new FluxControlIntentStore(statePath, baseUrl) });
    const raced = first.inspect(run.id); await entered;
    let completedBySecond!: Awaited<ReturnType<FluxControlClient["inspect"]>>;
    try { completedBySecond = await second.inspect(run.id); } finally { release(); }
    const exactReplay = await raced;
    expect(completedBySecond).toMatchObject({ result: { state: "ready", connectionBudget: { used: 1, remaining: 7, limit: 8 } }, intent: { status: "completed" } });
    expect(exactReplay).toMatchObject({ result: completedBySecond.result, intent: { idempotencyKey: completedBySecond.intent?.idempotencyKey, status: "completed" } });
    expect(server.inspectionBudgetUsed).toBe(1);
    let attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
    server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/inspection")
      ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), capturedAt: "2026-09-07T00:00:10.000Z" } }
      : envelope;
    await expect(first.inspect(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(server.inspectionBudgetUsed).toBe(1);
    attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"));
    expect(new Set(attempts.map((request) => request.idempotencyKey)).size).toBe(1);
  });

  it("keeps legacy reports readable and binds current clearance/execution evidence to v6 approval authority", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const control = client(root, server);
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    const observed = await control.approvalSubject(run.id); await control.approve(run.id, observed.result.digest);
    const approved = server.runs.find((entry) => entry.id === run.id)!; const subject = server.approvalSubject(approved).subject;
    const executionBridgeIdentity = validateCanonicalIdentity(subject.executionBridgeIdentity, "fixture execution bridge");
    const writeSessionAuthorityIdentity = validateCanonicalIdentity(subject.writeSessionAuthorityIdentity, "fixture write authority");
    const semanticAuthorityIdentity = validateCanonicalIdentity(subject.freshNetClassSemanticAuthorityIdentity, "fixture netclass semantic authority");
    const freshClearanceEvidenceBinding = createFluxFreshClearanceEvidenceBinding({
      kicad: { kind: "kicad-cli", version: "10.0.3", commit: "abcdef0", sha256: "1".repeat(64), sizeBytes: 1024, capabilityHelpSha256: "2".repeat(64), confirmedCapabilities: ["pcb-drc", "sch-erc"] },
      materializationIdentity: canonicalIdentity({ fixture: "materialization" }, "evleda.fresh-netclass-materialization.v2"),
      receiptIdentity: canonicalIdentity({ fixture: "receipt" }, "evleda.fresh-clearance-evidence-receipt.v2"),
      semanticAuthorityIdentity,
    });
    const report = {
      reportId: "report_bound", title: "Bound candidate", digest: "d".repeat(64), mediaType: "application/json", createdAt: "2026-09-07T00:00:08.000Z",
      executionBridgeIdentity, writeSessionAuthorityIdentity,
      writeSessionReceiptIdentity: canonicalIdentity({ receipt: "write" }, "evleda.kicad-mcp-session-receipt.v1"),
      executionInspectionSessionReceiptIdentity: canonicalIdentity({ receipt: "inspection" }, "evleda.kicad-mcp-session-receipt.v1"),
      freshClearanceEvidenceBinding,
      freshAcceptance: { passed: true, requirements: [{ id: "schematic-render-clearance", status: "pass" as const, detail: "Host fixture ink clearance." }], missing: [], sourceHashes: { schematicSha256: "a".repeat(64), pcbSha256: "b".repeat(64) }, evidenceLimitations: [] },
    };
    server.replaceRun(run.id, { phase: "completed", approval: { ...approved.approval!, consumedAt: "2026-09-07T00:00:08.000Z" }, reports: [report], updatedAt: "2026-09-07T00:00:08.000Z" });
    await expect(control.reports(run.id)).resolves.toMatchObject({ result: { reports: [{ reportId: "report_bound", executionBridgeIdentity, writeSessionAuthorityIdentity, freshClearanceEvidenceBinding }] } });
    const { executionBridgeIdentity: _execution, writeSessionAuthorityIdentity: _authority, writeSessionReceiptIdentity: _writeReceipt, executionInspectionSessionReceiptIdentity: _inspectionReceipt, ...hybrid } = report;
    server.replaceRun(run.id, { reports: [hybrid] });
    await expect(control.status(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(control.reports(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    server.replaceRun(run.id, { reports: [report] });
    const driftedClearance = createFluxFreshClearanceEvidenceBinding({
      kicad: freshClearanceEvidenceBinding.kicad,
      materializationIdentity: freshClearanceEvidenceBinding.materializationIdentity,
      receiptIdentity: freshClearanceEvidenceBinding.receiptIdentity,
      semanticAuthorityIdentity: canonicalIdentity({ drift: true }, "evleda.fresh-netclass-semantic-authority.v2"),
    });
    server.replaceRun(run.id, { reports: [{ ...report, freshClearanceEvidenceBinding: driftedClearance }] });
    await expect(control.reports(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    server.replaceRun(run.id, { reports: [report] });
    for (const field of ["executionBridgeIdentity", "writeSessionAuthorityIdentity"] as const) {
      const schemaVersion = (report[field] as { schemaVersion: string }).schemaVersion;
      server.replaceRun(run.id, { reports: [{ ...report, [field]: canonicalIdentity({ field, drift: true }, schemaVersion) }] });
      await expect(control.reports(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    }
    const legacy = { reportId: "report_legacy", title: "Legacy candidate", digest: "e".repeat(64), mediaType: "application/json", createdAt: "2026-09-07T00:00:09.000Z" };
    server.replaceRun(run.id, { reports: [legacy] });
    await expect(control.status(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    const legacyBindingPayload = { schemaVersion: "evleda.flux-fresh-clearance-evidence-binding.v1" as const, kicad: freshClearanceEvidenceBinding.kicad,
      materializationIdentity: canonicalIdentity({ historical: "materialization" }, "evleda.fresh-netclass-materialization.v1"), receiptIdentity: canonicalIdentity({ historical: "receipt" }, "evleda.fresh-clearance-evidence-receipt.v1") };
    const legacyBinding = { ...legacyBindingPayload, identity: canonicalIdentity(legacyBindingPayload, legacyBindingPayload.schemaVersion) };
    const legacyBoundReport = { ...report, reportId: "report_legacy_bound", freshClearanceEvidenceBinding: legacyBinding };
    const cacheBasedV2Payload = { ...legacyBindingPayload, schemaVersion: "evleda.flux-fresh-clearance-evidence-binding.v2" as const,
      semanticAuthorityIdentity: canonicalIdentity({ historical: "semantic" }, "evleda.fresh-netclass-semantic-authority.v1") };
    const cacheBasedV2Binding = { ...cacheBasedV2Payload, identity: canonicalIdentity(cacheBasedV2Payload, cacheBasedV2Payload.schemaVersion) };
    const cacheBasedReport = { ...report, reportId: "report_cache_based", freshClearanceEvidenceBinding: cacheBasedV2Binding };
    server.replaceRun(run.id, { phase: "needs_review", reports: [legacy, legacyBoundReport, cacheBasedReport], updatedAt: "2026-09-07T00:00:09.000Z" });
    const requestsBeforeHistory = server.requests.length;
    await expect(control.reports(run.id)).resolves.toMatchObject({ result: { reports: [legacy, legacyBoundReport, cacheBasedReport] } });
    expect(server.requests.slice(requestsBeforeHistory).some((request) => request.pathname.endsWith("/approval"))).toBe(false);
    server.replaceRun(run.id, { phase: "completed", reports: [cacheBasedReport] });
    await expect(control.status(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it("rejects run, bridge, and budget drift before or during active inspection", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const storePath = path.join(root, "inspection.json");
    const control = new FluxControlClient({ baseUrl: "http://127.0.0.1:8765", fetch: server.fetch, intentStore: new FluxControlIntentStore(storePath, "http://127.0.0.1:8765") });
    const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    await control.interpret(run.id); await control.prepare(run.id); await control.open(run.id); await control.checkpoint(run.id);
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/inspection") ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), runId: "run_swapped" } } : envelope;
    await expect(control.inspectionStatus(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"))).toHaveLength(0);
    for (const [field, schemaVersion] of [["inspectionBridgeIdentity", "evleda.kicad-mcp-inspection-bridge.v2"], ["executionBridgeIdentity", "evleda.kicad-mcp-execution-bridge.v1"], ["ipcSocketIdentity", "evleda.kicad-api-socket-binding.v1"], ["writeSessionAuthorityIdentity", "evleda.kicad-mcp-session-authority.v1"]] as const) {
      server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/inspection") ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), [field]: canonicalIdentity({ field, drift: true }, schemaVersion) } } : envelope;
      await expect(control.inspectionStatus(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    }
    server.mutateResponse = (envelope, request) => request.method === "GET" && request.pathname.endsWith("/inspection") ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), connectionBudget: { used: 1, remaining: 8, limit: 8 } } } : envelope;
    await expect(control.inspectionStatus(run.id)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    server.mutateResponse = (envelope, request) => request.method === "POST" && request.pathname.endsWith("/inspection") ? { ...envelope, result: { ...(envelope.result as Record<string, unknown>), executionBridgeIdentity: canonicalIdentity({ drift: true }, "evleda.kicad-mcp-execution-bridge.v1") } } : envelope;
    await expect(control.inspect(run.id)).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(await readFile(storePath, "utf8")).toContain('"operation":"inspect_run"');
    expect(await readFile(storePath, "utf8")).toContain('"status":"pending"');
  });
});
