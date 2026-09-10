// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDemoSnapshot } from "../demo";
import type { ArtifactRecord, EvidenceRecord, ValidationStatus } from "../model";
import { VALIDATION_STATUSES } from "../model";
import { Inspector } from "./Inspector";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Inspector", () => {
  it("loads a bounded JSON preview, offers the original download, and recovers from a server error", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot();
    const bytes = JSON.stringify({ verdict: "candidate only", release: false });
    const artifact = {
      ...snapshot.artifacts[0]!,
      blob: { ...snapshot.artifacts[0]!.blob, size: new TextEncoder().encode(bytes).byteLength }
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "content store temporarily unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: `"sha256:${artifact.blob.digest}"`
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Inspector
        selectedStage="requirements"
        artifacts={[artifact]}
        evidence={[]}
        contentAvailable
      />
    );

    expect(screen.getByRole("link", { name: "Download original" })).toHaveAttribute(
      "href",
      `/api/v1/artifacts/${artifact.id}/content`
    );
    await user.click(screen.getByRole("button", { name: "Preview content" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("content store temporarily unavailable");
    expect(screen.getByRole("alert")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Retry preview" }));
    const preview = await screen.findByLabelText("json artifact preview");
    expect(preview).toHaveTextContent('"verdict": "candidate only"');
    expect(preview).toHaveTextContent('"release": false');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/artifacts/${artifact.id}/content`,
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) })
    );
  });

  it("keeps stale records hidden until requested and exposes temporal provenance", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot();
    const staleArtifact: ArtifactRecord = {
      ...snapshot.artifacts[0]!,
      id: "artifact-stale",
      logicalName: "superseded-requirements.json",
      staleAt: "2026-09-04T01:02:03.000Z"
    };
    const staleEvidence: EvidenceRecord = {
      ...snapshot.evidence[0]!,
      id: "evidence-stale",
      claim: "Superseded requirements binding",
      validUntil: "2026-09-04T02:00:00.000Z",
      staleAt: "2026-09-04T01:02:03.000Z",
      tool: {
        ...snapshot.evidence[0]!.tool,
        capabilityProfile: "strict-local-check",
        executablePath: "C:/tools/check.exe",
        executableDigest: "d".repeat(64)
      }
    };

    render(
      <Inspector
        selectedStage="requirements"
        artifacts={[snapshot.artifacts[0]!, staleArtifact]}
        evidence={[snapshot.evidence[0]!, staleEvidence]}
        contentAvailable={false}
      />
    );

    expect(screen.queryByText("superseded-requirements.json")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Include stale records returned by the API" }));
    expect(screen.getByText("superseded-requirements.json")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Evidence 2/i }));
    await user.click(screen.getByRole("button", { name: "Superseded requirements binding" }));
    expect(screen.getByText("strict-local-check", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("C:/tools/check.exe")).toBeInTheDocument();
    expect(screen.getByText(new Date(staleEvidence.validUntil!).toLocaleString())).toBeInTheDocument();
    expect(screen.getAllByText(new Date(staleEvidence.staleAt!).toLocaleString()).length).toBeGreaterThan(0);
  });

  it("renders an approved bounded raster image through a revocable object URL", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot();
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const artifact: ArtifactRecord = {
      ...snapshot.artifacts[0]!,
      id: "artifact-image",
      logicalName: "board-top.png",
      mediaType: "image/png",
      blob: { ...snapshot.artifacts[0]!.blob, size: bytes.byteLength }
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(bytes.buffer, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            ETag: `"sha256:${artifact.blob.digest}"`
          }
        })
      );
    const createObjectURL = vi.fn(() => "blob:evleda-image-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    render(
      <Inspector
        selectedStage="requirements"
        artifacts={[artifact]}
        evidence={[]}
        contentAvailable
      />
    );
    await user.click(screen.getByRole("button", { name: "Preview content" }));

    expect(await screen.findByRole("img", { name: "Preview of board-top.png" })).toHaveAttribute(
      "src",
      "blob:evleda-image-preview"
    );
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("renders every validation state and refuses oversized or unsafe previews", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot();
    const records = VALIDATION_STATUSES.map((validationStatus: ValidationStatus, index): EvidenceRecord => ({
      ...snapshot.evidence[0]!,
      id: `evidence-${validationStatus}`,
      claim: `Validation ${validationStatus}`,
      validationStatus,
      subjectDigests: [`digest-${index}`]
    }));
    const oversized: ArtifactRecord = {
      ...snapshot.artifacts[0]!,
      id: "artifact-oversized",
      blob: { ...snapshot.artifacts[0]!.blob, size: 1_048_577 }
    };

    render(
      <Inspector
        selectedStage="requirements"
        artifacts={[oversized]}
        evidence={records}
        contentAvailable
      />
    );

    expect(screen.getByRole("button", { name: "Preview content" })).toBeDisabled();
    expect(screen.getByText(/exceeds the 1,048,576-byte text limit/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Evidence 8/i }));
    const table = screen.getByRole("region", { name: "Evidence records" });
    for (const status of VALIDATION_STATUSES) {
      expect(within(table).getByText(`Validation ${status}`)).toBeInTheDocument();
      expect(within(table).getByText(status.replaceAll("_", " "))).toBeInTheDocument();
    }
  });
});
