import { assessFreshPlaneAcceptance } from "../../src/harness/fresh-plane-acceptance.js";
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
import { createFreshConnectivityContract, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createFreshNativeTerminalBinding, freshNativeNetlistParityIssues } from "../../src/harness/fresh-native-terminal-binding.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";

type Raw = Record<string, any>;
const uuid = (index: number) => `88888888-8888-4888-8888-${String(index).padStart(12, "0")}`;
function board(options: { repeatedGround?: boolean; wrongPinNet?: boolean; unknownTerminal?: boolean; nativeNoConnectName?: string; repeatedNoConnect?: boolean } = {}, draft = planeDividerDraft()) {
  const footprints = draft.components.map((component, index) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${index * 5 + 3} 3)
    (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
    ${component.pins.map((pin, ordinal) => `(pad ${JSON.stringify(pin.pin)} smd rect (uuid "${uuid((index + 1) * 100 + ordinal + 1)}") (at 0 ${ordinal * 2}) (size 1 1) (layers "F.Cu")
      (net ${JSON.stringify(options.wrongPinNet && component.reference === "R1" && pin.pin === "1" ? "VOUT" : pin.assignment.kind === "net" ? pin.assignment.net : options.nativeNoConnectName ?? "")}))`).join("\n")}
    ${options.repeatedGround && component.reference === "J1" ? `(pad "3" smd rect (uuid "${uuid(104)}") (at 2 4) (size 1 1) (layers "F.Cu") (net "GND"))` : ""}
    ${options.repeatedNoConnect && component.reference === "J1" ? `(pad "4" smd rect (uuid "${uuid(105)}") (at 2 6) (size 1 1) (layers "F.Cu") (net ${JSON.stringify(options.nativeNoConnectName)}))` : ""})`).join("\n");
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
function setCluster(payload: Raw, sourceId: string, members: readonly string[]) {
  payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === sourceId).padRecordIndexes = members.map(id => payload.padRecords.findIndex((pad: Raw) => pad.id.value === id));
}

const nativeNoConnectName = "native isolated terminal J1 / raw name";
function nativeNetlistSource(contract: FreshConnectivityContract) {
  const node = (reference: string, pin: string, pinType: string) => `(node (ref ${JSON.stringify(reference)}) (pin ${JSON.stringify(pin)}) (pintype ${JSON.stringify(pinType)}))`;
  return `(export (components ${contract.components.map(component => {
    const [lib, part] = component.symbolLibId.split(":");
    return `(comp (ref ${JSON.stringify(component.reference)}) (value ${JSON.stringify(component.value)}) (footprint ${JSON.stringify(component.footprintLibId)}) (libsource (lib ${JSON.stringify(lib)}) (part ${JSON.stringify(part)})))`;
  }).join(" ")}) (nets ${contract.nets.map(net => `(net (name ${JSON.stringify(net.name)}) ${net.endpoints.map(endpoint => node(endpoint.reference, endpoint.pin, "passive")).join(" ")})`).join(" ")}
    ${contract.noConnects.map(endpoint => `(net (name ${JSON.stringify(nativeNoConnectName)}) ${node(endpoint.reference, endpoint.pin, "passive+no_connect")})`).join(" ")}))`;
}

async function noConnectFixture(repeatedNoConnect = false) {
  const draft = planeDividerDraft(), connector = draft.components.find(component => component.reference === "J1")!;
  connector.symbolLibId = "Connector_Generic:Conn_01x04";
  connector.footprintLibId = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical";
  connector.pins.push({ pin: "4", assignment: { kind: "no_connect" } });
  const resolver: PcbReadOnlyLibraryResolver = {
    resolveSymbol(libraryId) {
      if (libraryId !== connector.symbolLibId) return genericDividerLibraryResolver.resolveSymbol(libraryId);
      return { ...genericDividerLibraryResolver.resolveSymbol("Connector_Generic:Conn_01x03")!, libraryId,
        pins: ["1", "2", "3", "4"].map(number => ({ number, function: `Pin ${number}` })) };
    },
    resolveFootprint(libraryId) {
      if (libraryId !== connector.footprintLibId) return genericDividerLibraryResolver.resolveFootprint(libraryId);
      return { ...genericDividerLibraryResolver.resolveFootprint("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical")!, libraryId, pads: ["1", "2", "3", "4"] };
    },
  };
  const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const compilationBundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic offline V2 NC isolation." }, dependencies);
  const source = board({ nativeNoConnectName, repeatedNoConnect }, draft), native = await nativePadObservationFixture(source);
  const contract = createFreshConnectivityContract(compilationBundle.contract, compilationBundle.externalPowerBinding);
  const scopeIdentity = canonicalIdentity({ marker: "owned-current-saved-project-NC" }, "evleda.offline-plane-connectivity-host-scope.v1");
  const netlistSource = nativeNetlistSource(contract);
  const nativeTerminalBinding = createFreshNativeTerminalBinding(contract, netlistSource, scopeIdentity);
  const input: FreshPlaneConnectivityInput = { compilationBundle, pcbPath: native.expected.pcbPath, pcbSource: source, scopeIdentity,
    physicalFootprints: native.expected.physicalFootprints!, physicalFootprintResolver: native.expected.physicalFootprintResolver!, nativeTerminalBinding };
  const prepared = prepareFreshPlaneConnectivity(input), payload = structuredClone(native.observation.rawSnapshot) as Raw;
  payload.connectivity = prepared.nativePadExpected.requestedPrimitiveIds.map(id => payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === id));
  async function collect(change?: (payload: Raw) => void) {
    const raw = structuredClone(payload); change?.(raw);
    return collectKicadNativePadObservation({ async readLivePcbPadSnapshot(ids) {
      expect(ids).toEqual(prepared.nativePadExpected.requestedPrimitiveIds); return envelope(raw);
    } }, prepared.nativePadExpected);
  }
  return { input, prepared, payload, collect, contract, netlistSource, nativeTerminalBinding };
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

describe("V2 qualified native no-connect isolation", () => {
  it("preserves the exact native NC name in separate isolation evidence and excludes it from functional nets", async () => {
    const f = await noConnectFixture(), nativePads = await f.collect();
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.status).toBe("connected");
    expect(result.nativeTerminalBindingIdentity).toEqual(f.nativeTerminalBinding.identity);
    expect(f.prepared.noConnectRequests).toEqual([
      { reference: "J1", pin: "4", nativeNetName: nativeNoConnectName, physicalPadUuids: [uuid(104)] },
    ]);
    expect(result.noConnectIsolation).toHaveLength(1);
    expect(result.noConnectIsolation![0]).toMatchObject({ reference: "J1", pin: "4", nativeNetName: nativeNoConnectName,
      semanticNet: null, disposition: "no_connect", status: "isolated", componentInternalConnectivity: "not-inferred" });
    expect(result.nets.map(net => net.net)).toEqual(f.input.compilationBundle.contract.nets.map(net => net.name));
    expect(result.nets.some(net => net.net === nativeNoConnectName)).toBe(false);
    expect(f.prepared.endpointRequests.some(endpoint => endpoint.reference === "J1" && endpoint.pin === "4")).toBe(false);
    const functionalQueryIds = result.nets.flatMap(net => net.nativeQueries.map(query => query.sourceUuids[0]!));
    const isolatedQueryIds = result.noConnectIsolation!.flatMap(endpoint => endpoint.nativeQueries.map(query => query.sourceUuids[0]!));
    expect(isolatedQueryIds).toEqual([uuid(104)]);
    expect(functionalQueryIds).not.toContain(uuid(104));
    expect([...functionalQueryIds, ...isolatedQueryIds]).toEqual(f.prepared.nativePadExpected.requestedPrimitiveIds);
  });

  it("propagates NC-only native reachability failure into plane acceptance integrity", async () => {
    const f=await noConnectFixture(), nc=f.prepared.noConnectRequests![0]!.physicalPadUuids[0]!;
    const functional=f.prepared.endpointRequests[0]!.physicalPadUuids[0]!;
    const nativePads=await f.collect(payload=>setCluster(payload,nc,[nc,functional]));
    const endpointConnectivity=assessFreshPlaneConnectivity({...f.input,nativePads});
    expect(endpointConnectivity.nets.every(net=>net.status==="connected")).toBe(true);
    expect(endpointConnectivity.noConnectIsolation![0]!.status).toBe("invalid-evidence");
    const result=await assessFreshPlaneAcceptance({compilationBundle:f.input.compilationBundle,pcbSource:f.input.pcbSource,
      projectSettingsSource:"{}",rulesSource:"",savedEvidence:null,endpointConnectivity});
    expect(result.status).toBe("failed");
    expect(result.rows.find(row=>row.id==="contract:integrity")?.status).toBe("fail");
    expect(result.accepted).toBe(false);
  });

  it("accepts repeated physical NC members in either the same or separate native PAD clusters", async () => {
    const f = await noConnectFixture(true), ids = f.prepared.noConnectRequests![0]!.physicalPadUuids;
    expect(ids).toEqual([uuid(104), uuid(105)]);
    const together = assessFreshPlaneConnectivity({ ...f.input, nativePads: await f.collect() });
    expect(together.status).toBe("connected");
    expect(together.noConnectIsolation![0]!.status).toBe("isolated");
    const nativePads = await f.collect(payload => { for (const id of ids) setCluster(payload, id, [id]); });
    const separate = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(separate.status).toBe("connected");
    expect(separate.noConnectIsolation![0]!.status).toBe("isolated");
    expect(separate.noConnectIsolation![0]!.nativeQueries.map(query => query.returnedPadUuids)).toEqual(ids.map(id => [id]));
    expect(separate.nets.every(net => net.status === "connected")).toBe(true);
  });

  it("rejects missing, forged, stale-scope and wrong-contract binding authority before collection", async () => {
    const f = await noConnectFixture();
    const { nativeTerminalBinding: _binding, ...missing } = f.input;
    expect(() => prepareFreshPlaneConnectivity(missing)).toThrow(/not authenticated/u);
    for (const forged of [{ ...f.nativeTerminalBinding }, structuredClone(f.nativeTerminalBinding)]) {
      expect(() => prepareFreshPlaneConnectivity({ ...f.input, nativeTerminalBinding: forged })).toThrow(/not authenticated/u);
    }
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, scopeIdentity: canonicalIdentity({ changed: true }, "fixture.changed-scope.v1") })).toThrow(/stale/u);
    const otherContract = createFreshConnectivityContract(bundle().contract);
    const otherBinding = createFreshNativeTerminalBinding(otherContract, nativeNetlistSource(otherContract), f.input.scopeIdentity);
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, nativeTerminalBinding: otherBinding })).toThrow(/stale/u);
  });

  it.each(["wrong native name", "unconnected-(J1-Pin_4-Pad4)"])("rejects saved NC assignment '%s' without accepting a prefix substitute", async (wrongName) => {
    const f = await noConnectFixture(true);
    const pcbSource = f.input.pcbSource.replaceAll(JSON.stringify(nativeNoConnectName), JSON.stringify(wrongName));
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, pcbSource })).toThrow(/every physical pad/u);
  });

  it("rejects one incorrectly assigned repeated NC member", async () => {
    const f = await noConnectFixture(true);
    const pcbSource = f.input.pcbSource.replace(JSON.stringify(nativeNoConnectName), '"GND"');
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, pcbSource })).toThrow(/every physical pad/u);
  });

  it("rejects another logical terminal assigned to the qualified native NC name", async () => {
    const f = await noConnectFixture();
    const pcbSource = f.input.pcbSource.replace('(net "VIN")', `(net ${JSON.stringify(nativeNoConnectName)})`);
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, pcbSource })).toThrow(/another logical terminal/u);
  });

  it.each([
    ["track", `(segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net ${JSON.stringify(nativeNoConnectName)}))`],
    ["via", `(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${JSON.stringify(nativeNoConnectName)}))`],
    ["zone", `(zone (net ${JSON.stringify(nativeNoConnectName)}))`],
  ])("rejects saved %s copper on a qualified NC net", async (_label, copper) => {
    const f = await noConnectFixture();
    const pcbSource = f.input.pcbSource.replace(/\)\n$/u, `${copper})\n`);
    expect(() => prepareFreshPlaneConnectivity({ ...f.input, pcbSource })).toThrow(/track, via, or zone copper/u);
  });

  it("rejects foreign PAD reachability in NC isolation while preserving functional net findings", async () => {
    const f = await noConnectFixture(), ncId = f.prepared.noConnectRequests![0]!.physicalPadUuids[0]!;
    const foreign = f.prepared.endpointRequests.find(endpoint => endpoint.net === "GND")!.physicalPadUuids[0]!;
    const nativePads = await f.collect(payload => setCluster(payload, ncId, [ncId, foreign]));
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.status).toBe("invalid-evidence");
    expect(result.noConnectIsolation![0]!.status).toBe("invalid-evidence");
    expect(result.noConnectIsolation![0]!.nativeQueries[0]!.returnedPadUuids).toContain(foreign);
    expect(result.nets.every(net => net.status === "connected")).toBe(true);
  });

  it("rejects overlapping asymmetric native NC clusters", async () => {
    const f = await noConnectFixture(true), ids = f.prepared.noConnectRequests![0]!.physicalPadUuids;
    const nativePads = await f.collect(payload => { setCluster(payload, ids[0]!, ids); setCluster(payload, ids[1]!, [ids[1]!]); });
    const result = assessFreshPlaneConnectivity({ ...f.input, nativePads });
    expect(result.noConnectIsolation![0]!.status).toBe("invalid-evidence");
    expect(result.status).toBe("invalid-evidence");
  });

  it("rejects a conventional-looking native NC name without the exact native pin-type token", async () => {
    const f = await noConnectFixture();
    const impostor = f.netlistSource.replace(nativeNoConnectName, "unconnected-(J1-Pin_4-Pad4)").replace("passive+no_connect", "passive");
    expect(() => createFreshNativeTerminalBinding(f.contract, impostor, f.input.scopeIdentity)).toThrow(/complete native netlist parity/u);
  });

  it("rejects no_connect annotations on a functional multi-node net even when no NC is contracted", () => {
    const contract = createFreshConnectivityContract(bundle().contract);
    expect(contract.noConnects).toEqual([]);
    const source = nativeNetlistSource(contract).replace('(pintype "passive")', '(pintype "passive+no_connect")');
    expect(freshNativeNetlistParityIssues(contract, source).some(issue => issue.code.includes("NO_CONNECT"))).toBe(true);
    expect(() => createFreshNativeTerminalBinding(contract, source, canonicalIdentity({ fixture: true }, "fixture.scope.v1"))).toThrow(/complete native netlist parity/u);
  });
});
