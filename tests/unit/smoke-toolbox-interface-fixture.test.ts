import { describe, expect, it } from "vitest";
import {
  assertInterfaceGeometry,
  assertInterfacePads,
  assessInterfaceFixtureRoutes,
  exactFixtureNm,
  interfaceFixtureDraft,
  interfaceFixtureRoutes,
  INTERFACE_FIXTURE_FOOTPRINT,
  INTERFACE_FIXTURE_ID,
  INTERFACE_FIXTURE_SOURCE_SYMBOL,
  INTERFACE_FIXTURE_RECEIVER_SYMBOL,
} from "../../scripts/smoke-toolbox-interface-fixture.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compareDifferentialPairLengths } from "../../src/harness/differential-pair-geometry.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import capturedNativePads from "../fixtures/native-interface-pad-positions-20260910-03.json" with { type: "json" };

/** Hand-declared public rows for offline tests; these are not observations from KiCad. */
const mockPublicPads = () => {
  const rows = [
    ["J1", "1", "DP", 4.125, 9], ["J1", "2", "DN", 5.875, 10], ["J1", "3", "GND", 4.125, 11],
    ["J2", "1", "DP", 24.125, 9], ["J2", "2", "DN", 25.875, 10], ["J2", "3", "GND", 24.125, 11],
  ] as const;
  return {
    schemaVersion: "evleda.fresh-plane-pad-positions.v1",
    status: "complete-selection",
    boardCounts: {
      physicalPadCount: 6, logicalTerminalCount: 6, numberedCopperPrimitiveCount: 6,
      namedCopperPrimitiveCount: 6, logicalNamedTerminalCount: 6,
      noConnectCopperPrimitiveCount: 0, logicalNoConnectTerminalCount: 0,
      nonElectricalFeatureCount: 0, platedFootprintHoleCount: 0,
    },
    terminals: rows.map(([reference, pad, net]) => ({ reference, pad, net })),
    pads: rows.map(([reference, pad, net, xMm, yMm]) => ({
      reference: String(reference), pad: String(pad), net: String(net), xMm: Number(xMm), yMm: Number(yMm),
      layers: ["F.Cu"],
      physical: {
        id: `mock-${reference}-${pad}`, footprintId: `mock-${reference}`, padType: "smd", shape: "rect",
        drill: null, sizeMm: { x: 1.75, y: 0.6 },
      },
    })),
  };
};
type MockPublicPads = ReturnType<typeof mockPublicPads>;

/** Mock only: declares the three stock pin/pad numbers without reading native libraries. */
const mockThreePadStockResolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: libraryId => ![INTERFACE_FIXTURE_SOURCE_SYMBOL, INTERFACE_FIXTURE_RECEIVER_SYMBOL].includes(libraryId) ? null : {
    libraryId, source: "kicad-stock", unitCount: 1, componentKind: "connector", polarized: false,
    pins: ["1", "2", "3"].map(number => ({ number, function: `Pin ${number}` })),
  },
  resolveFootprint: libraryId => libraryId !== INTERFACE_FIXTURE_FOOTPRINT ? null : {
    libraryId, source: "kicad-stock", packageKind: "generic", pads: ["1", "2", "3"],
  },
};

describe("offline interface fixture endpoint gate", () => {
  it("accepts the real native03 usable-copper projection before placement", () => {
    expect(() => assertInterfacePads(capturedNativePads, false)).not.toThrow();
    expect(capturedNativePads.pads.every(pad => pad.layers.length === 1 && pad.layers[0] === "F.Cu")).toBe(true);
    expect(() => assertInterfacePads(capturedNativePads, true)).toThrow(/Unexpected actual pad position/);
  });
  it("accepts exact integer nanometres without treating floating multiplication residue as a tolerance", () => {
    expect(exactFixtureNm(4.125)).toBe(4_125_000);
    expect(exactFixtureNm(8.15)).toBe(8_150_000);
    expect(exactFixtureNm(0.000001)).toBe(1);
    expect(exactFixtureNm(2_000)).toBe(2_000_000_000);
  });

  it.each([NaN, Infinity, -Infinity, -0, 0.0000004, 4.1250004, 2_000.000001])(
    "rejects noncanonical or out-of-range coordinate %s", value => {
      expect(() => exactFixtureNm(value)).toThrow();
    },
  );

  it("accepts the complete hand-declared stock pad inventory in any row order", () => {
    const value = mockPublicPads();
    value.pads.reverse();
    value.terminals.reverse();
    for (const pad of value.pads) pad.layers.reverse();
    expect(() => assertInterfacePads(value, true)).not.toThrow();
  });

  it.each<[string, (value: MockPublicPads) => void]>([
    ["one-nanometre shift", value => { value.pads[0]!.xMm = 4.125001; }],
    ["swapped endpoint positions", value => {
      const first = value.pads[0]!, second = value.pads[1]!;
      [first.xMm, first.yMm, second.xMm, second.yMm] = [second.xMm, second.yMm, first.xMm, first.yMm];
    }],
    ["sub-nanometre row", value => { value.pads[0]!.xMm = 4.1250004; }],
    ["swapped signal net", value => { value.pads[0]!.net = "DN"; }],
    ["duplicate logical endpoint", value => { value.pads[1] = structuredClone(value.pads[0]!); }],
    ["missing physical pad", value => { value.pads.pop(); }],
    ["missing logical terminal", value => { value.terminals.pop(); }],
    ["extra hidden physical pad", value => { value.boardCounts.physicalPadCount = 7; }],
    ["unexpected plated footprint hole", value => { value.boardCounts.platedFootprintHoleCount = 1; }],
    ["back copper layer", value => { value.pads[0]!.layers.push("B.Cu"); }],
    ["wrong pad dimensions", value => { value.pads[0]!.physical.sizeMm.x = 1.7; }],
  ])("rejects %s before deriving routes", (_label, mutate) => {
    const value = mockPublicPads();
    mutate(value);
    expect(() => assertInterfacePads(value, true)).toThrow();
    expect(() => interfaceFixtureRoutes(value)).toThrow();
  });

  it("allows different canonical positions only during the unplaced inventory check", () => {
    const value = mockPublicPads();
    value.pads[0]!.xMm = 1;
    expect(() => assertInterfacePads(value, false)).not.toThrow();
    expect(() => interfaceFixtureRoutes(value)).toThrow(/Unexpected actual pad position/);
    value.pads[0]!.xMm = 1.0000004;
    expect(() => assertInterfacePads(value, false)).toThrow(/integer nanometres/);
  });
});

describe("offline interface fixture route geometry", () => {
  it("connects the exact pad centers and has equal etch lengths, zero skew and one central paired span", () => {
    const value = mockPublicPads();
    const routes = interfaceFixtureRoutes(value);
    expect(routes.map(route => route.net)).toEqual(["DP", "DN", "GND"]);
    expect(routes[0]!.tracks[0]).toMatchObject({ x1Mm: 4.125, y1Mm: 9 });
    expect(routes[0]!.tracks.at(-1)).toMatchObject({ x2Mm: 24.125, y2Mm: 9 });
    expect(routes[1]!.tracks[0]).toMatchObject({ x1Mm: 5.875, y1Mm: 10 });
    expect(routes[1]!.tracks.at(-1)).toMatchObject({ x2Mm: 25.875, y2Mm: 10 });
    expect(routes[2]!.vias).toEqual([{ xMm: 4.125, yMm: 12.5 }, { xMm: 24.125, yMm: 12.5 }]);

    const result = assessInterfaceFixtureRoutes(value.pads, routes);
    expect(() => assertInterfaceGeometry(result)).not.toThrow();
    expect(result).toMatchObject({ authority: "caller_supplied_source_geometry_only", accepted: false, inventoryComplete: true });
    expect(Object.values(result.checks).every(check => check.status === "pass")).toBe(true);
    expect(result.selected.tracks).toHaveLength(10);
    expect(result.selected.pads).toHaveLength(4);
    expect(result.selected.pads.every(pad => pad.layers.length === 1 && pad.layers[0] === "F.Cu")).toBe(true);
    expect(result.selected.vias).toEqual([]);
    expect(result.routes.positive.mainLength).toEqual({ twiceAxisNm: "39400000", twiceDiagonalNm: "600000" });
    expect(result.routes.negative.mainLength).toEqual(result.routes.positive.mainLength);
    expect(result.etchSkew).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "0" });
    expect(result.coupling!.paired).toHaveLength(1);
    expect(result.coupling!.paired[0]).toMatchObject({
      positiveStart: { xTwiceNm: "16300000", yTwiceNm: "18300000" },
      positiveEnd: { xTwiceNm: "43700000", yTwiceNm: "18300000" },
      negativeStart: { xTwiceNm: "16300000", yTwiceNm: "19700000" },
      negativeEnd: { xTwiceNm: "43700000", yTwiceNm: "19700000" },
      positiveMemberUuids: ["DP-track-2"], negativeMemberUuids: ["DN-track-2"],
      length: { twiceAxisNm: "27400000", twiceDiagonalNm: "0" },
    });
    const uncoupled = { twiceAxisNm: "12000000", twiceDiagonalNm: "600000" };
    expect(result.coupling!.positiveUncoupledLength).toEqual(uncoupled);
    expect(result.coupling!.negativeUncoupledLength).toEqual(uncoupled);
    expect(compareDifferentialPairLengths(uncoupled, { twiceAxisNm: "14000000", twiceDiagonalNm: "0" })).toBe(-1);
  });

  it("fails a changed source endpoint even when the inventory still has ten tracks", () => {
    const value = mockPublicPads();
    const routes = interfaceFixtureRoutes(value).map(route => ({ ...route, tracks: route.tracks.map(track => ({ ...track })) }));
    routes[0]!.tracks[0]!.x1Mm = 4.125001;
    const result = assessInterfaceFixtureRoutes(value.pads, routes);
    expect(result.selected.tracks).toHaveLength(10);
    expect(result.checks.topology.status).toBe("fail");
    expect(() => assertInterfaceGeometry(result)).toThrow();
  });

  it("fails only the uncoupled budget after shortening the central paired span on both routes", () => {
    const value = mockPublicPads();
    const routes = interfaceFixtureRoutes(value).map(route => ({ ...route, tracks: route.tracks.map(track => ({ ...track })) }));
    for (const route of routes.slice(0, 2)) {
      route.tracks[0]!.x2Mm = 9;
      Object.assign(route.tracks[1]!, { x1Mm: 9, x2Mm: 9.15 });
      Object.assign(route.tracks[2]!, { x1Mm: 9.15, x2Mm: 20.85 });
      Object.assign(route.tracks[3]!, { x1Mm: 20.85, x2Mm: 21 });
      route.tracks[4]!.x1Mm = 21;
    }
    const result = assessInterfaceFixtureRoutes(value.pads, routes);
    expect(result.routes.positive.mainLength).toEqual({ twiceAxisNm: "39400000", twiceDiagonalNm: "600000" });
    expect(result.routes.negative.mainLength).toEqual(result.routes.positive.mainLength);
    expect(result.etchSkew).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "0" });
    for (const [name, check] of Object.entries(result.checks)) {
      if (name !== "uncoupled") expect(check.status, name).toBe("pass");
    }
    expect(result.checks.uncoupled.status).toBe("fail");
    expect(result.coupling!.paired).toHaveLength(1);
    expect(result.coupling!.paired[0]!.length).toEqual({ twiceAxisNm: "23400000", twiceDiagonalNm: "0" });
    expect(result.coupling!.positiveUncoupledLength).toEqual({ twiceAxisNm: "16000000", twiceDiagonalNm: "600000" });
    expect(result.coupling!.negativeUncoupledLength).toEqual(result.coupling!.positiveUncoupledLength);
    expect(() => assertInterfaceGeometry(result)).toThrow(/uncoupled/);
  });
});

describe("offline interface fixture draft compilation with mocked stock libraries", () => {
  const deepRuleCatalog = loadDeepRuleCatalog();

  it("compiles all three pins and pads without native authoring or acceptance claims", () => {
    const draft = interfaceFixtureDraft();
    const result = compilePcbPlaneDesignIntentDraft(draft, { libraryResolver: mockThreePadStockResolver, deepRuleCatalog });
    expect(result.disposition, JSON.stringify(result.issues)).toBe("ready");
    if (result.disposition !== "ready") throw new Error("Offline fixture draft did not compile");
    expect(result).toMatchObject({ foundationOnly: true, nativeAuthoringPerformed: false, acceptanceEvaluated: false });
    expect(result.libraryBinding.footprints.map(binding => ({ reference: binding.reference, libraryId: binding.libraryId, pads: binding.pads }))).toEqual([
      { reference: "J1", libraryId: INTERFACE_FIXTURE_FOOTPRINT, pads: ["1", "2", "3"] },
      { reference: "J2", libraryId: INTERFACE_FIXTURE_FOOTPRINT, pads: ["1", "2", "3"] },
    ]);
    expect(result.contract.netClasses.find(netClass => netClass.id === "SIGNAL")).toMatchObject({ traceWidthMm: 0.4, clearanceMm: 0.25 });
    expect(result.contract.interfaceRequirements).toEqual(draft.interfaceRequirements);
    expect(result.contract.interfaceRequirements!.interfaces[0]).toMatchObject({
      id: INTERFACE_FIXTURE_ID, geometry: { maxUncoupledLengthMm: 7 }, source: { kind: "caller_assertion" },
    });
    expect(result.verificationPlan.acceptanceEvaluated).toBe(false);
    for (const kind of ["interface_topology", "interface_pair_geometry", "interface_termination", "interface_impedance", "interface_construction"]) {
      expect(result.verificationPlan.requirements).toContainEqual(expect.objectContaining({ kind, mandatory: true }));
    }
  });

  it("rejects a mocked footprint that omits the ground pad instead of accepting a two-pad substitute", () => {
    const libraryResolver: PcbReadOnlyLibraryResolver = {
      ...mockThreePadStockResolver,
      resolveFootprint: libraryId => {
        const resolved = mockThreePadStockResolver.resolveFootprint(libraryId);
        return resolved === null ? null : { ...resolved, pads: ["1", "2"] };
      },
    };
    const result = compilePcbPlaneDesignIntentDraft(interfaceFixtureDraft(), { libraryResolver, deepRuleCatalog });
    expect(result.disposition).not.toBe("ready");
    expect(result.contract).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.nativeAuthoringPerformed).toBe(false);
  });
});
