import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FRESH_ACCEPTANCE_RIGHT_ANGLE_CLASSIFICATION_TOLERANCE_DEG,
  evaluateLedIndicatorAcceptance,
  type LedIndicatorAcceptanceEvidence,
} from "../../src/harness/fresh-acceptance.js";
import {
  LED_INDICATOR_EXAMPLE,
  renderFreshLedIndicatorProviderContract,
} from "../../src/harness/fresh-project.js";
import { computePcbAgentHarnessRuleIdentity } from "../../src/cli/pcb-agent.js";

const symbol = (reference: string, libId: string, value: string, footprint: string) => `
  (symbol (lib_id "${libId}") (at 20 20 0)
    (property "Reference" "${reference}")
    (property "Value" "${value}")
    (property "Footprint" "${footprint}"))`;

const SCHEMATIC = `(kicad_sch
  (version 20250316)
  (generator "fresh-acceptance-fixture")
  ${symbol("J1", "Connector_Generic:Conn_01x02", "Conn_01x02", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical")}
  ${symbol("R1", "Device:R", "1k", "Resistor_SMD:R_0603_1608Metric")}
  ${symbol("D1", "Device:LED", "LED", "LED_SMD:LED_0603_1608Metric")}
  ${symbol("C1", "Device:C", "100nF", "Capacitor_SMD:C_0603_1608Metric")}
)
`;

const footprint = (
  reference: string, libraryId: string, value: string, x: number, y: number,
  pads: readonly [number, number, string, number][],
) => `
  (footprint "${libraryId}" (layer "F.Cu") (at ${x} ${y} 0)
    (property "Reference" "${reference}") (property "Value" "${value}")
    (fp_rect (start -1.25 -2.75) (end 1.25 2.75) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (fp_rect (start -1 -2.5) (end 1 2.5) (stroke (width 0.05) (type default)) (fill none) (layer "F.Fab"))
    ${pads.map(([px, py, net, ordinal], index) => `(pad "${index + 1}" smd rect (at ${px} ${py}) (size 1 1) (layers "F.Cu") (net ${ordinal} "${net}"))`).join("\n    ")}
  )`;

const PCB = `(kicad_pcb
  (version 20250316)
  (generator "fresh-acceptance-fixture")
  (general)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 1 "+5V") (net 2 "GND") (net 3 "LED_A")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  ${footprint("J1", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "Conn_01x02", 1.5, 10, [[0, -2, "+5V", 1], [0, 2, "GND", 2]])}
  ${footprint("C1", "Capacitor_SMD:C_0603_1608Metric", "100nF", 7, 10, [[0, -2, "+5V", 1], [0, 2, "GND", 2]])}
  ${footprint("R1", "Resistor_SMD:R_0603_1608Metric", "1k", 13, 8, [[-1, 0, "+5V", 1], [1, 0, "LED_A", 3]])}
  ${footprint("D1", "LED_SMD:LED_0603_1608Metric", "LED", 13, 12, [[-1, 0, "GND", 2], [1, 0, "LED_A", 3]])}
  (segment (start 1.5 8) (end 7 8) (width 0.5) (layer "F.Cu") (net 1) (uuid "pwr-a"))
  (segment (start 7 8) (end 12 8) (width 0.5) (layer "F.Cu") (net 1) (uuid "pwr-b"))
  (segment (start 1.5 12) (end 7 12) (width 0.5) (layer "F.Cu") (net 2) (uuid "gnd-a"))
  (segment (start 7 12) (end 12 12) (width 0.5) (layer "F.Cu") (net 2) (uuid "gnd-b"))
  (segment (start 14 8) (end 14 12) (width 0.5) (layer "F.Cu") (net 3) (uuid "led-a"))
)
`;

const connectivity = { toolCallId: "connectivity", content: JSON.stringify({ result: [
  "Connectivity groups (3 total):",
  "- Group 1: +5V | pins=J1:1, R1:1, C1:1 | points=3",
  "- Group 2: LED_A | pins=R1:2, D1:2 | points=2",
  "- Group 3: GND | pins=J1:2, D1:1, C1:2 | points=3",
].join("\n") }) };
const erc = { toolCallId: "erc", content: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violation_count: 0 } }) };
const drc = { toolCallId: "drc", content: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } }) };
const visualInspection = { toolCallId: "visual", content: JSON.stringify({ status: "PASS", findings: [], footprint_count: 4 }) };

const evidence = (overrides: Partial<LedIndicatorAcceptanceEvidence> = {}): LedIndicatorAcceptanceEvidence => ({
  schematicSource: SCHEMATIC, pcbSource: PCB, schematicPath: "positive.kicad_sch", pcbPath: "positive.kicad_pcb",
  connectivity, erc, drc, visualInspection, ...overrides,
});

const expectRejectedBy = (input: LedIndicatorAcceptanceEvidence, ...ids: string[]) => {
  const result = evaluateLedIndicatorAcceptance(input);
  expect(result.passed).toBe(false);
  for (const id of ids) expect(result.missing, `feedback must name ${id}`).toContainEqual(expect.stringMatching(new RegExp(`^${id} \\[(?:fail|unknown)\\]:`)));
  return result;
};

describe("closed fresh LED acceptance", () => {
  it("keeps analyzer classification and hairpin-policy tolerances named or contract-bound", () => {
    expect(FRESH_ACCEPTANCE_RIGHT_ANGLE_CLASSIFICATION_TOLERANCE_DEG).toBe(0.01);
    expect(LED_INDICATOR_EXAMPLE.routing.forbiddenGeometryDetection).toEqual({
      reversalMaximumInteriorAngleDeg: 0.01,
      hairpin: {
        parallelToleranceDeg: 0.01, maximumLegEdgeGapMm: 0.01,
        minimumParallelOverlapMm: 0.01, maximumConnectorPathLengthMm: 0.01,
      },
    });
    const source = readFileSync(new URL("../../src/harness/fresh-acceptance.ts", import.meta.url), "utf8");
    const analyzerProfileSource = /function analyzerProfile[\s\S]*?\n\}\n\ninterface Check/u.exec(source)?.[0] ?? "";
    expect(analyzerProfileSource).not.toBe("");
    expect(analyzerProfileSource).not.toMatch(/:\s*0\.01\b/u);
  });

  it("completes only when every mandatory row is PASS and freezes both source hashes", () => {
    const result = evaluateLedIndicatorAcceptance(evidence());
    expect(result.passed, result.missing.join("\n")).toBe(true);
    expect(result.requirements.filter((row) => row.id !== "gnd-zone").every((row) => row.status === "pass")).toBe(true);
    expect(result.sourceHashes).toEqual({
      schematicSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), pcbSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.requirements.find((row) => row.id === "gnd-zone")).toMatchObject({ status: "pass", detail: expect.stringContaining("absent") });
  });

  it("rejects the canary-5 J1-only source and an empty fresh project without passing unsupported evidence", () => {
    const j1Only = `(kicad_sch (version 20250316) ${symbol("J1", "Connector_Generic:Conn_01x02", "Conn_01x02", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical")})`;
    expectRejectedBy(evidence({ schematicSource: j1Only }), "symbols");
    const empty = evaluateLedIndicatorAcceptance(evidence({ schematicSource: `(kicad_sch (version 20250316))`, pcbSource: `(kicad_pcb (version 20250316))`, connectivity: "" }));
    expect(empty.passed).toBe(false);
    expect(empty.requirements.some((row) => row.status === "unknown")).toBe(true);
    expect(empty.missing).toEqual(expect.arrayContaining([
      expect.stringMatching(/^symbols \[fail\]:/u), expect.stringMatching(/^schematic-nets \[unknown\]:/u), expect.stringMatching(/^outline \[unknown\]:/u),
    ]));
  });

  it("names exact identity and schematic connectivity failures", () => {
    expectRejectedBy(evidence({ schematicSource: SCHEMATIC.replace("100nF", "10nF") }), "symbols");
    expectRejectedBy(evidence({ schematicSource: SCHEMATIC.replace("LED_SMD:LED_0603_1608Metric", "LED_SMD:LED_0805_2012Metric") }), "symbols");
    expectRejectedBy(evidence({ connectivity: { ...connectivity, content: connectivity.content.replace("D1:2", "D1:1") } }), "schematic-nets");
    expectRejectedBy(evidence({ schematicSource: SCHEMATIC.replace(/\)\s*$/u, "  (no_connect (at 20 20))\n)\n") }), "no-connect");
  });

  it("names PCB sync, outline, and connector edge/orientation failures", () => {
    expectRejectedBy(evidence({ pcbSource: PCB.replace("LED_SMD:LED_0603_1608Metric", "LED_SMD:LED_0805_2012Metric") }), "pcb-sync-footprints");
    expectRejectedBy(evidence({ pcbSource: PCB.replace('(property "Reference" "R1") (property "Value" "1k")', '(property "Reference" "R1") (property "Value" "10k")') }), "pcb-sync-footprints");
    expectRejectedBy(evidence({ pcbSource: PCB.replace("(end 30 20)", "(end 31 20)") }), "outline");
    expectRejectedBy(evidence({ pcbSource: PCB.replace('(at 1.5 10 0)', '(at 5 10 90)') }), "j1-edge-orientation");
  });

  it("names electrical routing, minimum width, turn, reversal/overlap, and via failures", () => {
    expectRejectedBy(evidence({ pcbSource: PCB.replace('(end 12 8) (width 0.5)', '(end 11 8) (width 0.5)') }), "routed-connectivity");
    expectRejectedBy(evidence({ pcbSource: PCB.replace('(width 0.5)', '(width 0.49)') }), "trace-width");
    const rightAngle = PCB.replace('(segment (start 7 8) (end 12 8)', '(segment (start 7 8) (end 7 13)').replace('(pad "1" smd rect (at -1 0)', '(pad "1" smd rect (at -6 5)');
    expectRejectedBy(evidence({ pcbSource: rightAngle }), "track-turns");
    const reversal = PCB.replace('(segment (start 7 8) (end 12 8)', '(segment (start 7 8) (end 6 8)').replace('(pad "1" smd rect (at -1 0)', '(pad "1" smd rect (at -7 0)');
    expectRejectedBy(evidence({ pcbSource: reversal }), "track-turns");
    const overlap = PCB.replace('(segment (start 7 8) (end 12 8)', '(segment (start 6 8) (end 12 8)');
    expectRejectedBy(evidence({ pcbSource: overlap }), "track-turns");
    expectRejectedBy(evidence({ pcbSource: PCB.replace(/\)\s*$/u, '  (via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))\n)\n') }), "vias");
  });

  it("names explicit ERC, DRC, and visual/practice failures and leaves malformed evidence unknown", () => {
    expectRejectedBy(evidence({ erc: { ...erc, content: erc.content.replace('"violation_count":0', '"violation_count":1') } }), "erc");
    expectRejectedBy(evidence({ drc: { ...drc, content: drc.content.replace('"violations":0', '"violations":1') } }), "drc");
    expectRejectedBy(evidence({ visualInspection: { ...visualInspection, content: JSON.stringify({ status: "PASS" }) } }), "visual-practice");
    const malformed = expectRejectedBy(evidence({ erc: "clean", drc: "clean" }), "erc", "drc");
    expect(malformed.requirements.filter((row) => row.id === "erc" || row.id === "drc").every((row) => row.status === "unknown")).toBe(true);
  });

  it("binds a changed validated contract to prompt text, evaluator thresholds, and harness identity together", () => {
    const changed = structuredClone(LED_INDICATOR_EXAMPLE);
    changed.board.widthMm = 31;
    changed.schematic.noConnectMarkers = 1;
    changed.placement.connector.maximumEdgeClearanceMm = 0.1;
    changed.routing.minimumWidthMm = 0.6;
    changed.zones.ground.policy = "required";
    changed.acceptance.mandatoryRows.push("gnd-zone");

    const baselinePrompt = renderFreshLedIndicatorProviderContract();
    const changedPrompt = renderFreshLedIndicatorProviderContract(changed);
    expect(changedPrompt).not.toBe(baselinePrompt);
    expect(changedPrompt).toContain('"widthMm": 31');
    expect(changedPrompt).toContain('"minimumWidthMm": 0.6');
    expect(changedPrompt).toContain('"policy": "required"');
    expect(computePcbAgentHarnessRuleIdentity(changedPrompt)).not.toBe(computePcbAgentHarnessRuleIdentity(baselinePrompt));

    const baseline = evaluateLedIndicatorAcceptance(evidence());
    const drifted = evaluateLedIndicatorAcceptance(evidence(), changed);
    expect(baseline.passed, baseline.missing.join("\n")).toBe(true);
    for (const id of ["no-connect", "outline", "j1-edge-orientation", "trace-width", "gnd-zone"] as const) {
      expect(drifted.requirements.find((row) => row.id === id)?.status, `${id} must follow the changed contract`).toBe("fail");
      expect(drifted.missing).toContainEqual(expect.stringMatching(new RegExp(`^${id} \\[fail\\]:`)));
    }
  });
});
