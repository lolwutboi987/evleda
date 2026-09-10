// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDemoSnapshot } from "../demo";
import { BundleStation } from "./BundleStation";

afterEach(cleanup);

describe("BundleStation", () => {
  it("does not present workflow completion and digests as prototype qualification readiness", () => {
    const snapshot = makeDemoSnapshot();
    const completedRun = { ...snapshot.run, state: "completed" as const };
    render(
      <BundleStation
        run={completedRun}
        effectiveLifecycle="candidate"
        activeQualification={false}
        qualificationReady={false}
        engineeringDisposition="PROVISIONAL_POC"
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        onExportCandidate={vi.fn(async () => undefined)}
        onExportPrototype={vi.fn(async () => undefined)}
        onGenerateBringup={vi.fn(async () => undefined)}
        onGenerateFirmware={vi.fn(async () => undefined)}
        onQualify={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText("Qualification unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Completion and digests are not enough/i)).toBeInTheDocument();
    expect(screen.getByText(/CURRENT PASSING PHYSICAL-V2 EVIDENCE REQUIRED/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();
  });

  it("requires both derived qualification and an exact active attestation for prototype export", () => {
    const snapshot = makeDemoSnapshot();
    const completedRun = { ...snapshot.run, state: "completed" as const };
    const callbacks = {
      onExportCandidate: vi.fn(async () => undefined),
      onExportPrototype: vi.fn(async () => undefined),
      onGenerateBringup: vi.fn(async () => undefined),
      onGenerateFirmware: vi.fn(async () => undefined),
      onQualify: vi.fn(async () => undefined)
    };
    const { rerender } = render(
      <BundleStation
        run={completedRun}
        effectiveLifecycle="qualified"
        activeQualification={false}
        qualificationReady
        engineeringDisposition="PROVISIONAL_POC"
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        {...callbacks}
      />
    );

    expect(screen.getByRole("button", { name: "Export candidate bundle" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();

    rerender(
      <BundleStation
        run={completedRun}
        effectiveLifecycle="qualified"
        activeQualification
        qualificationReady
        engineeringDisposition="PROVISIONAL_POC"
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        {...callbacks}
      />
    );

    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeEnabled();
    expect(screen.getByText("Exact human qualification is active")).toBeInTheDocument();
  });

  it("fails package export closed for blocked or unavailable engineering inspection", () => {
    const snapshot = makeDemoSnapshot();
    const completedRun = { ...snapshot.run, state: "completed" as const };
    const callbacks = {
      onExportCandidate: vi.fn(async () => undefined),
      onExportPrototype: vi.fn(async () => undefined),
      onGenerateBringup: vi.fn(async () => undefined),
      onGenerateFirmware: vi.fn(async () => undefined),
      onQualify: vi.fn(async () => undefined)
    };
    const { rerender } = render(
      <BundleStation
        run={completedRun}
        effectiveLifecycle="qualified"
        activeQualification
        qualificationReady
        engineeringDisposition="BLOCKED_DIAGNOSTIC"
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        {...callbacks}
      />
    );

    expect(screen.getAllByText(/BLOCKED_DIAGNOSTIC ENGINEERING DISPOSITION/i)).toHaveLength(2);
    expect(screen.getByText("Exact human qualification is active")).toBeInTheDocument();
    expect(screen.getByText(/prototype export is locked by independent workflow or engineering gates/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export candidate bundle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();

    rerender(
      <BundleStation
        run={completedRun}
        effectiveLifecycle="qualified"
        activeQualification
        qualificationReady
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        {...callbacks}
      />
    );

    expect(screen.getAllByText(/AUTHORITATIVE ENGINEERING INSPECTION UNAVAILABLE/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Export candidate bundle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();
  });
});
