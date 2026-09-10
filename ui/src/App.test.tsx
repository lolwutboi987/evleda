// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { makeDemoSnapshot } from "./demo";
import { makeEngineeringInspection } from "./testing/engineeringFixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Commissioning Bench", () => {
  it("labels an unavailable-API fallback as local demo data and preserves release warnings", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValue(new TypeError("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(screen.getByRole("heading", { name: "Commissioning Bench" })).toBeInTheDocument();
    expect(await screen.findByText("Local demo — API unavailable")).toBeInTheDocument();

    const releaseStatus = screen.getByRole("note", { name: "Release status" });
    expect(within(releaseStatus).getByText("CANDIDATE")).toBeInTheDocument();
    expect(within(releaseStatus).getByText("NOT HUMAN-QUALIFIED")).toBeInTheDocument();
    expect(within(releaseStatus).getByText("NOT FOR MANUFACTURING")).toBeInTheDocument();
    expect(screen.getByText(/controls do not operate on KiCad files/i)).toBeInTheDocument();
  });

  it("renders an honest empty workcell when a connected API has no projects", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("No local projects")).toBeInTheDocument();
    expect(screen.getByText("No workflow to inspect")).toBeInTheDocument();
    expect(screen.queryByText("Local demo — API unavailable")).not.toBeInTheDocument();
  });

  it("surfaces a domain server error with recovery instead of substituting demo data", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message: "State integrity verification failed.",
              retryable: false,
              details: {}
            }
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("State integrity verification failed.");
    expect(screen.getByRole("button", { name: "Retry API" })).toBeInTheDocument();
    expect(screen.queryByText("Local demo — API unavailable")).not.toBeInTheDocument();
  });

  it("keeps an engineering endpoint failure scoped, visible, and package-fail-closed", async () => {
    const snapshot = makeDemoSnapshot();
    const run = {
      ...snapshot.run,
      state: "completed" as const,
      headRevisionId: "revision-engineering-error"
    };
    const project = {
      ...snapshot.project,
      runIds: [run.id],
      headRevisionId: run.headRevisionId
    };
    const headRevision = {
      id: run.headRevisionId,
      projectId: project.id,
      runId: run.id,
      lifecycle: "candidate" as const,
      manifest: {
        algorithm: "sha256" as const,
        digest: "d".repeat(64),
        schemaVersion: "evleda.design-revision.v1",
        canonicalizationVersion: "evleda-c14n-json-v1"
      }
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const url = String(input);
        if (url.endsWith("/projects")) {
          return new Response(JSON.stringify({ projects: [project] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/engineering-practices")) {
          return new Response(JSON.stringify({ message: "Engineering report integrity failed." }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
        const value = url.endsWith("/requirements")
          ? { requirements: snapshot.requirements }
          : url.includes("/artifacts")
            ? { artifacts: snapshot.artifacts }
            : url.includes("/evidence")
              ? {
                  evidence: snapshot.evidence,
                  evidenceRoot: { algorithm: "sha256", digest: "e".repeat(64) }
                }
              : {
                  project,
                  run,
                  headRevision,
                  effectiveLifecycle: "candidate",
                  activeAttestations: [],
                  stateRevision: 12
                };
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Engineering report integrity failed.");
    expect(alert).toHaveTextContent(/No engineering PASS, POC, waiver/i);
    expect(screen.getByRole("note", { name: "Proof fixture limitation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export candidate bundle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();
    expect(screen.queryByText("Local demo — API unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("PROVISIONAL_POC")).not.toBeInTheDocument();
  });

  it("does not unlock qualification when a completed run has only digests and nonphysical evidence", async () => {
    const snapshot = makeDemoSnapshot();
    const run = {
      ...snapshot.run,
      state: "completed" as const,
      headRevisionId: "revision-completed-no-physical"
    };
    const project = {
      ...snapshot.project,
      runIds: [run.id],
      headRevisionId: run.headRevisionId
    };
    const headRevision = {
      id: run.headRevisionId,
      projectId: project.id,
      runId: run.id,
      lifecycle: "candidate" as const,
      manifest: {
        algorithm: "sha256" as const,
        digest: "d".repeat(64),
        schemaVersion: "evleda.design-revision.v1",
        canonicalizationVersion: "evleda-c14n-json-v1"
      }
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const url = String(input);
        const value = url.endsWith("/projects")
          ? { projects: [project] }
          : url.endsWith("/requirements")
            ? { requirements: snapshot.requirements }
            : url.includes("/engineering-practices")
              ? makeEngineeringInspection({
                  projectId: project.id,
                  runId: run.id,
                  revisionId: run.headRevisionId,
                  disposition: "PROVISIONAL_POC"
                })
            : url.includes("/artifacts")
              ? { artifacts: snapshot.artifacts }
              : url.includes("/evidence")
                ? {
                    evidence: snapshot.evidence,
                    evidenceRoot: { algorithm: "sha256", digest: "e".repeat(64) }
                  }
                : {
                    project,
                    run,
                    headRevision,
                    effectiveLifecycle: "candidate",
                    activeAttestations: [],
                    stateRevision: 9
                  };
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("Qualification unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Completion and digests are not enough/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();
    expect(screen.queryByText("Record exact hardware qualification")).not.toBeInTheDocument();
  });
});
