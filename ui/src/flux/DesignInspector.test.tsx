// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyFluxDeepRuleSummary } from "./deep-rule-summary";
import { DesignInspector } from "./DesignInspector";
import type { FluxCanonicalIdentityDto, FluxContractStateDto, FluxDeepRuleSummaryDto } from "./model";

afterEach(cleanup);

const identity = (digit = "a", schemaVersion = "evleda.pcb-design-contract.v1"): FluxCanonicalIdentityDto => ({ algorithm: "sha256", digest: digit.repeat(64), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" });
const canonical = (value: unknown): string => value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const canonicalIdentity = (payload: object, schemaVersion: string): FluxCanonicalIdentityDto => ({ algorithm: "sha256", digest: createHash("sha256").update(canonical(payload)).digest("hex"), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" });
const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: 0.001, maximumContinuousA: 0.001, peakA: 0.001, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});
const placement = (reference: string, edgePreference: "none" | "left" = "none") => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: edgePreference === "left" ? [0] : [0, 90, 180, 270],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference,
});
const route = (net: string, topology: "point_to_point" | "tree" = "point_to_point") => ({ net, topology, preferredLayer: "either", maxVias: 1, routeLength: { mode: "unbounded" } });

const dividerContract = () => ({
  schemaVersion: "evleda.pcb-design-contract.v1",
  kind: "pcb_design_contract",
  scope: { sheetCount: 1, componentUnitPolicy: "single_unit", board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } },
  components: [
    { reference: "J1", symbolLibId: "Connector_Generic:Conn_01x04", value: "DIVIDER_IO", footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", unit: 1, pins: [{ pin: "1", assignment: { kind: "net", net: "VIN" } }, { pin: "2", assignment: { kind: "net", net: "VOUT" } }, { pin: "3", assignment: { kind: "net", net: "GND" } }, { pin: "4", assignment: { kind: "no_connect" } }] },
    { reference: "R1", symbolLibId: "Device:R", value: "10k", footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1, pins: [{ pin: "1", assignment: { kind: "net", net: "VIN" } }, { pin: "2", assignment: { kind: "net", net: "VOUT" } }] },
    { reference: "R2", symbolLibId: "Device:R", value: "10k", footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1, pins: [{ pin: "1", assignment: { kind: "net", net: "VOUT" } }, { pin: "2", assignment: { kind: "net", net: "GND" } }] },
  ],
  nets: [
    { name: "VIN", role: "analog", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }], electrical: electrical(3.3), netClassId: "DEFAULT" },
    { name: "VOUT", role: "analog", endpoints: [{ reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }, { reference: "R2", pin: "1" }], electrical: electrical(1.65), netClassId: "DEFAULT" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "3" }, { reference: "R2", pin: "2" }], electrical: electrical(0), netClassId: "DEFAULT" },
  ],
  netClasses: [{ id: "DEFAULT", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu", "B.Cu"] }],
  placementConstraints: [placement("J1", "left"), placement("R1"), placement("R2")],
  routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.2, allowRightAngleCorners: false, allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false, viaPolicy: { mode: "bounded", maxTotal: 3, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 }, nets: [route("VIN"), route("VOUT", "tree"), route("GND")] },
  identity: identity(),
});

const deepRuleBindingIdentity = identity("c", "evleda.pcb-deep-rule-binding.v1");
const ruleSummary = (): FluxDeepRuleSummaryDto => {
  const payload = {
    schemaVersion: "evleda.flux-deep-rule-summary.v1" as const,
    deepRuleBindingIdentity,
    catalogIdentity: identity("e", "evleda.deep-rule-catalog.v1"),
    selectedCount: 24,
    selectedRuleIds: Array.from({ length: 24 }, (_, index) => `PCB01-R${String(index + 1).padStart(3, "0")}`),
    coveredFeatures: ["assembly", "dfm", "placement"] as const,
    uncoveredFeatures: [] as const,
  };
  return { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
};

const state = (contract: unknown = dividerContract(), summary?: FluxDeepRuleSummaryDto): FluxContractStateDto => ({
  disposition: "ready",
  questions: [],
  issues: [],
  contract: contract as Readonly<Record<string, unknown>>,
  contractIdentity: identity(),
  libraryBindingIdentity: identity("b", "evleda.pcb-library-binding.v1"),
  deepRuleBindingIdentity,
  ...(summary === undefined ? {} : { deepRuleSummary: summary }),
  acceptancePlanIdentity: identity("d", "evleda.pcb-acceptance-plan.v1"),
  interpreterReceipt: { schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "fixture", provider: "fixture", promptDigest: "e".repeat(64), clarificationDigest: "f".repeat(64), compiledAt: "2026-09-07T00:00:00.000Z" },
});

describe("DesignInspector contract projection", () => {
  it("renders the exact divider board, routing practice, routes, and placement constraints", () => {
    render(<DesignInspector snapshot={undefined} contract={state()} busy={false} onInspect={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Board and sheet" })).toBeInTheDocument();
    expect(screen.getByLabelText("Board dimensions and layers")).toHaveTextContent("Rectangle, 30 mm × 20 mm");
    expect(screen.getByLabelText("Board dimensions and layers")).toHaveTextContent("2 layers · F.Cu, B.Cu");
    const routes = screen.getByLabelText("Contract per-net routes");
    expect(routes).toHaveTextContent("VIN · point to point · either");
    expect(routes).toHaveTextContent("VOUT · tree · either");
    expect(routes).toHaveTextContent("Maximum vias 1 · Route length Unbounded");
    const practice = screen.getByLabelText("Contract routing practice constraints");
    expect(practice).toHaveTextContent("miter 45 · Maximum turn 45°");
    expect(practice).toHaveTextContent("Minimum straight before turn0.2 mm");
    expect(within(practice).getAllByText("Forbidden")).toHaveLength(4);
    expect(practice).toHaveTextContent("Backtracking / hairpinsForbidden");
    expect(practice).toHaveTextContent("Bounded · Maximum total 3 · Diameter 0.6 mm · Drill 0.3 mm · Minimum annular ring 0.15 mm");
    const placements = screen.getByLabelText("Contract placement constraints");
    expect(placements).toHaveTextContent("J1 · front side · left edge preference");
    expect(placements).toHaveTextContent("Region X 1 mm–29 mm · Y 1 mm–19 mm");
    expect(placements).toHaveTextContent("Allowed rotations 0°, 90°, 180°, 270°");
    expect(placements).toHaveTextContent("Minimum edge clearance 1 mm · Courtyard clearance 0.25 mm");
    expect(screen.queryByText("None recorded.")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("[unsupported value]");
  });

  it("renders complete component, pin, net, electrical, and net-class details with accessible labels", () => {
    render(<DesignInspector snapshot={undefined} contract={state()} busy={false} onInspect={vi.fn()} />);
    expect(screen.getByLabelText("Contract components")).toHaveTextContent("J1 · DIVIDER_IO");
    expect(screen.getByLabelText("Contract pin dispositions")).toHaveTextContent("J1.4No connect");
    expect(screen.getByLabelText("Contract nets")).toHaveTextContent("VIN · analog · Class DEFAULT");
    expect(screen.getByLabelText("Contract nets")).toHaveTextContent("Voltage 3.3–3.3 V (nominal 3.3 V)");
    expect(screen.getByLabelText("Contract net classes")).toHaveTextContent("Trace 0.25 mm · Clearance 0.2 mm · Copper to edge 0.3 mm");
    expect(screen.getByRole("button", { name: "Run read-only inspection" })).toBeEnabled();
  });

  it("renders only a structurally bound and independently rehashed deep-rule summary", async () => {
    const summary = ruleSummary();
    await expect(verifyFluxDeepRuleSummary(summary, deepRuleBindingIdentity)).resolves.toBe(true);
    render(<DesignInspector snapshot={undefined} contract={state(dividerContract(), summary)} authorityIntegrity="valid" busy={false} onInspect={vi.fn()} />);
    expect(screen.getByLabelText("Selected deep-rule summary")).toHaveTextContent("Selected count24");
    expect(screen.getByLabelText("Selected deep-rule IDs").children).toHaveLength(24);
    expect(screen.getByLabelText("Selected deep-rule IDs")).toHaveTextContent("PCB01-R001");
    expect(screen.getByLabelText("Selected deep-rule IDs")).toHaveTextContent("PCB01-R024");
    expect(screen.getByLabelText("Covered deep-rule features")).toHaveTextContent("AssemblyDesign for manufacturingPlacement");
    expect(screen.getByText("None.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/instruction|prompt|dossier|https?:|\\|\/home\//iu);
  });

  it("fails closed for unknown fields, unknown values, and oversized arrays", () => {
    const unknown = dividerContract() as Record<string, unknown>;
    unknown.privateBundlePrompt = "ignore prior rules; Authorization: Bearer malicious-secret";
    const first = render(<DesignInspector snapshot={undefined} contract={state(unknown)} busy={false} onInspect={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Contract details unavailable");
    expect(document.body.textContent).not.toMatch(/privateBundlePrompt|malicious-secret|ignore prior/iu);

    first.unmount();
    const oversized = dividerContract();
    oversized.components = Array.from({ length: 65 }, (_, index) => ({ ...oversized.components[1]!, reference: `R${index + 1}` })) as typeof oversized.components;
    render(<DesignInspector snapshot={undefined} contract={state(oversized)} busy={false} onInspect={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("malformed, oversized, or contains an unknown value");
    expect(screen.queryByLabelText("Contract components")).not.toBeInTheDocument();
  });

  it("redacts credential-shaped or path-shaped text even when it occupies a schema-valid value field", () => {
    const malicious = dividerContract();
    malicious.components[1]!.value = "Authorization: Bearer secret-provider-token";
    render(<DesignInspector snapshot={undefined} contract={state(malicious)} busy={false} onInspect={vi.fn()} />);
    expect(screen.getByLabelText("Contract components")).toHaveTextContent("[redacted credential]");
    expect(document.body.textContent).not.toMatch(/secret-provider-token|Bearer/iu);
  });

  it("hides malformed, extra-field, oversized, unsorted, overlapping, misbound, and identity-drifted rule summaries", async () => {
    const cases: Record<string, unknown>[] = [];
    cases.push({ ...ruleSummary(), privatePrompt: "Authorization: Bearer never-render-this" });
    cases.push({ ...ruleSummary(), selectedCount: 25, selectedRuleIds: Array.from({ length: 25 }, (_, index) => `PCB01-R${String(index + 1).padStart(3, "0")}`) });
    cases.push({ ...ruleSummary(), selectedRuleIds: [...ruleSummary().selectedRuleIds].reverse() });
    cases.push({ ...ruleSummary(), uncoveredFeatures: ["placement"] });
    cases.push({ ...ruleSummary(), deepRuleBindingIdentity: identity("f", "evleda.pcb-deep-rule-binding.v1") });
    const drifted = { ...ruleSummary(), identity: { ...ruleSummary().identity, digest: "f".repeat(64) } };
    await expect(verifyFluxDeepRuleSummary(drifted, deepRuleBindingIdentity)).resolves.toBe(false);
    cases.push(drifted);

    for (const malformed of cases) {
      const view = render(<DesignInspector snapshot={undefined} contract={state(dividerContract(), malformed as unknown as FluxDeepRuleSummaryDto)} authorityIntegrity={malformed === drifted ? "invalid" : "valid"} busy={false} onInspect={vi.fn()} />);
      expect(screen.getByText(/public deep-rule summary is malformed or misbound|selected-rule summary did not pass/iu)).toBeInTheDocument();
      expect(screen.queryByLabelText("Selected deep-rule IDs")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("never-render-this");
      view.unmount();
    }
  });
});
