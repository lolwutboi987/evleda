// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticNotice, parseFluxDiagnostic } from "./DiagnosticNotice";
import { OperationTimeline } from "./OperationTimeline";
import type { FluxDiagnosticCode, FluxDiagnosticDto, FluxSequencedEventDto } from "./model";

afterEach(cleanup);
const diagnostic = (code: FluxDiagnosticCode): FluxDiagnosticDto => ({ schemaVersion: "evleda.flux-diagnostic.v1", code, evidenceIdentity: { algorithm: "sha256", digest: "d".repeat(64), schemaVersion: "evleda.flux-diagnostic-evidence.v1", canonicalizationVersion: "evleda-c14n-json-v1" } });

describe("closed Flux diagnostics", () => {
  it.each(["CODEX_CONFIG_INCOMPATIBLE", "PROVIDER_AUTH_UNAVAILABLE", "PROVIDER_DEADLINE_EXCEEDED", "PROVIDER_CANCELLED", "PROVIDER_PROCESS_EXIT", "PROVIDER_REQUEST_FAILED", "PROVIDER_RESPONSE_INVALID", "SOURCE_DRIFT", "TOOLCHAIN_FAILURE"] as const)("renders only mapped copy for %s", (code) => {
    render(<DiagnosticNotice diagnostic={diagnostic(code)} />);
    expect(screen.getByText(code)).toBeInTheDocument(); expect(document.querySelector(".flux-diagnostic-evidence")).toHaveTextContent("evleda.flux-diagnostic-evidence.v1");
  });

  it("distinguishes an absent legacy record from malformed non-null data", () => {
    expect(parseFluxDiagnostic(undefined)).toEqual({ state: "absent" });
    expect(parseFluxDiagnostic({ ...diagnostic("SOURCE_DRIFT"), extra: "C:\\private\\secret" })).toEqual({ state: "malformed" });
    const view = render(<DiagnosticNotice diagnostic={undefined} legacy />); expect(screen.getByText("Legacy diagnostic unavailable")).toBeInTheDocument(); view.unmount();
    render(<DiagnosticNotice diagnostic={{ ...diagnostic("SOURCE_DRIFT"), extra: "C:\\private\\secret" }} legacy />);
    expect(screen.getByText("Diagnostic unavailable")).toBeInTheDocument(); expect(document.body.textContent).not.toMatch(/SOURCE_DRIFT|C:\\private|secret/iu);
  });

  it("renders an event diagnostic by code while keeping arbitrary detail non-authoritative", () => {
    const event: FluxSequencedEventDto = { id: "event_1", eventSeq: 1, runId: "run_1", kind: "run_failed", at: "2026-09-07T00:00:00.000Z", detail: "Generic provider exited", diagnostic: diagnostic("PROVIDER_PROCESS_EXIT") };
    render(<OperationTimeline events={[event]} />);
    expect(screen.getByText("Provider process exited unsuccessfully")).toBeInTheDocument(); expect(screen.getByText("PROVIDER_PROCESS_EXIT")).toBeInTheDocument();
  });
});
