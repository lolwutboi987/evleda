import { describe, expect, it } from "vitest";

import {
  REFERENCE_PCB_FABRICATION_GEOMETRY_SCHEMA,
  ReferenceKicadBackendError,
  assertReferencePcbFabricationGeometry,
} from "../../src/integrations/reference-kicad-backend.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";

const MICROVIA_NETS = [
  "BOARD_ID0",
  "BOARD_ID0",
  "CAN_RX",
  "CAN_RX",
  "M1_DIR",
  "M1_DIR",
  "M1_FAULT",
  "M1_FAULT",
  "M2_DIR",
  "M2_DIR",
  "M2_FAULT",
] as const;

function validBoard(): Buffer {
  const microvias = MICROVIA_NETS.map((net, index) => [
    "  (via micro",
    `    (at ${30 + index} ${40 + index})`,
    "    (size 0.26)",
    "    (drill 0.1)",
    '    (layers "F.Cu" "In1.Cu")',
    `    (net "${net}")`,
    "  )",
  ].join("\n"));
  return Buffer.from([
    "(kicad_pcb",
    "  (general (thickness 1.6))",
    "  (layers",
    '    (0 "F.Cu" signal)',
    '    (4 "In1.Cu" signal)',
    '    (6 "In2.Cu" power)',
    '    (8 "In3.Cu" power)',
    '    (10 "In4.Cu" signal)',
    '    (2 "B.Cu" signal)',
    "  )",
    "  (setup",
    "    (stackup",
    '      (layer "F.Cu" (type "copper") (thickness 0.035))',
    '      (layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "FR-4") (epsilon_r 4.29) (loss_tangent 0.02))',
    '      (layer "In1.Cu" (type "copper") (thickness 0.035))',
    '      (layer "dielectric 2" (type "core") (thickness 0.54) (material "FR-4") (epsilon_r 3.96) (loss_tangent 0.02))',
    '      (layer "In2.Cu" (type "copper") (thickness 0.035))',
    '      (layer "dielectric 3" (type "prepreg") (thickness 0.11) (material "FR-4") (epsilon_r 4.29) (loss_tangent 0.02))',
    '      (layer "In3.Cu" (type "copper") (thickness 0.035))',
    '      (layer "dielectric 4" (type "core") (thickness 0.54) (material "FR-4") (epsilon_r 3.96) (loss_tangent 0.02))',
    '      (layer "In4.Cu" (type "copper") (thickness 0.035))',
    '      (layer "dielectric 5" (type "prepreg") (thickness 0.1) (material "FR-4") (epsilon_r 4.29) (loss_tangent 0.02))',
    '      (layer "B.Cu" (type "copper") (thickness 0.035))',
    "      (dielectric_constraints yes)",
    "    )",
    "  )",
    '  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net "TEST"))',
    '  (segment (start 2 2) (end 3 3) (width 0.2) (layer "In4.Cu") (net "TEST"))',
    '  (via (at 3 3) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net "TEST"))',
    ...microvias,
    '  (zone (net "GND") (layer "In2.Cu"))',
    '  (zone (net "+3V3") (layer "In3.Cu"))',
    ")",
    "",
  ].join("\n"), "utf8");
}

function validProject(): Buffer {
  return Buffer.from(JSON.stringify({
    board: {
      design_settings: {
        rules: {
          min_clearance: 0.18,
          min_copper_edge_clearance: 0.25,
          min_hole_clearance: 0.25,
          min_microvia_diameter: 0.26,
          min_microvia_drill: 0.1,
          min_track_width: 0.2,
          min_via_annular_width: 0.08,
          min_via_diameter: 0.45,
        },
      },
    },
  }), "utf8");
}

function validRules(): Buffer {
  return Buffer.from([
    "(version 1)",
    '(rule "Minimum copper clearance" (constraint clearance (min 0.18mm)))',
    '(rule "Minimum routed width" (constraint track_width (min 0.20mm)))',
    '(rule "Six-layer HDI via minimum" (constraint via_diameter (min 0.26mm)))',
    '(rule "Copper to board edge" (constraint edge_clearance (min 0.25mm)))',
    "",
  ].join("\n"), "utf8");
}

function expectGeometryFailure(
  board = validBoard(),
  project = validProject(),
  rules = validRules(),
): void {
  try {
    assertReferencePcbFabricationGeometry(board, project, rules, ROBOTICS_CONTROLLER_V0);
    throw new Error("Expected fabrication geometry rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ReferenceKicadBackendError);
    expect(error).toMatchObject({
      code: "GATE_FAILED",
      failureCode: "REFERENCE_FABRICATION_GEOMETRY_FAILED",
    });
  }
}

describe("reference PCB fabrication geometry", () => {
  it("accepts only the exact six-layer planes, stackup, rules, and HDI topology", () => {
    const result = assertReferencePcbFabricationGeometry(
      validBoard(),
      validProject(),
      validRules(),
      ROBOTICS_CONTROLLER_V0,
    );

    expect(result).toMatchObject({
      schemaVersion: REFERENCE_PCB_FABRICATION_GEOMETRY_SCHEMA,
      boardThicknessMm: 1.6,
      signalTrackCounts: { "F.Cu": 1, "In1.Cu": 0, "In4.Cu": 1, "B.Cu": 0 },
      vias: {
        throughViaCount: 1,
        microviaCount: 11,
        diameterMm: 0.26,
        drillMm: 0.1,
        minimumAnnularWidthMm: 0.08,
      },
    });
  });

  it.each([
    {
      name: "undersized microvia",
      board: () => Buffer.from(validBoard().toString("utf8").replace("(size 0.26)", "(size 0.25)")),
    },
    {
      name: "signal track on the ground plane",
      board: () => Buffer.from(validBoard().toString("utf8").replace('(layer "F.Cu") (net "TEST")', '(layer "In2.Cu") (net "TEST")')),
    },
    {
      name: "wrong power-plane net",
      board: () => Buffer.from(validBoard().toString("utf8").replace('(zone (net "+3V3") (layer "In3.Cu"))', '(zone (net "VM") (layer "In3.Cu"))')),
    },
    {
      name: "outer dielectric above the bound stackup",
      board: () => Buffer.from(validBoard().toString("utf8").replace('(thickness 0.1) (material "FR-4")', '(thickness 0.11) (material "FR-4")')),
    },
    {
      name: "blind ordinary via",
      board: () => Buffer.from(validBoard().toString("utf8").replace('(layers "F.Cu" "B.Cu") (net "TEST")', '(layers "F.Cu" "In1.Cu") (net "TEST")')),
    },
  ])("rejects $name", ({ board }) => {
    expectGeometryFailure(board());
  });

  it("rejects a project that weakens the independently checked microvia minimum", () => {
    const project = JSON.parse(validProject().toString("utf8")) as {
      board: { design_settings: { rules: Record<string, number> } };
    };
    project.board.design_settings.rules.min_microvia_diameter = 0.2;
    expectGeometryFailure(validBoard(), Buffer.from(JSON.stringify(project)));
  });

  it("rejects custom rules that omit the 0.26 mm HDI via constraint", () => {
    expectGeometryFailure(
      validBoard(),
      validProject(),
      Buffer.from(validRules().toString("utf8").replace("0.26mm", "0.25mm")),
    );
  });
});
