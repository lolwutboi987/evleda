// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDemoSnapshot } from "../demo";
import { RequirementsPanel } from "./RequirementsPanel";

afterEach(cleanup);

describe("RequirementsPanel", () => {
  it("requires an explicit human acknowledgement before binding approval", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot(undefined, undefined, "new");
    const handleApprove = vi.fn(async () => undefined);

    render(
      <RequirementsPanel
        requirements={snapshot.requirements}
        busy={false}
        requiresCapabilityToken
        onApprove={handleApprove}
      />
    );

    expect(screen.queryByLabelText("Reviewer name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reviewer ID")).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Review rationale"),
      "Electrical limits, exclusions, and acceptance methods reviewed against the source brief."
    );
    await user.click(screen.getByRole("button", { name: "Approve this requirements digest" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Confirm the scope of this approval.");
    expect(handleApprove).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("checkbox", { name: /I am a human requirements reviewer/i })
    );
    const credential = screen.getByLabelText("Requirements review credential");
    expect(credential).toHaveAttribute("autocomplete", "off");
    await user.type(credential, "test-human-capability-token");
    await user.click(screen.getByRole("button", { name: "Approve this requirements digest" }));

    expect(handleApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectDigest: snapshot.requirements?.identity.digest,
        capabilityToken: "test-human-capability-token"
      })
    );
    expect(screen.getByLabelText("Requirements review credential")).toHaveValue("");
  });

  it("fails closed when parsed requirements contain a blocking ambiguity", () => {
    const snapshot = makeDemoSnapshot(
      "Build a generic robotics motor controller without inventing missing electrical limits.",
      "Ambiguous controller",
      "new"
    );

    render(
      <RequirementsPanel
        requirements={snapshot.requirements}
        busy={false}
        requiresCapabilityToken={false}
        onApprove={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText("Approval is fail-closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve this requirements digest/i })).not.toBeInTheDocument();
  });
});
