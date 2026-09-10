export interface UiRoute {
  readonly kind: "flux" | "bench";
  readonly title: string;
  readonly skipTarget: string;
  readonly skipLabel: string;
}

export const resolveUiRoute = (pathname: string): UiRoute => pathname === "/flux" || pathname === "/flux/"
  ? { kind: "flux", title: "EvlEDA — Flux Design Workspace", skipTarget: "#flux-workspace-main", skipLabel: "Skip to Flux workspace" }
  : { kind: "bench", title: "EvlEDA — Commissioning Bench", skipTarget: "#bench-main", skipLabel: "Skip to commissioning bench" };
