import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract, FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, type FreshConnectivityContractSource } from "../../src/harness/fresh-connectivity-contract.js";
import { closePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignContract, PCB_PLANE_CONTRACT_SCHEMA_VERSION } from "../../src/harness/pcb-design-plane-contract.js";
import { LED_INDICATOR_EXAMPLE } from "../../src/harness/fresh-project.js";
import * as freshProject from "../../src/harness/fresh-project.js";
import { genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const v1WithNoConnect = () => {
  const draft = genericDividerDraft();
  draft.components[0]!.pins.push({ pin: "MP", assignment: { kind: "no_connect" } });
  return closePcbDesignIntentDraft(draft);
};
const planeWithAdditionalPins = () => {
  const draft = planeDividerDraft();
  draft.components.push({ ...draft.components[1]!, reference: "R3", pins: [
    { pin: "1", assignment: { kind: "net", net: "GND" } }, { pin: "2", assignment: { kind: "no_connect" } },
  ] });
  draft.nets.find((net) => net.name === "GND")!.endpoints.push({ reference: "R3", pin: "1" });
  draft.placementConstraints.push({ ...draft.placementConstraints[1]!, reference: "R3" });
  return closePcbPlaneDesignIntentDraft(draft);
};
const mutablePlane = (): Record<string, any> => structuredClone(planeWithAdditionalPins());
const refreshIdentity = (value: Record<string, any>): void => {
  const { identity: _identity, ...payload } = value;
  value.identity = canonicalIdentity(payload, PCB_PLANE_CONTRACT_SCHEMA_VERSION);
};
const projectGraph = (value: ReturnType<typeof createFreshConnectivityContract>) => ({ components: value.components, nets: value.nets, noConnects: value.noConnects });

describe("exact legacy schematic connectivity regressions", () => {
  // Captured from the unchanged implementation before V2 support was added.
  it.each([
    { name: "LED", source: () => LED_INDICATOR_EXAMPLE, size: 1349, raw: "b260aa8f39a479b2eff3aef4460231541ec9052f69e369d4b011362dfa4c2798", canonical: "dbbd2505311618cbb222c9a9a4e87cefc84e0abcd63b1f96d744d36d5c31f726", identity: "cf2a3c85767ce0bc2bd4cbac931f4fb37603c40bc0176b45223bc6bf698ce038" },
    { name: "V1", source: () => closePcbDesignIntentDraft(genericDividerDraft()), size: 1201, raw: "0d2e74abf8ff02575953df19135024acdb87752efa00b891b45485a448d29e39", canonical: "389d321c3aa49f33b8ea33cde546246c1101e38f3c5ca295abc946bf7479dfbf", identity: "84347456e2bb138049656131d8ba72a0660f0bd7c8e91e91db15a22a2d15cb64" },
    { name: "V1 with no-connect", source: v1WithNoConnect, size: 1230, raw: "7e4432195aed133036f44eb005864055e047f706528b234bc99fd05d816a9a37", canonical: "e13d6d8ce5559399969b382bb2f6051e13431ea35277413a89dd5964b36e28c5", identity: "34006d11cc1ef9c8ad30a3e9ea579e9b689e77d7f20a2d47c56de3cba51750ee" },
  ])("preserves exact output bytes and semantic identity for $name", ({ source, size, raw, canonical, identity }) => {
    const result = createFreshConnectivityContract(source());
    expect(contentIdentity(JSON.stringify(result))).toEqual({ algorithm: "sha256", digest: raw, size });
    expect(contentIdentity(canonicalJson(result))).toEqual({ algorithm: "sha256", digest: canonical, size });
    expect(result.identity.digest).toBe(identity);
  });
});

describe("true V2 schematic-only connectivity projection", () => {
  it("validates V2 directly and preserves every component, plane endpoint and no-connect", () => {
    const source = planeWithAdditionalPins();
    const before = JSON.stringify(source);
    const result = createFreshConnectivityContract(source);
    expect(result.schemaVersion).toBe(FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION);
    expect(result.sourceContractIdentity).toEqual(source.identity);
    expect(result.sourceContractIdentity.schemaVersion).toBe(PCB_PLANE_CONTRACT_SCHEMA_VERSION);
    expect(result.components).toEqual(source.components.map(({ reference, symbolLibId, value, footprintLibId }) => ({ reference, symbolLibId, value, footprintLibId })));
    expect(result.nets).toEqual(source.nets.map(({ name, endpoints }) => ({ name, endpoints })));
    expect(result.nets.find((net) => net.name === "GND")!.endpoints).toEqual([
      { reference: "J1", pin: "3" }, { reference: "R2", pin: "2" }, { reference: "R3", pin: "1" },
    ]);
    expect(result.noConnects).toEqual([{ reference: "R3", pin: "2" }]);
    expect(result.nets.flatMap((net) => net.endpoints).length + result.noConnects.length).toBe(source.components.reduce((sum, component) => sum + component.pins.length, 0));
    expect(result).not.toHaveProperty("planes");
    expect(result).not.toHaveProperty("routingConstraints");
    expect(source.routingConstraints.nets.find((route) => route.net === "GND")!.topology).toBe("plane");
    expect(JSON.stringify(source)).toBe(before);
    expect(parsePcbPlaneDesignContract(source)).toEqual(source);
    expect(Object.isFrozen(result.nets.find((net) => net.name === "GND")!.endpoints[0])).toBe(true);
  });

  it("keeps different V1/V2 authority even when their schematic graphs are identical", () => {
    const v1 = createFreshConnectivityContract(closePcbDesignIntentDraft(genericDividerDraft()));
    const v2 = createFreshConnectivityContract(closePcbPlaneDesignIntentDraft(planeDividerDraft()));
    expect(projectGraph(v2)).toEqual(projectGraph(v1));
    expect(v2.sourceContractIdentity).not.toEqual(v1.sourceContractIdentity);
    expect(v2.identity).not.toEqual(v1.identity);
    expect(v2.sourceContractIdentity.schemaVersion).toBe("evleda.pcb-design-contract.v2");
  });

  it("binds changes to genuine V2 plane rules even if schematic endpoints do not change", () => {
    const initial = planeDividerDraft();
    const changed = structuredClone(initial);
    changed.planes[0]!.minimumCopperWidthMm = 0.4;
    const left = createFreshConnectivityContract(closePcbPlaneDesignIntentDraft(initial));
    const right = createFreshConnectivityContract(closePcbPlaneDesignIntentDraft(changed));
    expect(projectGraph(left)).toEqual(projectGraph(right));
    expect(left.sourceContractIdentity).not.toEqual(right.sourceContractIdentity);
    expect(left.identity).not.toEqual(right.identity);
  });

  it("accepts a revalidated serialized V2 contract without fabricating a V1 intermediate", () => {
    const original = planeWithAdditionalPins();
    const revalidated = parsePcbPlaneDesignContract(JSON.parse(JSON.stringify(original)));
    expect(createFreshConnectivityContract(revalidated)).toEqual(createFreshConnectivityContract(original));
  });

  it.each(["missing", "digest", "schema", "canonicalization", "plane-rule-change", "component-value-change"] as const)("rejects tampered V2 identity/source data: %s", (kind) => {
    const value = mutablePlane();
    if (kind === "missing") delete value.identity;
    if (kind === "digest") value.identity.digest = "0".repeat(64);
    if (kind === "schema") value.identity.schemaVersion = "evleda.pcb-design-contract.v1";
    if (kind === "canonicalization") value.identity.canonicalizationVersion = "invented";
    if (kind === "plane-rule-change") value.planes[0].minimumCopperWidthMm = 0.4;
    if (kind === "component-value-change") value.components[0].value = "changed";
    expect(() => createFreshConnectivityContract(value as FreshConnectivityContractSource)).toThrow(/Plane contract identity/u);
  });

  it.each(["missing-plane", "wrong-plane-net", "trace-substitute", "missing-endpoint", "duplicate-endpoint", "missing-disposition", "noncanonical", "LED-shaped", "narrow-thermal-spokes"] as const)("fully validates malformed V2 instead of falling through to LED: %s", (kind) => {
    const value = mutablePlane();
    if (kind === "missing-plane") value.planes = [];
    if (kind === "wrong-plane-net") value.planes[0].net = "VIN";
    if (kind === "trace-substitute") value.routingConstraints.nets.find((route: { net: string }) => route.net === "GND").topology = "tree";
    if (kind === "missing-endpoint") value.nets.find((net: { name: string }) => net.name === "GND").endpoints.pop();
    if (kind === "duplicate-endpoint") value.nets.find((net: { name: string }) => net.name === "GND").endpoints.push({ reference: "J1", pin: "3" });
    if (kind === "missing-disposition") delete value.components[0].pins[0].assignment;
    if (kind === "noncanonical") value.components.reverse();
    if (kind === "narrow-thermal-spokes") value.planes[0].minimumCopperWidthMm = 0.6;
    if (kind === "LED-shaped") {
      Object.assign(value, structuredClone(LED_INDICATOR_EXAMPLE), { schemaVersion: PCB_PLANE_CONTRACT_SCHEMA_VERSION });
    }
    refreshIdentity(value);
    expect(() => createFreshConnectivityContract(value as FreshConnectivityContractSource)).toThrow();
  });

  it.each([undefined, null, "evleda.pcb-design-intent-draft.v2", "evleda.pcb-design-contract.v3", "unknown"])("rejects unsupported source schema %s explicitly", (schemaVersion) => {
    const value = { ...LED_INDICATOR_EXAMPLE, schemaVersion };
    expect(() => createFreshConnectivityContract(value as unknown as FreshConnectivityContractSource)).toThrow(/Unsupported fresh connectivity source schema/u);
  });

  it("rejects a V2 contract merely relabeled as V1", () => {
    const value = { ...planeWithAdditionalPins(), schemaVersion: "evleda.pcb-design-contract.v1" };
    expect(() => createFreshConnectivityContract(value as unknown as FreshConnectivityContractSource)).toThrow();
  });

  it("never invokes the LED parser for valid, malformed, or unknown-version plane input", () => {
    const ledParser = vi.spyOn(freshProject, "parseFreshLedIndicatorContract");
    try {
      createFreshConnectivityContract(planeWithAdditionalPins());
      const malformed = mutablePlane();
      malformed.planes = [];
      refreshIdentity(malformed);
      expect(() => createFreshConnectivityContract(malformed as FreshConnectivityContractSource)).toThrow();
      expect(() => createFreshConnectivityContract({ ...LED_INDICATOR_EXAMPLE, schemaVersion: "evleda.pcb-design-contract.v3" } as unknown as FreshConnectivityContractSource)).toThrow();
      expect(ledParser).not.toHaveBeenCalled();
      createFreshConnectivityContract(LED_INDICATOR_EXAMPLE);
      expect(ledParser).toHaveBeenCalledTimes(1);
    } finally {
      ledParser.mockRestore();
    }
  });
});
