// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxApiError, FluxIntentStorageError } from "./api";
import { DesignInspector } from "./DesignInspector";
import FluxDesignerApp, { FLUX_POLL_DELAY_MS, mergeFluxEvents } from "./FluxDesignerApp";
import type { FluxApi, FluxContractStateDto, FluxDiagnosticCode, FluxDiagnosticDto, FluxInspectorSnapshot, FluxPollResult, FluxPreviewDto, FluxProviderId, FluxRunDto, FluxRuntimePolicyDto, FluxRuntimeReadinessDto, FluxSequencedEventDto } from "./model";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const canonical = (value: unknown): string => value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const canonicalIdentity = (payload: object, schemaVersion: string) => ({ algorithm: "sha256" as const, digest: createHash("sha256").update(canonical(payload)).digest("hex"), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const identity = (name: string) => ({ algorithm: "sha256" as const, digest: ([...name].reduce((sum, value) => sum + value.codePointAt(0)!, 0) % 16).toString(16).repeat(64), schemaVersion: name === "kicad-runtime" ? "evleda.kicad-mcp-runtime.v1" : name === "inspection-bridge" ? "evleda.kicad-mcp-inspection-bridge.v2" : name === "execution-bridge" ? "evleda.kicad-mcp-execution-bridge.v1" : `evleda.${name}.v1`, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const bindingIdentity = (digit: string, schemaVersion: string) => ({ algorithm: "sha256" as const, digest: digit.repeat(64), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const });
const diagnostic = (code: FluxDiagnosticCode, digit = "d"): FluxDiagnosticDto => ({ schemaVersion: "evleda.flux-diagnostic.v1", code, evidenceIdentity: { algorithm: "sha256", digest: digit.repeat(64), schemaVersion: "evleda.flux-diagnostic-evidence.v1", canonicalizationVersion: "evleda-c14n-json-v1" } });
const providerProfilePayload = { schemaVersion: "evleda.pcb-provider-profile-binding.v1", provider: "openai" as const, model: "gpt-test", tier: "priority" as const, adapterSchemaVersion: "evleda.openai.v1" };
const providerProfile = { ...providerProfilePayload, identity: canonicalIdentity(providerProfilePayload, providerProfilePayload.schemaVersion) };
const bundleRefPayload = { schemaVersion: "evleda.pcb-design-compilation-bundle-ref.v1", bundleIdentity: identity("bundle"), contentIdentity: { algorithm: "sha256" as const, digest: "c".repeat(64), size: 4096 } };
const bundleRef = { ...bundleRefPayload, identity: canonicalIdentity(bundleRefPayload, bundleRefPayload.schemaVersion) };
const deepRuleBindingIdentity = { ...identity("rules"), schemaVersion: "evleda.pcb-deep-rule-binding.v1" };
const deepRuleCatalogIdentity = { ...identity("rule-catalog"), schemaVersion: "evleda.deep-rule-catalog.v1" };
const readyContract = (): FluxContractStateDto => {
  const receiptPayload = { schemaVersion: "evleda.flux-interpreter-receipt.v2" as const, interpreterSchemaVersion: "evleda.interpreter.v2", provider: "openai" as const, providerProfile, providerProfileIdentity: providerProfile.identity, promptDigest: "a".repeat(64), clarificationDigest: "b".repeat(64), compilerProfileIdentity: identity("compiler"), practiceProfileBindingIdentity: identity("practice"), bundleIdentity: bundleRef.bundleIdentity, compiledAt: "2026-09-06T00:00:00.000Z" };
  const contractPayload = {
    schemaVersion: "evleda.pcb-design-contract.v1",
    kind: "pcb_design_contract",
    scope: { sheetCount: 1, componentUnitPolicy: "single_unit", board: { shape: "rectangle", widthMm: 40, heightMm: 30, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } },
    components: [{ reference: "R1", symbolLibId: "Device:R", value: "10k", footprintLibId: "Resistor_SMD:R_0603", unit: 1, pins: [{ pin: "1", assignment: { kind: "net", net: "VIN" } }, { pin: "2", assignment: { kind: "net", net: "VIN" } }] }],
    nets: [{ name: "VIN", role: "power_input", endpoints: [{ reference: "R1", pin: "1" }, { reference: "R1", pin: "2" }], electrical: { voltage: { minimumV: 4.5, nominalV: 5, maximumV: 5.5 }, current: { nominalA: 0.01, maximumContinuousA: 0.02, peakA: 0.02, peakDurationMs: 1 }, speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null } }, netClassId: "POWER" }],
    netClasses: [{ id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu", "B.Cu"] }],
    placementConstraints: [{ reference: "R1", side: "front", regionMm: { minXmm: 5, maxXmm: 35, minYmm: 5, maxYmm: 25 }, allowedRotationsDeg: [0, 90], minimumEdgeClearanceMm: 1, minimumCourtyardClearanceMm: 0.25, edgePreference: "none" }],
    routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.25, allowRightAngleCorners: false, allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false, viaPolicy: { mode: "bounded", maxTotal: 2, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 }, nets: [{ net: "VIN", topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 1, routeLength: { mode: "unbounded" } }] },
  };
  const contractIdentity = canonicalIdentity(contractPayload, contractPayload.schemaVersion);
  const summaryPayload = { schemaVersion: "evleda.flux-deep-rule-summary.v1" as const, deepRuleBindingIdentity, catalogIdentity: deepRuleCatalogIdentity, selectedCount: 3, selectedRuleIds: ["PCB01-R001", "PCB01-R002", "PCB01-R003"], coveredFeatures: ["dfm", "placement"] as const, uncoveredFeatures: [] as const };
  return { disposition: "ready", questions: [], issues: [], contract: { ...contractPayload, identity: contractIdentity }, contractIdentity, libraryBindingIdentity: identity("library"), deepRuleBindingIdentity, deepRuleSummary: { ...summaryPayload, identity: canonicalIdentity(summaryPayload, summaryPayload.schemaVersion) }, acceptancePlanIdentity: identity("plan"), interpreterReceipt: { ...receiptPayload, identity: canonicalIdentity(receiptPayload, receiptPayload.schemaVersion) } };
};
const questions = (): FluxContractStateDto => {
  const { deepRuleSummary: _summary, ...ready } = readyContract();
  return { ...ready, disposition: "needs_clarification", contract: null, contractIdentity: null, libraryBindingIdentity: null, deepRuleBindingIdentity: null, acceptancePlanIdentity: null, questions: [{ id: "/scope/name", path: "/scope/name", question: "What is the board name?" }], issues: [{ code: "UNRESOLVED_FIELD", severity: "error", path: "/scope/name", message: "A board name is required.", clarificationId: "/scope/name" }], interpreterReceipt: { ...ready.interpreterReceipt, bundleIdentity: null, compilerProfileIdentity: null, practiceProfileBindingIdentity: null } as FluxContractStateDto["interpreterReceipt"] };
};
const modelFor = (provider: FluxProviderId): string => provider === "openai" ? "gpt-test" : `${provider}-model`;
const policyFor = (provider: FluxProviderId = "openai"): FluxRuntimePolicyDto => ({ providerModel: { provider, model: modelFor(provider), tier: provider === "openai" ? "priority" : "provider-default" }, iterationCap: { minimum: 1, maximum: 12, recommended: 12 }, harnessRuleIdentity: "server-rule", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$", checkpointOpenRequiredForFresh: true, freshAcceptanceProfileIdentity: "acceptance", freshPersistenceProfileIdentity: "persistence" });
const toolchain = { identity: bindingIdentity("7", "evleda.flux-kicad-toolchain-binding.v1"), kicadCli: { identity: bindingIdentity("8", "evleda.flux-kicad-cli-binding.v1"), operationalVersion: "10.0.3", operationalCommit: "1".repeat(40), peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" }, pcbnew: { identity: bindingIdentity("9", "evleda.flux-pcbnew-binding.v1"), peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" } };
const readinessFor = (provider: FluxProviderId = "openai"): FluxRuntimeReadinessDto => ({ schemaVersion: "evleda.flux-readiness.v1", configured: true, status: "ready", reasonCodes: [], provider: { provider, model: modelFor(provider), requestedTier: provider === "openai" ? "fast" : "provider-default", canonicalTier: provider === "openai" ? "priority" : "provider-default", adapterSchemaVersion: `evleda.${provider}.v1`, providerProfileIdentity: provider === "openai" ? providerProfile.identity : identity(provider), localReadCapability: provider === "codex" ? "read_only_host_files" : "none", configurationPreflight: provider === "codex" ? { status: "passed", evidenceIdentity: identity("codex-preflight"), capabilityProfileIdentity: identity("codex-capability"), imageInspectionPolicy: "disabled_by_pinned_feature" } : null }, compiler: { profileIdentity: identity("compiler"), catalogIdentity: identity("catalog"), exactSymbolCount: 1773, exactFootprintCount: 832, symbolNicknameCount: 39, footprintNicknameCount: 55 }, toolchain, kicadMcpRuntime: { identity: identity("kicad-runtime"), inspectionBridgeIdentity: identity("inspection-bridge"), executionBridgeIdentity: identity("execution-bridge"), connectionPolicy: { maxConnections: 8, concurrency: 1, reuse: "same-live-run-bounded" as const, restart: "fail-closed-reallocate-reapprove" as const, cleanup: "after-confirmed-session-and-editor-stop" as const, unconfirmed: "retain-poison-no-retry" as const } }, diagnostic: null });
const run = (phase: FluxRunDto["phase"] = "contract_ready", contractState: FluxContractStateDto | undefined = readyContract()): FluxRunDto => ({ id: "run_1", projectId: "project_1", threadId: "thread_1", phase, prompt: "Create a controller candidate", providerModel: { provider: "openai", model: "gpt-test", tier: "priority" }, iterationCap: 1, workflowKind: "generic", harnessRuleIdentity: "bundle-rules", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "bundle-acceptance", freshPersistenceProfileIdentity: "persistence", ...(contractState === undefined ? {} : { contractState }), ...(contractState?.disposition === "ready" ? { compilationBundleRef: bundleRef } : {}), reports: [], createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
const contractWithBoard = (widthMm: number, heightMm: number): FluxContractStateDto => {
  const base = readyContract(); if (base.contract === null) throw new Error("fixture contract is required");
  const { identity: _identity, ...payload } = base.contract; const scope = payload.scope as Record<string, unknown>; const board = scope.board as Record<string, unknown>;
  const changed = { ...payload, scope: { ...scope, board: { ...board, widthMm, heightMm } } };
  const contractIdentity = canonicalIdentity(changed, "evleda.pcb-design-contract.v1");
  return { ...base, contract: { ...changed, identity: contractIdentity }, contractIdentity };
};
const event = (eventSeq: number, kind: FluxSequencedEventDto["kind"]): FluxSequencedEventDto => ({ id: `event_${eventSeq}`, eventSeq, runId: "run_1", kind, at: "2026-09-06T00:00:00.000Z", detail: "Safe event detail" });
const preview: FluxPreviewDto = { refreshedAt: "2026-09-06T00:00:00.000Z", artifacts: [{ kind: "schematic", mediaType: "image/svg+xml", sizeBytes: 1, sha256: "a".repeat(64) }] };
const idle: FluxInspectorSnapshot = { state: "idle", busy: false, completedTools: 0, totalTools: 6 };

const fake = (initial: FluxRunDto | null = run(), options: { readonly readiness?: FluxRuntimeReadinessDto; readonly policy?: FluxRuntimePolicyDto } = {}): FluxApi => {
  let current = initial ?? undefined;
  const readiness = options.readiness ?? readinessFor();
  const policy = options.policy ?? policyFor();
  return {
    resetBrowserIntents() {},
    async readiness() { return readiness; }, async policy() { return policy; },
    async sources() { return [{ key: "source_1", label: "Fresh candidate", fingerprint: "a".repeat(64) }]; }, async projects() { return []; }, async runs() { return current ? [current] : []; }, async getRun() { if (!current) throw new Error("missing"); return current; },
    async createRun() { current = run("draft", undefined); return current; },
    async interpret() { current = run("awaiting_clarification", questions()); return current; },
    async clarifications() { current = run("contract_ready", readyContract()); return current; },
    async contract() { if (!current?.contractState) throw new Error("missing contract"); return current.contractState; },
    async prepare() { current = { ...run("awaiting_open"), preview: { title: "Candidate", summary: "Prepared", artifactCount: 1, digest: "a".repeat(64) }, updatedAt: "2026-09-06T00:00:01.000Z" }; return current; },
    async poll(_runId, after): Promise<FluxPollResult> { if (!current) throw new Error("missing"); return { run: current, queue: { queuedRunIds: [] }, events: after === 0 ? [event(1, "contract_compiled")] : [], nextEventSeq: 1 }; },
    async approvalSubject() { return { digest: "d".repeat(64), subject: { runId: "run_1", workflowKind: "generic", sourceKey: "source_1", sourceFingerprint: "a".repeat(64), isolatedFingerprint: "b".repeat(64), promptIdentity: { algorithm: "sha256", digest: "c".repeat(64), size: 29 }, providerModel: { provider: "openai", model: "gpt-test", tier: "priority" }, iterationCap: 1, harnessRuleIdentity: "bundle-rules", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "bundle-acceptance", freshPersistenceProfileIdentity: "persistence", contractIdentity: identity("contract"), libraryBindingIdentity: identity("library"), deepRuleBindingIdentity, acceptancePlanIdentity: identity("plan"), compilationBundleRef: bundleRef, providerProfile, bundleIdentity: bundleRef.bundleIdentity, compilerProfileIdentity: identity("compiler"), practiceProfileBindingIdentity: identity("practice"), executionPromptIdentity: identity("execution"), executionPromptContentIdentity: { algorithm: "sha256", digest: "e".repeat(64), size: 2048 } } }; },
    async approve() { current = { ...run("approved"), updatedAt: "2026-09-06T00:00:04.000Z" }; return current; },
    async resume() { current = { ...run("completed"), updatedAt: "2026-09-06T00:00:05.000Z" }; return current; },
    async open() { current = { ...run("awaiting_checkpoint"), updatedAt: "2026-09-06T00:00:02.000Z" }; return { opened: true, label: "Opened isolated candidate", checkpointRequired: true }; },
    async checkpointOpen() { current = { ...run("awaiting_approval"), updatedAt: "2026-09-06T00:00:03.000Z" }; return current; },
    async preview() { return preview; }, async refreshPreview() { return preview; }, async inspector() { return idle; }, async inspect() { return idle; }, previewUrl(runId, kind) { return `/api/v1/flux/runs/${runId}/preview/${kind}`; },
  };
};

describe("Flux generic lifecycle UI", () => {
  it("fails closed on unconfigured provider setup without requesting lifecycle policy", async () => {
    const client = fake(null, { readiness: { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: ["PROVIDER_NOT_CONFIGURED"], provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic: null } });
    const policy = vi.spyOn(client, "policy"); render(<FluxDesignerApp client={client} />);
    expect(await screen.findByRole("heading", { name: "Setup required" })).toBeInTheDocument();
    expect(screen.getByText("Select one supported interpretation provider.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled();
    expect(policy).not.toHaveBeenCalled(); expect(document.body.textContent).not.toMatch(/C:\\|api[_ -]?key/iu);
  });

  it("shows the safe Codex local-read acknowledgement blocker", async () => {
    const client = fake(null, { readiness: { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: ["CODEX_LOCAL_READ_ACK_REQUIRED"], provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic: null } });
    render(<FluxDesignerApp client={client} />);
    expect(await screen.findByText("Codex CLI requires an explicit profile-bound acknowledgement of its local read capability.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled();
  });

  it("shows the closed KiCad toolchain setup blocker without paths", async () => {
    const client = fake(null, { readiness: { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: ["KICAD_TOOLCHAIN_UNAVAILABLE"], provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic: null } });
    render(<FluxDesignerApp client={client} />);
    expect(await screen.findByText("The pinned KiCad CLI and PCB editor toolchain is unavailable or incompatible.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\.exe|Program Files|bin\\|C:\\/iu);
  });

  it.each(["missing", "top-level extra", "child extra", "identity schema", "version", "commit", "setup leakage"] as const)("rejects a %s toolchain readiness projection before policy fetch", async (kind) => {
    const base = readinessFor();
    const malformed = kind === "missing" ? { ...base, toolchain: null }
      : kind === "top-level extra" ? { ...base, toolchain: { ...toolchain, executablePath: "C:\\private\\kicad-cli.exe" } }
        : kind === "child extra" ? { ...base, toolchain: { ...toolchain, kicadCli: { ...toolchain.kicadCli, contentIdentity: { algorithm: "sha256", digest: "a".repeat(64), size: 1 } } } }
          : kind === "identity schema" ? { ...base, toolchain: { ...toolchain, identity: { ...toolchain.identity, schemaVersion: "evleda.wrong.v1" } } }
            : kind === "version" ? { ...base, toolchain: { ...toolchain, kicadCli: { ...toolchain.kicadCli, operationalVersion: "10.0.3 at C:\\private\\kicad-cli.exe" } } }
              : kind === "commit" ? { ...base, toolchain: { ...toolchain, kicadCli: { ...toolchain.kicadCli, operationalCommit: "not-a-commit token=secret" } } }
                : { ...base, configured: false, status: "setup_required" as const, provider: null, compiler: null, reasonCodes: ["KICAD_TOOLCHAIN_UNAVAILABLE" as const] };
    const client = fake(null, { readiness: malformed as FluxRuntimeReadinessDto }); const policyCall = vi.spyOn(client, "policy");
    render(<FluxDesignerApp client={client} />);
    expect(await screen.findByRole("heading", { name: "Runtime authority malformed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled();
    expect(policyCall).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/C:\\private|token=secret|not-a-commit|executablePath|contentIdentity/iu);
  });

  it("retries a failed readiness bootstrap without reloading the page", async () => {
    const user = userEvent.setup(); const client = fake(null); let attempts = 0;
    client.readiness = async () => { attempts += 1; if (attempts === 1) throw new TypeError("daemon unavailable"); return readinessFor(); };
    render(<FluxDesignerApp client={client} />);
    expect(await screen.findByRole("heading", { name: "Runtime status unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry setup check" }));
    expect(await screen.findByText("OpenAI")).toBeInTheDocument(); expect(attempts).toBe(2);
  });

  it("requires an explicit visible reset after corrupt durable browser intent state", async () => {
    const user = userEvent.setup(); const client = fake(null); const reset = vi.spyOn(client, "resetBrowserIntents");
    client.createRun = async () => { throw new FluxIntentStorageError("Corrupt browser transaction; explicit reset required."); };
    render(<FluxDesignerApp client={client} />); const create = await screen.findByRole("button", { name: "Create generic run" }); await user.click(create);
    expect(await screen.findByRole("alert", { name: "Browser intent reset required" })).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reset local operation intents" }));
    expect(reset).toHaveBeenCalledTimes(1); await waitFor(() => expect(create).toBeEnabled());
  });

  it("redacts private setup locations from an unexpected bootstrap failure", async () => {
    const client = fake(null); client.readiness = async () => { throw new Error("Provider failed at C:\\private\\api-key.txt"); };
    render(<FluxDesignerApp client={client} />);
    expect(await screen.findByText("The safe Flux readiness snapshot could not be loaded.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("C:\\private");
  });

  it.each([["openai", "OpenAI"], ["anthropic", "Anthropic"], ["codex", "Codex CLI"], ["claude-cli", "Claude CLI"]] as const)("renders the safe %s provider label", async (provider, label) => {
    render(<FluxDesignerApp client={fake(null, { readiness: readinessFor(provider), policy: policyFor(provider) })} />);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("persistently discloses Codex CLI local read capability without claiming a tool-free boundary", async () => {
    render(<FluxDesignerApp client={fake(null, { readiness: readinessFor("codex"), policy: policyFor("codex") })} />);
    const warning = await screen.findByRole("note", { name: "Codex local read capability" });
    expect(warning).toHaveTextContent("may inspect host files");
    expect(warning).toHaveTextContent("does not create a tool-free or no-read boundary");
  });

  it("defaults the visible cap control and real create input to the server recommendation of 12", async () => {
    const user = userEvent.setup(); const client = fake(null); const create = vi.spyOn(client, "createRun"); render(<FluxDesignerApp client={client} />);
    const cap = await screen.findByRole("spinbutton", { name: "Agent iteration cap" });
    await waitFor(() => expect(cap).toHaveValue(12)); expect(cap).toHaveAttribute("min", "1"); expect(cap).toHaveAttribute("max", "12");
    await user.click(screen.getByRole("button", { name: "Create generic run" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ iterationCap: 12 }), expect.objectContaining({ iterationCap: { minimum: 1, maximum: 12, recommended: 12 } }), expect.any(AbortSignal));
  });

  it("allows the server-authorized cap of 1 and sends it exactly", async () => {
    const user = userEvent.setup(); const client = fake(null); const create = vi.spyOn(client, "createRun"); render(<FluxDesignerApp client={client} />);
    const cap = await screen.findByRole("spinbutton", { name: "Agent iteration cap" }); await waitFor(() => expect(cap).toHaveValue(12));
    await user.clear(cap); await user.type(cap, "1"); await user.click(screen.getByRole("button", { name: "Create generic run" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ iterationCap: 1 }), expect.anything(), expect.any(AbortSignal));
    expect(cap).toHaveValue(1);
  });

  it("keeps Create disabled for an empty, fractional, or out-of-range cap", async () => {
    const user = userEvent.setup(); render(<FluxDesignerApp client={fake(null)} />); const cap = await screen.findByRole("spinbutton", { name: "Agent iteration cap" }); const create = screen.getByRole("button", { name: "Create generic run" }); await waitFor(() => expect(create).toBeEnabled());
    await user.clear(cap); expect(create).toBeDisabled();
    await user.type(cap, "13"); expect(create).toBeDisabled();
    await user.clear(cap); await user.type(cap, "1.5"); expect(create).toBeDisabled();
    await user.clear(cap); await user.type(cap, "1"); expect(create).toBeEnabled();
  });

  it("renders a single server-authorized cap read-only", async () => {
    const fixed = { ...policyFor(), iterationCap: { minimum: 1, maximum: 1, recommended: 1 } };
    render(<FluxDesignerApp client={fake(null, { policy: fixed })} />); const cap = await screen.findByRole("spinbutton", { name: "Agent iteration cap" });
    await waitFor(() => expect(cap).toHaveValue(1)); expect(cap).toHaveAttribute("readonly"); expect(screen.getByText("Server policy fixes this run to exactly 1 iteration.")).toBeInTheDocument();
  });

  it("resets the selected cap to a changed server recommendation", async () => {
    const user = userEvent.setup(); const first = fake(null); const view = render(<FluxDesignerApp client={first} />); const cap = await screen.findByRole("spinbutton", { name: "Agent iteration cap" }); await waitFor(() => expect(cap).toHaveValue(12));
    await user.clear(cap); await user.type(cap, "1"); expect(cap).toHaveValue(1);
    const changed = { ...policyFor(), iterationCap: { minimum: 1, maximum: 6, recommended: 6 } };
    view.rerender(<FluxDesignerApp client={fake(null, { policy: changed })} />);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Agent iteration cap" })).toHaveValue(6));
  });

  it("fails closed when the server cap policy is missing or malformed", async () => {
    const malformed = { ...policyFor(), iterationCap: { minimum: 1, maximum: 12, recommended: 13 } } as FluxRuntimePolicyDto;
    const client = fake(null, { policy: malformed }); const create = vi.spyOn(client, "createRun"); render(<FluxDesignerApp client={client} />);
    expect(await screen.findByRole("heading", { name: "Iteration policy unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled(); expect(create).not.toHaveBeenCalled();
  });

  it("locks mutation when readiness and lifecycle policy disagree", async () => {
    render(<FluxDesignerApp client={fake(null, { readiness: readinessFor("openai"), policy: policyFor("anthropic") })} />);
    expect(await screen.findByRole("heading", { name: "Provider policy changed during bootstrap" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled();
  });

  it("renders a real v2 ready lifecycle projection without private bundle or path leakage", async () => {
    render(<FluxDesignerApp client={fake()} />);
    expect(await screen.findByText("Design Contract")).toBeInTheDocument();
    expect(screen.getByText("Fast (canonical priority)")).toBeInTheDocument();
    expect(screen.getByText("Bound candidate authority")).toBeInTheDocument();
    expect(screen.getByText("Bundle content")).toBeInTheDocument();
    expect(screen.getByText("4,096 bytes")).toBeInTheDocument();
    expect(screen.getByText("10.0.3 · PE file 10.0.3.49839 · product 10.0.3")).toBeInTheDocument();
    expect(screen.getByText("PE file 10.0.3.49839 · product 10.0.3")).toBeInTheDocument();
    expect(screen.getByText("1".repeat(40))).toBeInTheDocument();
    expect(await screen.findByLabelText("Selected deep-rule IDs")).toHaveTextContent("PCB01-R001");
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeEnabled());
    expect(document.body.textContent).not.toContain("C:\\private");
    expect(document.body.textContent).not.toContain("originalPrompt");
    expect(screen.queryByRole("button", { name: /manufactur|release|bundle/i })).not.toBeInTheDocument();
  });

  it("renders the same contract projection from direct GET, same-timestamp poll repair, and reload", async () => {
    const stale = run("contract_ready", contractWithBoard(40, 30));
    const corrected = run("contract_ready", contractWithBoard(30, 20));
    const client = fake(stale);
    client.runs = async () => [stale];
    client.poll = async (_runId, after) => ({ run: corrected, queue: { queuedRunIds: [] }, events: after === 0 ? [event(1, "contract_compiled")] : [], nextEventSeq: 1 });
    client.contract = async () => corrected.contractState!;

    const direct = render(<DesignInspector snapshot={undefined} contract={await client.contract("run_1")} authorityIntegrity="valid" busy={false} onInspect={() => undefined} />);
    const expected = direct.container.querySelector(".flux-contract-grid")!.textContent;
    expect(expected).toContain("Rectangle, 30 mm × 20 mm");
    direct.unmount();

    const first = render(<FluxDesignerApp client={client} />);
    await waitFor(() => expect(screen.getByLabelText("Board dimensions and layers")).toHaveTextContent("Rectangle, 30 mm × 20 mm"));
    await screen.findByLabelText("Selected deep-rule IDs");
    expect(first.container.querySelector(".flux-contract-grid")!.textContent).toBe(expected);
    first.unmount();

    const reloaded = render(<FluxDesignerApp client={client} />);
    await waitFor(() => expect(screen.getByLabelText("Board dimensions and layers")).toHaveTextContent("Rectangle, 30 mm × 20 mm"));
    await screen.findByLabelText("Selected deep-rule IDs");
    expect(reloaded.container.querySelector(".flux-contract-grid")!.textContent).toBe(expected);
  });

  it("collects one clarification batch and only then enables Prepare", async () => {
    const user = userEvent.setup(); render(<FluxDesignerApp client={fake(run("awaiting_clarification", questions()))} />);
    expect(await screen.findByText("Clarifications required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
    await user.type(screen.getByLabelText("What is the board name?"), "Controller"); await user.click(screen.getByRole("button", { name: "Submit clarification batch" }));
    expect((await screen.findAllByText("ready")).length).toBeGreaterThan(0); await waitFor(() => expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeEnabled());
  });

  it("keeps unsupported contracts fail-closed", async () => {
    const unsupported = { ...questions(), disposition: "unsupported" as const, questions: [], issues: [{ code: "UNSUPPORTED", severity: "error" as const, path: "/scope", message: "Unsupported scope", clarificationId: null }] };
    render(<FluxDesignerApp client={fake(run("awaiting_clarification", unsupported))} />);
    expect(await screen.findByText("unsupported")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it.each(["interpreting", "preparing", "opening", "checkpointing", "queued", "running"] as const)("disables Create while the selected run is %s", async (phase) => {
    render(<FluxDesignerApp client={fake(run(phase))} />);
    expect(await screen.findByRole("button", { name: "Create generic run" })).toBeDisabled();
  });

  it("never offers clarification submission outside the matching clarification phase", async () => {
    render(<FluxDesignerApp client={fake(run("blocked", questions()))} />);
    await screen.findByText("needs clarification");
    expect(screen.queryByText("Clarifications required")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit clarification batch" })).not.toBeInTheDocument();
  });

  it.each([
    ["missing compiler identity", { compilerProfileIdentity: null }, undefined, "Compilation authority incomplete"],
    ["missing practice identity", { practiceProfileBindingIdentity: null }, undefined, "Compilation authority incomplete"],
    ["missing receipt identity", { identity: null }, undefined, "Interpreter-receipt drift"],
    ["missing bundle identity", { bundleIdentity: null }, undefined, "Compilation-bundle drift"],
    ["bundle identity mismatch", { bundleIdentity: identity("different-bundle") }, undefined, "Compilation-bundle drift"],
    ["provider identity mismatch", { providerProfileIdentity: identity("different-provider") }, undefined, "Provider-profile drift"],
    ["missing embedded provider identity", { providerProfile: { ...providerProfile, identity: null } }, undefined, "Provider-profile drift"],
    ["missing reference identity", {}, { identity: null }, "Compilation-bundle drift"],
    ["invalid bundle content identity", {}, { contentIdentity: { algorithm: "sha256", digest: "invalid", size: 4096 } }, "Compilation-bundle drift"],
    ["compiler profile mismatch", { compilerProfileIdentity: { ...identity("compiler"), digest: "f".repeat(64) } }, undefined, "Compiler-profile drift"],
  ] as const)("locks Prepare for %s", async (_label, receiptPatch, referencePatch, expected) => {
    const base = readyContract(); const receipt = base.interpreterReceipt;
    if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("fixture must be v2");
    const drifted = { ...base, interpreterReceipt: { ...receipt, ...receiptPatch } } as FluxContractStateDto;
    const current = { ...run("contract_ready", drifted), ...(referencePatch === undefined ? {} : { compilationBundleRef: { ...bundleRef, ...referencePatch } }) } as FluxRunDto;
    render(<FluxDesignerApp client={fake(current)} />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it("locks Prepare when the ready contract identity closure is incomplete", async () => {
    const incomplete = { ...readyContract(), acceptancePlanIdentity: null };
    render(<FluxDesignerApp client={fake(run("contract_ready", incomplete))} />);
    expect(await screen.findByText("Compilation authority incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it.each(["missing", "extra", "count", "binding", "overlap"] as const)("locks Prepare for a %s deep-rule summary", async (kind) => {
    const base = readyContract(); const summary = base.deepRuleSummary!;
    const contractState: FluxContractStateDto = kind === "missing"
      ? (({ deepRuleSummary: _summary, ...rest }) => rest)(base)
      : { ...base, deepRuleSummary: (kind === "extra" ? { ...summary, privatePrompt: "C:\\private\\prompt" }
        : kind === "count" ? { ...summary, selectedCount: summary.selectedCount + 1 }
          : kind === "binding" ? { ...summary, deepRuleBindingIdentity: { ...summary.deepRuleBindingIdentity, digest: "f".repeat(64) } }
            : { ...summary, uncoveredFeatures: [summary.coveredFeatures[0]!] }) as typeof summary };
    render(<FluxDesignerApp client={fake(run("contract_ready", contractState))} />);
    expect(await screen.findByText("Deep-rule summary drift")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
    expect(screen.queryByLabelText("Selected deep-rule IDs")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("C:\\private\\prompt");
  });

  it("cryptographically rejects deep-rule summary identity drift", async () => {
    const base = readyContract(); const summary = base.deepRuleSummary!;
    render(<FluxDesignerApp client={fake(run("contract_ready", { ...base, deepRuleSummary: { ...summary, identity: { ...summary.identity, digest: "f".repeat(64) } } }))} />);
    expect(await screen.findByText("Canonical identity drift")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
    expect(screen.queryByLabelText("Selected deep-rule IDs")).not.toBeInTheDocument();
  });

  it.each(["null contract", "questions", "issues"] as const)("rejects a ready disposition with %s", async (kind) => {
    const base = readyContract();
    const invalid = kind === "null contract" ? { ...base, contract: null } : kind === "questions" ? { ...base, questions: [{ id: "/scope", path: "/scope", question: "Still unresolved?" }] } : { ...base, issues: [{ code: "UNRESOLVED", severity: "error" as const, path: "/scope", message: "Still unresolved", clarificationId: null }] };
    render(<FluxDesignerApp client={fake(run("contract_ready", invalid))} />);
    expect(await screen.findByText("Compilation authority incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it.each(["contract", "receipt", "provider", "reference", "identity"] as const)("rejects extra keys in the closed %s canonical record", async (kind) => {
    const base = readyContract(); const receipt = base.interpreterReceipt;
    if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || base.contract === null) throw new Error("fixture must be ready v2");
    const contractState = kind === "contract" ? { ...base, contract: { ...base.contract, unexpected: true } }
      : kind === "receipt" ? { ...base, interpreterReceipt: { ...receipt, unexpected: true } }
        : kind === "provider" ? { ...base, interpreterReceipt: { ...receipt, providerProfile: { ...receipt.providerProfile, unexpected: true } } }
          : kind === "identity" ? { ...base, interpreterReceipt: { ...receipt, compilerProfileIdentity: { ...receipt.compilerProfileIdentity!, unexpected: true } } }
            : base;
    const current = { ...run("contract_ready", contractState), ...(kind === "reference" ? { compilationBundleRef: { ...bundleRef, unexpected: true } } : {}) } as FluxRunDto;
    render(<FluxDesignerApp client={fake(current)} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it("recomputes the exact displayed contract identity and rejects nested drift", async () => {
    const base = readyContract(); if (base.contract === null) throw new Error("fixture must contain a contract");
    const changed = { ...base.contract, components: [{ ...(base.contract.components as readonly Record<string, unknown>[])[0]!, value: "changed-after-signing" }] };
    render(<FluxDesignerApp client={fake(run("contract_ready", { ...base, contract: changed }))} />);
    expect(await screen.findByText("Canonical identity drift")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it("rejects coherently reidentified private fields in the displayed contract", async () => {
    const base = readyContract(); if (base.contract === null) throw new Error("fixture must contain a contract");
    const { identity: _identity, ...payload } = base.contract;
    const privatePayload = { ...payload, scope: { ...(payload.scope as object), sourceRoot: "private-relative/source" } };
    const contractIdentity = canonicalIdentity(privatePayload, "evleda.pcb-design-contract.v1");
    const privateContract = { ...privatePayload, identity: contractIdentity };
    render(<FluxDesignerApp client={fake(run("contract_ready", { ...base, contract: privateContract, contractIdentity }))} />);
    expect(await screen.findByText("Compilation authority incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("private-relative/source");
  });

  it("rejects coherently reidentified extra keys in nested contract records", async () => {
    const base = readyContract(); if (base.contract === null) throw new Error("fixture must contain a contract");
    const { identity: _identity, ...payload } = base.contract; const components = payload.components as readonly Record<string, unknown>[];
    const changedPayload = { ...payload, components: [{ ...components[0]!, diagnosticNote: "extra but non-private" }] };
    const contractIdentity = canonicalIdentity(changedPayload, "evleda.pcb-design-contract.v1");
    render(<FluxDesignerApp client={fake(run("contract_ready", { ...base, contract: { ...changedPayload, identity: contractIdentity }, contractIdentity }))} />);
    expect(await screen.findByText("Compilation authority incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it.each(["unknown rotation", "out-of-range via maximum", "oversized components"] as const)("rejects a coherently reidentified contract with %s", async (kind) => {
    const base = readyContract(); if (base.contract === null) throw new Error("fixture must contain a contract");
    const { identity: _identity, ...payload } = base.contract;
    const changedPayload = kind === "unknown rotation"
      ? { ...payload, placementConstraints: [{ ...(payload.placementConstraints as readonly Record<string, unknown>[])[0]!, allowedRotationsDeg: [45] }] }
      : kind === "out-of-range via maximum"
        ? { ...payload, routingConstraints: { ...(payload.routingConstraints as Record<string, unknown>), viaPolicy: { mode: "bounded", maxTotal: 257, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 } } }
        : { ...payload, components: Array.from({ length: 65 }, (_, index) => ({ ...(payload.components as readonly Record<string, unknown>[])[0]!, reference: `R${index + 1}` })) };
    const contractIdentity = canonicalIdentity(changedPayload, "evleda.pcb-design-contract.v1");
    render(<FluxDesignerApp client={fake(run("contract_ready", { ...base, contract: { ...changedPayload, identity: contractIdentity }, contractIdentity }))} />);
    expect(await screen.findByText("Compilation authority incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
    expect(screen.queryByLabelText("Contract placement constraints")).not.toBeInTheDocument();
  });

  it.each(["receipt", "practice", "reference"] as const)("cryptographically detects coherent-looking %s drift", async (kind) => {
    const base = readyContract(); const receipt = base.interpreterReceipt;
    if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("fixture must be v2");
    const contractState = kind === "receipt"
      ? { ...base, interpreterReceipt: { ...receipt, identity: { ...receipt.identity, digest: "e".repeat(64) } } }
      : kind === "practice"
        ? { ...base, interpreterReceipt: { ...receipt, practiceProfileBindingIdentity: { ...receipt.practiceProfileBindingIdentity!, digest: "e".repeat(64) } } }
        : base;
    const reference = kind === "reference" ? { ...bundleRef, contentIdentity: { ...bundleRef.contentIdentity, digest: "d".repeat(64) } } : bundleRef;
    render(<FluxDesignerApp client={fake({ ...run("contract_ready", contractState), compilationBundleRef: reference })} />);
    expect(await screen.findByText("Canonical identity drift")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeDisabled();
  });

  it.each(["Source project changed after the run was created", "Compilation bundle failed durable verification", "Provider profile changed after compilation"] as const)("never infers a terminal category from prose: %s", async (reason) => {
    render(<FluxDesignerApp client={fake({ ...run("blocked"), blockedReason: reason })} />);
    expect(await screen.findByText("Run blocked")).toBeInTheDocument(); expect(screen.getByText("Legacy diagnostic unavailable")).toBeInTheDocument(); expect(document.body.textContent).not.toContain(reason); cleanup();
  });

  it("renders CODEX_CONFIG_INCOMPATIBLE from the closed readiness diagnostic", async () => {
    const readiness: FluxRuntimeReadinessDto = { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: ["CODEX_CONFIG_INCOMPATIBLE"], provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic: diagnostic("CODEX_CONFIG_INCOMPATIBLE", "a") };
    render(<FluxDesignerApp client={fake(null, { readiness })} />);
    expect(await screen.findByText("Codex configuration incompatible")).toBeInTheDocument();
    expect(screen.getByText("CODEX_CONFIG_INCOMPATIBLE")).toBeInTheDocument();
    expect(screen.getByText(/Update the pinned Codex isolation profile/iu)).toBeInTheDocument();
    expect(screen.getByText(/aaaaaaaa…aaaaaa/iu)).toBeInTheDocument();
  });

  it("renders a generic CLI nonzero exit only from PROVIDER_PROCESS_EXIT", async () => {
    render(<FluxDesignerApp client={fake({ ...run("failed"), blockedReason: "Flux capability is unavailable", diagnostic: diagnostic("PROVIDER_PROCESS_EXIT", "b") })} />);
    expect(await screen.findByText("Provider process exited unsuccessfully")).toBeInTheDocument();
    expect(screen.getByText("PROVIDER_PROCESS_EXIT")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Flux capability is unavailable");
  });

  it("keeps the same closed diagnostic from immediate failed POST through reread and reload", async () => {
    const user = userEvent.setup(); const exact = diagnostic("PROVIDER_PROCESS_EXIT", "f"); const initial = run("draft", undefined); const failed = { ...run("failed"), blockedReason: "Flux capability is unavailable", diagnostic: exact, updatedAt: "2026-09-07T01:00:00.000Z" };
    const client = fake(initial); let resolveStatus!: (value: FluxRunDto) => void; const status = new Promise<FluxRunDto>((resolve) => { resolveStatus = resolve; });
    client.interpret = async () => { throw new FluxApiError("STAGE_BLOCKED", "Flux capability is unavailable", false, exact, undefined, "req-immediate"); }; client.getRun = async () => status;
    const view = render(<FluxDesignerApp client={client} />); const interpret = await screen.findByRole("button", { name: "Interpret" }); await waitFor(() => expect(interpret).toBeEnabled()); await user.click(interpret);
    expect(await screen.findByText("Provider process exited unsuccessfully")).toBeInTheDocument(); expect(screen.getByText("ffffffff…ffffff")).toBeInTheDocument(); expect(screen.getByText(/Request correlation/iu)).toHaveTextContent("req-immediate"); expect(screen.getByText(/Request correlation/iu)).toHaveTextContent("does not authorize replay"); expect(document.body.textContent).not.toContain("Flux capability is unavailable");
    await act(async () => { resolveStatus(failed); await status; });
    await waitFor(() => expect(screen.getAllByText("Provider process exited unsuccessfully")).toHaveLength(1)); expect(screen.getByText("ffffffff…ffffff")).toBeInTheDocument();
    view.unmount(); render(<FluxDesignerApp client={fake(failed)} />);
    expect(await screen.findByText("Provider process exited unsuccessfully")).toBeInTheDocument(); expect(screen.getByText("ffffffff…ffffff")).toBeInTheDocument();
  });

  it("renders source drift only from SOURCE_DRIFT", async () => {
    render(<FluxDesignerApp client={fake({ ...run("failed"), blockedReason: "Unclassified failure", diagnostic: diagnostic("SOURCE_DRIFT", "c") })} />);
    expect(await screen.findByText("Source project changed")).toBeInTheDocument();
    expect(screen.getByText("SOURCE_DRIFT")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Unclassified failure");
  });

  it.each(["unknown", "extra"] as const)("fails closed for a %s diagnostic without rendering its strings", async (kind) => {
    const malicious = kind === "unknown"
      ? { ...diagnostic("TOOLCHAIN_FAILURE"), code: "UNKNOWN_C:\\private\\token=secret" }
      : { ...diagnostic("SOURCE_DRIFT"), stderr: "Bearer super-secret-token", remediation: "/private/remediation" };
    render(<FluxDesignerApp client={fake({ ...run("failed"), blockedReason: "opaque", diagnostic: malicious as unknown as FluxDiagnosticDto })} />);
    expect(await screen.findByText("Diagnostic unavailable")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/UNKNOWN_|C:\\private|super-secret|\/private\/remediation|SOURCE_DRIFT/iu);
  });

  it("restores the exact structured terminal diagnostic after a UI reload", async () => {
    const persisted = { ...run("failed"), diagnostic: diagnostic("PROVIDER_RESPONSE_INVALID", "e") }; const first = render(<FluxDesignerApp client={fake(persisted)} />);
    expect(await screen.findByText("Provider response was invalid")).toBeInTheDocument(); first.unmount();
    render(<FluxDesignerApp client={fake(persisted)} />);
    expect(await screen.findByText("Provider response was invalid")).toBeInTheDocument(); expect(screen.getByText("PROVIDER_RESPONSE_INVALID")).toBeInTheDocument();
  });

  it("preserves Open, checkpoint, approval, resume, and explicit terminal-disposition gates", async () => {
    const user = userEvent.setup(); render(<FluxDesignerApp client={fake()} />); await screen.findByText("Design Contract"); await waitFor(() => expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Prepare isolated run" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open isolated copy" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open isolated copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Checkpoint Open" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Checkpoint Open" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve exact digest" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Approve exact digest" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Terminal disposition")).toBeInTheDocument(); expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
  });

  it("keeps Open locked through its authoritative phase reread and suppresses a second window", async () => {
    const user = userEvent.setup(); const initial = run("awaiting_open"); const client = fake(initial); let pollCount = 0; let resolveReread!: (page: FluxPollResult) => void;
    const reread = new Promise<FluxPollResult>((resolve) => { resolveReread = resolve; });
    client.open = vi.fn(async () => ({ opened: true, label: "Opened isolated candidate", checkpointRequired: true }));
    client.poll = async (_runId, after) => { pollCount += 1; if (pollCount === 1) return { run: initial, queue: { queuedRunIds: [] }, events: after === 0 ? [event(1, "run_prepared")] : [], nextEventSeq: 1 }; return reread; };
    render(<FluxDesignerApp client={client} />); const open = await screen.findByRole("button", { name: "Open isolated copy" }); await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const synchronizing = await screen.findByRole("button", { name: "Opening…" }); expect(synchronizing).toBeDisabled();
    await user.click(synchronizing); expect(client.open).toHaveBeenCalledTimes(1);
    await act(async () => { resolveReread({ run: { ...run("awaiting_checkpoint"), updatedAt: "2026-09-07T00:00:01.000Z" }, queue: { queuedRunIds: [] }, events: [event(2, "run_opened")], nextEventSeq: 2 }); await reread; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Checkpoint Open" })).toBeEnabled());
  });

  it("does not let Preview or Inspect abort an in-flight committed mutation", async () => {
    const user = userEvent.setup(); let mutationSignal: AbortSignal | undefined; let finish!: (value: FluxRunDto) => void;
    const pending = new Promise<FluxRunDto>((resolve) => { finish = resolve; });
    const initial = { ...run(), preview: { title: "Candidate", summary: "Prepared", artifactCount: 1, digest: "a".repeat(64) } };
    const client = fake(initial); client.prepare = async (_runId, signal) => { mutationSignal = signal; return pending; };
    render(<FluxDesignerApp client={client} />); await screen.findByText("Design Contract"); await waitFor(() => expect(screen.getByRole("button", { name: "Prepare isolated run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Prepare isolated run" }));
    expect(screen.getByRole("button", { name: "Create generic run" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh views" }));
    await user.click(screen.getByRole("button", { name: "Run read-only inspection" }));
    expect(mutationSignal?.aborted).toBe(false);
    finish({ ...run("awaiting_open"), updatedAt: "2026-09-06T00:00:01.000Z" });
    expect(await screen.findByRole("button", { name: "Open isolated copy" })).toBeEnabled();
  });

  it("recovers polling after a transient failure instead of stopping", async () => {
    vi.useFakeTimers(); const initial = run("running"); const client = fake(initial); let polls = 0;
    client.poll = async (): Promise<FluxPollResult> => { polls += 1; if (polls === 2) throw new TypeError("temporary poll loss"); const current = polls >= 3 ? { ...run("completed"), updatedAt: "2026-09-06T00:00:05.000Z" } : initial; return { run: current, queue: { queuedRunIds: [] }, events: [], nextEventSeq: 0 }; };
    render(<FluxDesignerApp client={client} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLUX_POLL_DELAY_MS.active); });
    expect(screen.getByText("temporary poll loss")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(FLUX_POLL_DELAY_MS.retry); });
    expect(screen.getByText("Terminal disposition")).toBeInTheDocument(); expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("keeps the 360px structure bounded and core controls keyboard-focusable", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 }); const user = userEvent.setup(); render(<FluxDesignerApp client={fake(null)} />);
    const create = await screen.findByRole("button", { name: "Create generic run" }); await waitFor(() => expect(create).toBeEnabled()); create.focus(); expect(create).toHaveFocus();
    await user.tab(); expect(document.activeElement).not.toBe(document.body);
    const main = document.getElementById("flux-workspace-main")!; expect(main).toBeInTheDocument(); expect(main.scrollWidth).toBeLessThanOrEqual(360);
    expect([...main.querySelectorAll<HTMLElement>("[style]")].some((node) => /min-width:\s*[4-9][0-9]{2}px/iu.test(node.getAttribute("style") ?? ""))).toBe(false);
  });

  it("merges incremental event pages by sequence without duplicates", () => {
    expect(mergeFluxEvents([event(2, "run_started")], [event(1, "run_queued"), event(2, "run_completed")]).map((item) => item.kind)).toEqual(["run_queued", "run_completed"]);
  });
});
