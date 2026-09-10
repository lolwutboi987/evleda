// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QualificationGate } from "./QualificationGate";

afterEach(cleanup);

describe("QualificationGate", () => {
  it("does not request a qualification credential until an exact completed revision is qualifiable", () => {
    render(
      <QualificationGate
        ready={false}
        qualified={false}
        exportEnabled={false}
        busy={false}
        onQualify={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText("Qualification unavailable")).toBeInTheDocument();
    expect(screen.getByText(/evleda\.human-physical-evidence\.v2/i)).toBeInTheDocument();
    expect(screen.getByText(/all seven physical categories/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Hardware qualification credential")).not.toBeInTheDocument();
  });

  it("collects an exact, acknowledged human qualification in component memory", async () => {
    const user = userEvent.setup();
    const handleQualify = vi.fn(async () => undefined);
    render(
      <QualificationGate
        ready
        qualified={false}
        exportEnabled={false}
        busy={false}
        revisionDigest={"a".repeat(64)}
        requirementsDigest={"b".repeat(64)}
        evidenceRootDigest={"c".repeat(64)}
        onQualify={handleQualify}
      />
    );

    expect(screen.queryByLabelText("Hardware qualification credential")).not.toBeInTheDocument();
    await user.click(screen.getByText("Record exact hardware qualification"));
    expect(screen.queryByLabelText("Qualifier name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Qualifier ID")).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Evidence and physical review rationale"),
      "Physical measurements and all bound evidence identities were reviewed."
    );
    const credential = screen.getByLabelText("Hardware qualification credential");
    expect(credential).toHaveAttribute("autocomplete", "off");
    await user.type(credential, "test-qualification-capability-token");
    await user.click(screen.getByRole("button", { name: "Record exact qualification" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Confirm that qualification is exact and is not manufacturing release."
    );
    expect(handleQualify).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("checkbox", { name: /I am the human hardware qualifier/i })
    );
    await user.click(screen.getByRole("button", { name: "Record exact qualification" }));

    expect(handleQualify).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityToken: "test-qualification-capability-token",
        scope: "One controlled prototype build of this exact revision"
      })
    );
    expect(screen.getByLabelText("Hardware qualification credential")).toHaveValue("");
  });
});
