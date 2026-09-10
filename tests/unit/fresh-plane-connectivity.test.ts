import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { prepareFreshPlaneConnectivity, assessFreshPlaneConnectivity, type FreshPlaneConnectivityInput } from "../../src/harness/fresh-plane-connectivity.js";
import { collectKicadNativePadObservation, decodeKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";

type Raw = Record<string, any>;
const uuid = (index: number) => `88888888-8888-4888-8888-${String(index).padStart(12, "0")}`;
function board(options: { repeatedGround?: boolean; wrongPinNet?: boolean; unknownTerminal?: boolean } = {}) {
  const draft = planeDividerDraft();
  const footprints = draft.components.map((component, index) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${index * 5 + 3} 3)
    (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
    ${component.pins.map((pin, ordinal) => `(pad ${JSON.stringify(pin.pin)} smd rect (uuid "${uuid((index + 1) * 100 + ordinal + 1)}") (at 0 ${ordinal * 2}) (size 1 1) (layers "F.Cu")
      (net ${JSON.stringify(options.wrongPinNet && component.reference === "R1" && pin.pin === "1" ? "VOUT" : pin.assignment.kind === "net" ? pin.assignment.net : "")}))`).join("\n")}
    ${options.repeatedGround && component.reference === "J1" ? `(pad "3" smd rect (uuid "${uuid(104)}") (at 2 4) (size 1 1) (layers "F.Cu") (net "GND"))` : ""})`).join("\n");
  const unknown = options.unknownTerminal ? `(footprint "Test:Uncontracted" (uuid "${uuid(4)}") (layer "F.Cu") (at 20 10) (property "Reference" "X1") (property "Value" "UNKNOWN") (pad "1" smd rect (uuid "${uuid(401)}") (at 0 0) (size 1 1) (layers "F.Cu") (net "GND")))` : "";
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
    (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) ${footprints} ${unknown})\n`;
}
function bundle() {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic offline V2 reachability." }, dependencies);
}
const envelope = (payload: Raw) => ({ isError: false, structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
async function fixture(options: Parameters<typeof board>[0] = {}) {
  const source = board(options), native = await nativePadObservationFixture(source), compilationBundle = bundle();
  const input: FreshPlaneConnectivityInput = { compilationBundle, pcbPath: native.expected.pcbPath, pcbSource: source,
    scopeIdentity: canonicalIdentity({ marker: "owned-current-saved-project" }, "evleda.offline-plane-connectivity-host-scope.v1"),
    physicalFootprints: native.expected.physicalFootprints!.filter(pin => compilationBundle.contract.components.some(component => component.reference === pin.reference)),
    physicalFootprintResolver: native.expected.physicalFootprintResolver! };
  const prepared = prepareFreshPlaneConnectivity(input), payload = structuredClone(native.observation.rawSnapshot) as Raw;
  payload.connectivity = prepared.nativePadExpected.requestedPrimitiveIds.map(id => payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === id));
  async function collect(change?: (payload: Raw) => void) {
    const raw = structuredClone(payload); change?.(raw);
    return collectKicadNativePadObservation({ async readLivePcbPadSnapshot(ids) {
      expect(ids).toEqual(prepared.nativePadExpected.requestedPrimitiveIds); return envelope(raw);
    } }, prepared.nativePadExpected);
  }
  return { input, prepared, payload, collect };
}
function setCluster(payload: Raw, sourceId: string, members: string[]) {
  payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === sourceId).padRecordIndexes = members.map(id => payload.padRecords.findIndex((pad: Raw) => pad.id.value === id));
}

describe("V2 exact saved-native endpoint reachability", () => {
  it("assesses every actual contracted net with current host evidence and distinct V2/library/plan/source identities", async () => {
    const f = await fixture(), nativePads = await f.collect(), result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.status).toBe("connected"); expect(result.nets.map(net => net.net)).toEqual(f.input.compilationBundle.contract.nets.map(net => net.name));
    expect(result.nets.every(net => net.status === "connected" && net.everyEligiblePhysicalMemberReachable)).toBe(true);
    expect(result.contractIdentity).toEqual(f.input.compilationBundle.contract.identity);
    expect(result.verificationPlanIdentity).toEqual(f.input.compilationBundle.verificationPlan.identity);
    expect(result.libraryBindingIdentity).toEqual(f.input.compilationBundle.libraryBinding.identity);
    expect(result.savedSourceIdentity).toEqual(contentIdentity(f.input.pcbSource));
    expect(result.physicalLibraryBindings).toHaveLength(3);
    expect(result.verificationPlanRowsPassed).toEqual([]); expect(result.acceptanceEvaluated).toBe(false);
    expect(result.limitations).toMatchObject({ intendedPlaneContact: "not_evaluated", fillFreshness: "not_established", singlePlaneComponent: "not_evaluated", thermalContacts: "not_evaluated", highFrequencyValidity: "not_established",
      crossNetShortAbsence: "not_established-by-native-connectivity-traversal", nativeDrcAndClearance: "not_evaluated" });
    expect(result.nets.flatMap(net => net.nativeQueries).map(query => query.sourceUuids[0])).toEqual(f.prepared.nativePadExpected.requestedPrimitiveIds);
  });

  it("reports partially routed signals separately without hiding them behind connected ground", async () => {
    const f = await fixture(), ids = f.prepared.endpointRequests.filter(endpoint => endpoint.net === "VIN").flatMap(endpoint => endpoint.physicalPadUuids);
    const nativePads = await f.collect(payload => { for (const id of ids) setCluster(payload, id, [id]); });
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.status).toBe("partially-connected");
    expect(result.nets.find(net => net.net === "VIN")!.status).toBe("disconnected");
    expect(result.nets.find(net => net.net === "GND")!.status).toBe("connected");
  });

  it("keeps logical common-component reachability distinct from split physical terminal members", async () => {
    const f = await fixture({ repeatedGround: true });
    const terminal = f.prepared.endpointRequests.find(endpoint => endpoint.net === "GND" && endpoint.reference === "J1")!;
    expect(terminal.physicalPadUuids).toHaveLength(2);
    const separated = terminal.physicalPadUuids[1]!, other = f.prepared.endpointRequests.filter(endpoint => endpoint.net === "GND").flatMap(endpoint => endpoint.physicalPadUuids).filter(id => id !== separated);
    const nativePads = await f.collect(payload => { setCluster(payload, separated, [separated]); for (const id of other) setCluster(payload, id, other); });
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads }), ground = result.nets.find(net => net.net === "GND")!;
    expect(result.status).toBe("needs-review"); expect(ground.status).toBe("needs-review");
    expect(ground.logicalEndpointReachability.status).toBe("reachable"); expect(ground.everyEligiblePhysicalMemberReachable).toBe(false);
    expect(ground.logicalEndpointReachability.commonComponents[0]!.endpoints.find(endpoint => endpoint.reference === "J1")!.separatedPhysicalPadUuids).toEqual([separated]);
    expect(ground.endpoints.find(endpoint => endpoint.reference === "J1")!.nativeCopperCommon!.status).toBe("disconnected");
    expect(ground.endpoints.every(endpoint => endpoint.componentInternalConnectivity === "not-inferred")).toBe(true);
    const all = assessFreshPlaneConnectivity({ ...f.input, nativePads: await f.collect() });
    expect(all.nets.find(net => net.net === "GND")!.status).toBe("connected");
  });

  it("rejects asymmetric complete cluster membership without invalidating unrelated nets", async () => {
    const f = await fixture(), ids = f.prepared.endpointRequests.filter(endpoint => endpoint.net === "VIN").flatMap(endpoint => endpoint.physicalPadUuids);
    const nativePads = await f.collect(payload => setCluster(payload, ids[1]!, [ids[1]!]));
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.nets.find(net => net.net === "VIN")!.status).toBe("invalid-evidence");
    expect(result.nets.find(net => net.net === "GND")!.status).toBe("connected");
  });

  it("rejects wrong-net returned pads and wrong-net saved endpoint assignments", async () => {
    const f = await fixture(), signal = f.prepared.endpointRequests.find(endpoint => endpoint.net === "VIN")!.physicalPadUuids[0]!, ground = f.prepared.endpointRequests.find(endpoint => endpoint.net === "GND")!.physicalPadUuids[0]!;
    const nativePads = await f.collect(payload => {
      const query = payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === signal);
      query.padRecordIndexes.push(payload.padRecords.findIndex((pad: Raw) => pad.id.value === ground));
    });
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.nets.find(net => net.net === "VIN")!.invalidReturnedPhysicalPadUuids).toContain(ground);
    expect(result.nets.find(net => net.net === "VIN")!.status).toBe("invalid-evidence");
    const wrong = await fixture({ wrongPinNet: true });
    expect(assessFreshPlaneConnectivity({ ...wrong.input, nativePads: await wrong.collect() }).nets.find(net => net.net === "VIN")!.status).toBe("invalid-evidence");
  });

  it("rejects an uncontracted same-net terminal even though it is a known native physical pad", async () => {
    const f = await fixture({ unknownTerminal: true }), nativePads = await f.collect();
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.nets.find(net => net.net === "GND")!.status).toBe("invalid-evidence");
    expect(result.nets.find(net => net.net === "GND")!.invalidReturnedPhysicalPadUuids).toHaveLength(1);
  });

  it("does not infer usable copper from footprint origins or unknown native layer presence", async () => {
    const f = await fixture(), id = f.prepared.endpointRequests.find(endpoint => endpoint.net === "GND")!.physicalPadUuids[0]!;
    const nativePads = await f.collect(payload => { payload.padstackPresence.response.entries.find((entry: Raw) => entry.item.value === id && entry.layer === "BL_F_Cu").presence = "PSP_UNKNOWN"; });
    expect(assessFreshPlaneConnectivity({ ...f.input, nativePads }).nets.find(net => net.net === "GND")!.status).not.toBe("connected");
  });

  it("requires actual current host collection, not missing, decoded-only, copied, or subset query evidence", async () => {
    const f = await fixture(), nativePads = await f.collect();
    for (const evidence of [undefined, structuredClone(nativePads), decodeKicadNativePadObservation(envelope(f.payload), f.prepared.nativePadExpected)]) {
      expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads: evidence })).toThrow("current private host collector");
    }
    const partial = structuredClone(f.payload); partial.connectivity.pop();
    const shortExpected = { ...f.prepared.nativePadExpected, requestedPrimitiveIds: f.prepared.nativePadExpected.requestedPrimitiveIds.slice(0, -1) };
    const collectedSubset = await collectKicadNativePadObservation({ async readLivePcbPadSnapshot() { return envelope(partial); } }, shortExpected);
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads: collectedSubset })).toThrow("current host source/scope/request");
  });

  it("rejects stale source, scope, contract, path and physical-library pins", async () => {
    const f = await fixture(), nativePads = await f.collect();
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads, pcbSource: f.input.pcbSource.replace("thickness 1.6", "thickness 1.7") })).toThrow("source/scope/request");
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads, scopeIdentity: canonicalIdentity({ marker: "changed" }, "evleda.offline-plane-connectivity-host-scope.v1") })).toThrow("source/scope/request");
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads, pcbPath: "D:\\different\\fixture.kicad_pcb" })).toThrow("source/scope/request");
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads, compilationBundle: structuredClone(f.input.compilationBundle) })).toThrow("authenticated");
    const pins = structuredClone(f.input.physicalFootprints); (pins[0]!.sourceIdentity as any).digest = "0".repeat(64);
    expect(() => assessFreshPlaneConnectivity({ ...f.input, nativePads, physicalFootprints: pins })).toThrow("physical library");
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, physicalFootprints: f.input.physicalFootprints.slice(1) })).toThrow("complete approved");
  });
});
