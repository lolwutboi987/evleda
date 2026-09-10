import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical.js";
import { parsePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import {
  PCB_DESIGN_INTENT_MODEL_GUIDE,
  PCB_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES,
  PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION,
  PCB_DESIGN_INTENT_VALID_EXAMPLE,
} from "../../src/harness/pcb-design-intent-model-guide.js";

const GUIDE_BYTES = 7_368;
const GUIDE_SHA256 = "0704be1e93772544484740a3182a8cac3871d0cc683624b8a083cd5a7f1604a4";
const EXAMPLE_CANONICAL_BYTES = 1_651;
const EXAMPLE_CANONICAL_SHA256 = "3194410ca3fc439744972b79449ecb9af04bc7bcf5931d92ab412f672912fa3b";
const MACHINE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|var|tmp)\/)/u;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const expectExactKeys = (value: object, expected: readonly string[]): void => {
  expect(Reflect.ownKeys(value)).toEqual(expected);
};

const expectDeepFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
};

describe("PCB design-intent model guide", () => {
  it("pins the bounded, versioned, path-free guide bytes", () => {
    expect(PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION).toBe("evleda.pcb-design-intent-model-guide.v2");
    expect(PCB_DESIGN_INTENT_MODEL_GUIDE).toContain(PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION);
    expect(Buffer.byteLength(PCB_DESIGN_INTENT_MODEL_GUIDE, "utf8")).toBe(GUIDE_BYTES);
    expect(Buffer.byteLength(PCB_DESIGN_INTENT_MODEL_GUIDE, "utf8"))
      .toBeLessThanOrEqual(PCB_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES);
    expect(sha256(PCB_DESIGN_INTENT_MODEL_GUIDE)).toBe(GUIDE_SHA256);
    expect(PCB_DESIGN_INTENT_MODEL_GUIDE).not.toMatch(MACHINE_PATH);
  });

  it("covers every required shape and the parser-only semantic invariants", () => {
    const requiredGuidance = [
      "Every property required by the selected object or union branch must be present",
      "keys that belong only to an unselected branch must be absent",
      "Nullable means the key must be present with null",
      "Required root keys: schemaVersion, kind, scope, components, nets, netClasses, placementConstraints, routingConstraints, unresolved",
      "copperLayers is always exactly [\"F.Cu\",\"B.Cu\"] once each",
      "the rectangle runs from (0,0) to (widthMm,heightMm)",
      "every placement anchor and region uses those same coordinates",
      "V1 has no outline-origin field",
      "Use electrical:null rather than inventing",
      "Connectivity is bidirectionally exact",
      "every net-assigned pin must occur exactly once",
      "netClasses[].allowedLayers=[\"F.Cu\"]",
      "regionMm={minXmm:x,maxXmm:x,minYmm:y,maxYmm:y}",
      "edgePreference selects the nearest courtyard edge, not the nearest footprint-reference anchor",
      "the selected edge must have the minimum clearance",
      "existing 0.0001 mm coordinate comparison tolerance",
      "preserve the supplied values and flag the conflict in unresolved",
      "Do not move the connector, shift the outline origin",
      "the host must check the bound library geometry before execution",
      "cornerStyle=\"miter_45\"",
      "topology=\"point_to_point\" only for exactly two endpoints",
      "topology=\"tree\" requires at least two endpoints",
      "Ready-only closure invariants",
      "every component has exactly one placement constraint",
      "every net has exactly one routing constraint",
      "every declared net class is used by at least one net",
      "every net has at least two unique endpoints",
      "viaPolicy={mode:\"forbidden\",maxTotal:0}",
      "Keep nullable unknowns as null",
      "Use unresolved only for an additional named ambiguity",
      "never use a numeric array index or a compiler dot path",
      "Do not add fields for hairpins, cycles, disconnected islands, free-space tees",
      "strict draft objects reject extra keys",
    ];
    for (const guidance of requiredGuidance) {
      expect(PCB_DESIGN_INTENT_MODEL_GUIDE).toContain(guidance);
    }
  });

  it("exports one complete, deeply frozen example with every strict key", () => {
    const example = PCB_DESIGN_INTENT_VALID_EXAMPLE;
    expectExactKeys(example, [
      "schemaVersion", "kind", "scope", "components", "nets", "netClasses",
      "placementConstraints", "routingConstraints", "unresolved",
    ]);
    expectExactKeys(example.scope, ["sheetCount", "componentUnitPolicy", "board"]);
    expectExactKeys(example.scope.board, ["shape", "widthMm", "heightMm", "layerCount", "copperLayers"]);
    for (const component of example.components) {
      expectExactKeys(component, ["reference", "symbolLibId", "value", "footprintLibId", "unit", "pins"]);
      for (const pin of component.pins) expectExactKeys(pin, ["pin", "assignment"]);
    }
    for (const net of example.nets) {
      expectExactKeys(net, ["name", "role", "endpoints", "electrical", "netClassId"]);
      for (const endpoint of net.endpoints) expectExactKeys(endpoint, ["reference", "pin"]);
    }
    for (const netClass of example.netClasses) {
      expectExactKeys(netClass, ["id", "traceWidthMm", "clearanceMm", "copperToEdgeMm", "allowedLayers"]);
    }
    for (const placement of example.placementConstraints) {
      expectExactKeys(placement, [
        "reference", "side", "regionMm", "allowedRotationsDeg", "minimumEdgeClearanceMm",
        "minimumCourtyardClearanceMm", "edgePreference",
      ]);
      expectExactKeys(placement.regionMm!, ["minXmm", "maxXmm", "minYmm", "maxYmm"]);
    }
    expectExactKeys(example.routingConstraints, [
      "cornerStyle", "maximumTurnAngleDeg", "minimumStraightBeforeTurnMm", "allowRightAngleCorners",
      "allowAcuteInteriorCorners", "allowBacktracking", "allowSelfIntersections", "viaPolicy", "nets",
    ]);
    for (const route of example.routingConstraints.nets) {
      expectExactKeys(route, ["net", "topology", "preferredLayer", "maxVias", "routeLength"]);
    }
    for (const unresolved of example.unresolved) expectExactKeys(unresolved, ["path", "question"]);
    expectDeepFrozen(example);
  });

  it("is parser-valid, canonical, neutral, and demonstrates the intended encodings", () => {
    const example = PCB_DESIGN_INTENT_VALID_EXAMPLE;
    expect(parsePcbDesignIntentDraft(example)).toEqual(example);

    const canonical = canonicalJson(example);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(EXAMPLE_CANONICAL_BYTES);
    expect(sha256(canonical)).toBe(EXAMPLE_CANONICAL_SHA256);
    expect(canonical).not.toMatch(MACHINE_PATH);

    expect(example.scope.board).toMatchObject({
      widthMm: null,
      heightMm: null,
      copperLayers: ["F.Cu", "B.Cu"],
    });
    expect(example.components.every((component) =>
      component.symbolLibId === null && component.value === null && component.footprintLibId === null)).toBe(true);
    expect(example.nets.every((net) => net.electrical === null)).toBe(true);

    const net = example.nets[0]!;
    const endpointKeys = new Set(net.endpoints.map((endpoint) => `${endpoint.reference}.${endpoint.pin}`));
    for (const component of example.components) for (const pin of component.pins) {
      expect(pin.assignment).toEqual({ kind: "net", net: net.name });
      expect(endpointKeys.has(`${component.reference}.${pin.pin}`)).toBe(true);
    }

    for (const placement of example.placementConstraints) {
      expect(placement.regionMm?.minXmm).toBe(placement.regionMm?.maxXmm);
      expect(placement.regionMm?.minYmm).toBe(placement.regionMm?.maxYmm);
    }
    expect(example.netClasses[0]?.allowedLayers).toEqual(["F.Cu"]);
    expect(example.routingConstraints).toMatchObject({
      cornerStyle: "miter_45",
      maximumTurnAngleDeg: 45,
      allowRightAngleCorners: false,
      allowAcuteInteriorCorners: false,
      allowBacktracking: false,
      allowSelfIntersections: false,
      viaPolicy: { mode: "forbidden", maxTotal: 0 },
      nets: [{ net: "N1", topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 0 }],
    });
    expect(net.endpoints).toHaveLength(2);
    expect(example.unresolved).toEqual([]);
    expect(example.unresolved.some((entry) => /\/(?:0|[1-9][0-9]*)(?:\/|$)/u.test(entry.path))).toBe(false);
    expect(canonical).not.toMatch(/"(?:hairpins|cycles|disconnectedIslands|freeSpaceTees|save|validate|fabricate|export|order)"/u);
  });
});
