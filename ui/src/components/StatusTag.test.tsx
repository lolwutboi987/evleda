// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusTag } from "./StatusTag";

afterEach(cleanup);

describe("StatusTag engineering tones", () => {
  it("keeps POC amber and distinguishes UNKNOWN from NOT_RUN and N/A", () => {
    render(
      <div>
        <StatusTag status="PROVISIONAL_POC" label="PROVISIONAL_POC" />
        <StatusTag status="UNKNOWN" label="UNKNOWN" />
        <StatusTag status="NOT_RUN" label="NOT_RUN" />
        <StatusTag status="NOT_APPLICABLE" label="N/A" />
      </div>
    );

    expect(screen.getByText("PROVISIONAL_POC").closest(".status-tag")).toHaveClass("status-warning");
    expect(screen.getByText("UNKNOWN").closest(".status-tag")).toHaveClass("status-warning");
    expect(screen.getByText("NOT_RUN").closest(".status-tag")).not.toHaveClass("status-warning");
    expect(screen.getByText("NOT_RUN").closest(".status-tag")).not.toHaveClass("status-success");
    expect(screen.getByText("N/A").closest(".status-tag")).not.toHaveClass("status-success");
  });
});
