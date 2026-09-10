// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignInspector } from "./DesignInspector";
import { OperationTimeline } from "./OperationTimeline";
import { RuntimeStatus } from "./RuntimeStatus";
import { safeDisplay } from "./safe-display";
import type { FluxContractStateDto, FluxInspectorSnapshot, FluxRuntimeReadinessDto } from "./model";

afterEach(cleanup);

const identity = (digit: string, schemaVersion = "evleda.safe.v1") => ({ algorithm: "sha256" as const, digest: digit.repeat(64), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const });

describe("Flux safe display projection", () => {
  it("recursively bounds and redacts paths, credentials, controls, sensitive fields, and unknown values", () => {
    const cycle: Record<string, unknown> = { safe: "clearance passed" }; cycle.self = cycle;
    const projected = safeDisplay({
      safe: "clearance passed",
      win: "Failure at C:\\private\\board.kicad_pcb",
      posix: "Failure at /home/operator/board.kicad_pcb",
      unc: "Failure at \\\\server\\share\\board.kicad_pcb",
      fileUri: "file:///home/operator/board.kicad_pcb",
      relativeWindows: "..\\private\\board.kicad_pcb",
      relativePosix: "project/private/board.kicad_pcb",
      forwardUnc: "//server/share/board.kicad_pcb",
      apiKey: "sk-supersecretvalue",
      ordinary: "SK-SUPERSECRETVALUE",
      cookieHeader: "Cookie: sessionId=top-secret-session",
      sessionCredential: "session_token=top-secret-session",
      pem: "-----BEGIN PRIVATE KEY----- private material",
      nested: { authorization: "Bearer secret-value", control: "bad\u0000text", long: "x".repeat(513) },
      unsupported: Symbol("do-not-stringify"),
      cycle,
    });
    expect(projected).toContain("clearance passed");
    expect(projected).toContain("[redacted path]");
    expect(projected).toContain("[redacted field]: [redacted]");
    expect(projected).toContain("[redacted control text]");
    expect(projected).toContain("[redacted overlong text]");
    expect(projected).toContain("[unsupported value]");
    expect(projected).toContain("[circular]");
    expect(projected).not.toMatch(/C:\\private|file:\/\/|\/home\/operator|\\\\server|\/\/server|\.\.\\private|project\/private|top-secret-session|BEGIN PRIVATE KEY|supersecret|Bearer secret|bad\u0000text/iu);
  });

  it("sanitizes operation event details before rendering", () => {
    render(<OperationTimeline events={[{ id: "event_1", eventSeq: 1, runId: "run_1", kind: "run_failed", at: "2026-09-07T00:00:00.000Z", detail: "Source failed at /private/project/board.kicad_pcb" }]} />);
    expect(screen.getByText("[redacted path]")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("/private/project");
  });

  it("uses the same projection for contract issues and nested inspector values", () => {
    const contract = { disposition: "unsupported", questions: [], issues: [{ code: "AUTH_ERROR", severity: "error", path: "/scope", message: "apiKey=sk-supersecretvalue", clarificationId: null }], contract: null, contractIdentity: null, libraryBindingIdentity: null, deepRuleBindingIdentity: null, acceptancePlanIdentity: null, interpreterReceipt: { schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "fixture", provider: "fixture", promptDigest: "a".repeat(64), clarificationDigest: "b".repeat(64), compiledAt: "2026-09-07T00:00:00.000Z" } } satisfies FluxContractStateDto;
    const tool = (name: "pcb_get_board_summary" | "pcb_get_design_rules" | "pcb_get_footprints" | "pcb_get_tracks" | "pcb_get_vias" | "pcb_get_zones", value: unknown) => ({ tool: name, value });
    const snapshot: FluxInspectorSnapshot = { state: "ready", busy: false, completedTools: 6, totalTools: 6, capturedAt: "2026-09-07T00:00:00.000Z", boardSummary: tool("pcb_get_board_summary", { sourceRoot: "C:\\private\\source", safe: "2 layers" }), rules: tool("pcb_get_design_rules", { token: "secret" }), footprints: tool("pcb_get_footprints", []), tracks: tool("pcb_get_tracks", []), vias: tool("pcb_get_vias", []), zones: tool("pcb_get_zones", []) };
    render(<DesignInspector snapshot={snapshot} contract={contract} busy={false} onInspect={() => undefined} />);
    expect(screen.getAllByText(/\[redacted/iu).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/supersecret|C:\\private|sourceRoot|token: secret/iu);
  });

  it("sanitizes provider model and adapter strings at the readiness surface", () => {
    const readiness: FluxRuntimeReadinessDto = { schemaVersion: "evleda.flux-readiness.v1", configured: true, status: "ready", reasonCodes: [], provider: { provider: "openai", model: "model at C:\\private\\model", requestedTier: "standard", canonicalTier: "standard", adapterSchemaVersion: "token=sk-supersecretvalue", providerProfileIdentity: identity("a"), localReadCapability: "none", configurationPreflight: null }, compiler: { profileIdentity: identity("b"), catalogIdentity: identity("c"), exactSymbolCount: 1, exactFootprintCount: 1, symbolNicknameCount: 1, footprintNicknameCount: 1 }, toolchain: { identity: identity("d", "evleda.flux-kicad-toolchain-binding.v1"), kicadCli: { identity: identity("e", "evleda.flux-kicad-cli-binding.v1"), operationalVersion: "10.0.3", operationalCommit: "1".repeat(40), peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" }, pcbnew: { identity: identity("f", "evleda.flux-pcbnew-binding.v1"), peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" } }, kicadMcpRuntime: { identity: identity("0", "evleda.kicad-mcp-runtime.v1"), inspectionBridgeIdentity: identity("1", "evleda.kicad-mcp-inspection-bridge.v2"), executionBridgeIdentity: identity("2", "evleda.kicad-mcp-execution-bridge.v1"), connectionPolicy: { maxConnections: 8, concurrency: 1, reuse: "same-live-run-bounded" as const, restart: "fail-closed-reallocate-reapprove" as const, cleanup: "after-confirmed-session-and-editor-stop" as const, unconfirmed: "retain-poison-no-retry" as const } }, diagnostic: null };
    render(<RuntimeStatus readiness={readiness} state="ready" error={undefined} onRetry={() => undefined} />);
    expect(screen.getByText("[redacted path]")).toBeInTheDocument();
    expect(screen.getByText("[redacted credential]")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/C:\\private|supersecret/iu);
  });
});
