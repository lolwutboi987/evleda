// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDemoSnapshot } from "../demo";
import { StageRail } from "./StageRail";

afterEach(cleanup);

describe("StageRail", () => {
  it("exposes all nine ordered workflow stages with non-color status labels", async () => {
    const user = userEvent.setup();
    const snapshot = makeDemoSnapshot();
    const handleSelect = vi.fn();

    render(
      <StageRail
        run={snapshot.run}
        selectedStage="component_selection"
        onSelectStage={handleSelect}
      />
    );

    const stageNavigation = screen.getByRole("navigation", { name: "Design workflow stages" });
    const stageButtons = within(stageNavigation).getAllByRole("button");
    expect(stageButtons).toHaveLength(9);
    expect(
      within(stageNavigation).getByRole("button", {
        name: /3\. Component selection — blocked, 2 records/i
      })
    ).toHaveAttribute("aria-current", "step");

    await user.click(
      within(stageNavigation).getByRole("button", { name: /4\. Schematic — pending/i })
    );
    expect(handleSelect).toHaveBeenCalledWith("schematic");
  });
});
