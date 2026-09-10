import { describe, expect, it } from "vitest";
import { resolveUiRoute } from "./route";

describe("UI route shell", () => {
  it.each(["/flux", "/flux/"])("routes %s to the Flux title and real main skip target", (pathname) => {
    expect(resolveUiRoute(pathname)).toEqual({ kind: "flux", title: "EvlEDA — Flux Design Workspace", skipTarget: "#flux-workspace-main", skipLabel: "Skip to Flux workspace" });
  });

  it("keeps the commissioning shell as the fallback", () => {
    expect(resolveUiRoute("/")).toEqual({ kind: "bench", title: "EvlEDA — Commissioning Bench", skipTarget: "#bench-main", skipLabel: "Skip to commissioning bench" });
  });
});
