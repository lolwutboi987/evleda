// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineeringFinding,
  makeEngineeringInspection
} from "../testing/engineeringFixture";
import { EngineeringPracticePanel } from "./EngineeringPracticePanel";

afterEach(cleanup);

const callbacks = () => ({
  onRetry: vi.fn(async () => undefined),
  onLoadMore: vi.fn(async () => undefined)
});

describe("EngineeringPracticePanel", () => {
  it("always shows the proof-fixture boundary and focuses a scoped endpoint error", async () => {
    render(
      <EngineeringPracticePanel
        hasRun
        loading={false}
        loadingMore={false}
        error="The engineering endpoint failed its integrity check."
        {...callbacks()}
      />
    );

    expect(screen.getByRole("note", { name: "Proof fixture limitation" })).toHaveTextContent(
      "candidate only"
    );
    expect(screen.getByRole("note", { name: "Proof fixture limitation" })).toHaveTextContent(
      "never establishes qualification"
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No engineering PASS, POC, waiver, qualification, or release state was substituted");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.queryByText("PROVISIONAL_POC")).not.toBeInTheDocument();
  });

  it("keeps Native DRC separate from a failing EvlEDA practice check and exposes exact diagnostics", () => {
    const inspection = makeEngineeringInspection();
    render(
      <EngineeringPracticePanel
        hasRun
        inspection={inspection}
        findingPages={[inspection]}
        loading={false}
        loadingMore={false}
        {...callbacks()}
      />
    );

    const nativeCard = screen.getByRole("heading", { name: "Native DRC" }).closest("section");
    const practiceCard = screen.getByRole("heading", { name: "EvlEDA Practice" }).closest("section");
    expect(nativeCard).not.toBeNull();
    expect(practiceCard).not.toBeNull();
    expect(within(nativeCard!).getByText("PASS")).toBeInTheDocument();
    expect(within(practiceCard!).getByText("FAIL")).toBeInTheDocument();
    expect(screen.getByText("BLOCKED_DIAGNOSTIC", { selector: "h3" })).toBeInTheDocument();

    const coverage = screen.getByRole("region", { name: "Engineering coverage totals" });
    expect(within(coverage).getByRole("columnheader", { name: "NOT_RUN" })).toBeInTheDocument();
    expect(within(coverage).getByRole("columnheader", { name: "N/A" })).toBeInTheDocument();
    expect(within(coverage).getByRole("row", { name: /All rules 2 2 1 0 1 0 0 1/i })).toBeInTheDocument();

    expect(screen.getByText("design/robotics-controller.kicad_pcb")).toBeInTheDocument();
    expect(screen.getByText("1842 / 5")).toBeInTheDocument();
    expect(screen.getByText("8b2e6402-43e5-4ea7-a24e-8da5f9f02d43")).toBeInTheDocument();
    expect(screen.getByText(/Create a new routed revision/i)).toBeInTheDocument();
    expect(screen.getByText(/Rerun Native DRC on the exact new board bytes/i)).toBeInTheDocument();
    expect(screen.getAllByText(/EvlEDA PCB Route Quality Policy v1/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /EvlEDA PCB Route Quality Policy v1/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/embedded internal policy provenance/i).length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link", { name: /JLCPCB PCB Manufacturing Capabilities/i })) {
      expect(link).toHaveAttribute("href", "https://jlcpcb.com/capabilities/Capabilities");
    }

    const gateOwners = screen.getByRole("heading", { name: "Gate owners" }).closest("section");
    expect(gateOwners).not.toBeNull();
    for (const owner of ["Machine", "Fabricator", "Human", "Physical"]) {
      expect(within(gateOwners!).getAllByText(owner, { exact: true }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("button", { name: /waive|accept finding|mark pass|release/i })).not.toBeInTheDocument();
  });

  it("renders PROVISIONAL_POC as amber candidate-only while preserving review advisories", () => {
    const inspection = makeEngineeringInspection({ disposition: "PROVISIONAL_POC" });
    render(
      <EngineeringPracticePanel
        hasRun
        inspection={inspection}
        findingPages={[inspection]}
        loading={false}
        loadingMore={false}
        {...callbacks()}
      />
    );

    const pocTag = screen.getByText("PROVISIONAL_POC", { selector: ".status-tag span" }).closest(".status-tag");
    expect(pocTag).toHaveClass("status-warning");
    expect(screen.getByText(/Candidate-only proof-of-concept eligibility/i)).toBeInTheDocument();
    expect(screen.getByText(/Review required · 1 advisories/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review advisories" })).toBeInTheDocument();
    expect(screen.getByText(/human should review the return-path context/i)).toBeInTheDocument();
    expect(screen.queryByText(/manufacturing ready/i)).not.toBeInTheDocument();
  });

  it("shows NOT_RUN literally and independently when no current PCB reports exist", () => {
    const inspection = makeEngineeringInspection({
      revisionId: null,
      isHeadRevision: true,
      nativeDrcStatus: "NOT_RUN",
      practiceStatus: "NOT_RUN",
      findings: [],
      findingsTotal: 0,
      reviewRequired: false,
      advisoryCount: 0
    });
    render(
      <EngineeringPracticePanel
        hasRun
        inspection={inspection}
        findingPages={[inspection]}
        loading={false}
        loadingMore={false}
        {...callbacks()}
      />
    );

    const nativeCard = screen.getByRole("heading", { name: "Native DRC" }).closest("section");
    const practiceCard = screen.getByRole("heading", { name: "EvlEDA Practice" }).closest("section");
    expect(within(nativeCard!).getByText("NOT_RUN", { exact: true })).toBeInTheDocument();
    expect(within(practiceCard!).getByText("NOT_RUN", { exact: true })).toBeInTheDocument();
    expect(within(nativeCard!).queryByText("PASS", { exact: true })).not.toBeInTheDocument();
    expect(within(practiceCard!).queryByText("PASS", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("BLOCKED_DIAGNOSTIC", { selector: "h3" })).toBeInTheDocument();
  });

  it("requests the next stable findings page without changing aggregate totals", async () => {
    const onLoadMore = vi.fn(async () => undefined);
    const inspection = makeEngineeringInspection({
      findings: [engineeringFinding("finding-page-1")],
      findingsTotal: 51,
      nextCursor: "cursor-page-2"
    });
    render(
      <EngineeringPracticePanel
        hasRun
        inspection={inspection}
        findingPages={[inspection]}
        loading={false}
        loadingMore={false}
        onRetry={vi.fn(async () => undefined)}
        onLoadMore={onLoadMore}
      />
    );

    const button = screen.getByRole("button", { name: "Load more findings" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.getByText("1 loaded / 51 total")).toBeInTheDocument();
    expect(screen.getByText("1 of 51 findings loaded.")).toBeInTheDocument();
  });
});
