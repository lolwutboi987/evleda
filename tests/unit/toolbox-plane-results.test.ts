import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { compareFreshNativeNetlists } from "../../src/harness/fresh-native-netlist-comparison.js";
import { compoundMutationState } from "../../src/harness/pcb-agent-harness.js";
import { planeCompoundMutationState } from "../../src/mcp/toolbox-plane-results.js";

const sourceContractIdentity = canonicalIdentity({ planes: ["GND"] }, "evleda.pcb-design-contract.v2");
const connectivityIdentity = canonicalIdentity({ sourceContractIdentity }, "evleda.fresh-connectivity-contract.v1");
const projectBindingIdentity = canonicalIdentity({ sourceContractIdentity, connectivityIdentity }, "evleda.pcb-agent-plane-fresh-binding.v1");
const expected = { sourceContractIdentity, connectivityIdentity, projectBindingIdentity };
const call = { id: "plane-sync", name: "fresh_sync_from_schematic", arguments: {} };
const schemaVersion = "evleda.fresh-plane-sync-from-schematic-result.v1";
const fixture = (): Record<string, unknown> => {
  const source = contentIdentity("source bytes");
  const body = {
    schemaVersion, contractIdentity: connectivityIdentity, sourceContractIdentity, planeProjectBindingIdentity: projectBindingIdentity,
    freshMarkerContentIdentity: source, applied: true, mutated: true, idempotent: false,
    beforePcbContentIdentity: source, afterPcbContentIdentity: contentIdentity("synced bytes"), schematicContentIdentity: source,
    nativeNetlistComparison: compareFreshNativeNetlists(
      '(export (design (source "fixture.kicad_sch") (date "2026-09-08T23:44:50")))',
      '(export (design (source "fixture.kicad_sch") (date "2026-09-08T23:44:55")))',
    ),
    receivedSidecarResponseIdentity: source, placementReview: { status: "pending-final-acceptance", interimFindings: [] },
    footprintLibraryTableIdentity: source, componentCount: 2, unresolvedMappingCount: 0, issues: [],
    physicalPadCount: 5, logicalTerminalCount: 3, numberedCopperPrimitiveCount: 4, namedCopperPrimitiveCount: 3,
    noConnectCopperPrimitiveCount: 1, logicalNamedTerminalCount: 2, logicalNoConnectTerminalCount: 1,
    nonElectricalFeatureCount: 1, platedFootprintHoleCount: 2, nativePadSnapshotIdentity: source,
    physicalPadExpectedIdentity: canonicalIdentity({ pads: 5 }, "evleda.kicad-native-pad-expected.v1"),
    upstreamMetrics: { totalPadsConsidered: 4, namedPads: 3, noNetPads: 1, transferQuality: "DEGRADED", namedPadCoveragePercent: 75,
      fullyNamedReferences: 1, partiallyNamedReferences: 1, unresolvedPadReferences: "U1", additionalUnresolvedReferences: 0,
      literalLines: ["Transfer quality: DEGRADED"] },
  };
  return structuredClone({ ...body, identity: canonicalIdentity(body, schemaVersion) });
};
const resultFor = (body: unknown) => ({ toolCallId: call.id, content: JSON.stringify(body) });
const routeSchemaVersion = "evleda.fresh-plane-route-mutation-result.v1";
const selectionIdentity = canonicalIdentity({ net: "GND" }, "evleda.fresh-plane-route-selection.v1");
const routeCall = { id: "route", name: "fresh_replace_route_items", arguments: {
  selectionIdentity: { ...selectionIdentity }, net: "GND", deleteItemIds: ["b", "a"], tracks: [{ x1Mm: 0, y1Mm: 0, x2Mm: 1, y2Mm: 1, layer: "F.Cu" }], vias: [],
} };
const routeFixture = (): Record<string, unknown> => {
  const payload = {
    schemaVersion: routeSchemaVersion, contractIdentity: connectivityIdentity, planeProjectBindingIdentity: projectBindingIdentity,
    sourceContractIdentity, freshMarkerContentIdentity: contentIdentity("marker"), applied: true, mutated: true, idempotent: false,
    selectionIdentity, beforePcbContentIdentity: contentIdentity("before"), livePcbContentIdentity: contentIdentity("after"),
    net: "GND", deletedItemIds: ["a", "b"], addedTrackCount: 1, addedViaCount: 0,
    completion: "not_evaluated", connection: "not_evaluated", mutationValidity: "verified", scope: "selected-net-incremental-route-geometry",
    notEvaluated: ["plane_contact", "clearance", "reference_coverage", "completed_route_topology"], issues: [],
  };
  return structuredClone({ ...payload, identity: canonicalIdentity(payload, routeSchemaVersion) });
};
const applySchemaVersion = "evleda.fresh-plane-apply-result.v1";
const applyCall = { id: "apply", name: "fresh_apply_contract_plane", arguments: { planeId: "ground" } };
const applyFixture = (): Record<string, unknown> => {
  const payload = {
    schemaVersion: applySchemaVersion, contractIdentity: connectivityIdentity, planeProjectBindingIdentity: projectBindingIdentity,
    sourceContractIdentity, freshMarkerContentIdentity: contentIdentity("marker"), planeId: "ground",
    targetZoneUuid: "11111111-1111-4111-8111-111111111111", operation: "create",
    preparedSpecIdentity: canonicalIdentity({ planeId: "ground" }, "evleda.fresh-plane-mutation-spec.v1"),
    beforePcbContentIdentity: contentIdentity("before"), stagedPcbContentIdentity: contentIdentity("after"),
    stageReceiptIdentity: contentIdentity("native receipt"),
    mutationComparisonIdentity: canonicalIdentity({ valid: true }, "evleda.fresh-plane-mutation-comparison.v1"),
    requirements: { minimumIslandAreaMm2: 2, minimumAreaEnforcement: "not-enforced-by-always-mode", minimumSpokes: 2, spokeEnforcement: "external-owned-rule-and-native-evidence" },
    applied: true, mutated: true, idempotent: false, nativeActionsPerformed: true, sourceChanged: true,
    completion: "not_evaluated", connection: "not_evaluated", referenceCoverage: "not_evaluated", thermalAcceptance: "not_evaluated", islandAreaAcceptance: "not_evaluated",
    nativeSaveCalledByStage: false, acceptanceEvaluated: false, issues: [],
  };
  return structuredClone({ ...payload, identity: canonicalIdentity(payload, applySchemaVersion) });
};

describe("direct toolbox plane result boundary", () => {
  it.each([true, false])("requires save after native apply with sourceChanged=%s", (sourceChanged) => {
    const payload = applyFixture(); payload.sourceChanged = sourceChanged;
    if (!sourceChanged) { payload.operation = "update"; payload.stagedPcbContentIdentity = payload.beforePcbContentIdentity; }
    const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, applySchemaVersion);
    expect(planeCompoundMutationState(applyCall, resultFor(payload), expected)).toBe(true);
    expect(planeCompoundMutationState({ ...applyCall, arguments: {} }, resultFor(payload), expected)).toBe(true);
  });
  it("accepts full connection requirements without implying thermal acceptance", () => {
    const payload = applyFixture();
    payload.requirements = { minimumIslandAreaMm2: 0, minimumAreaEnforcement: "not-enforced-by-always-mode", minimumSpokes: null, spokeEnforcement: "not-applicable" };
    const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, applySchemaVersion);
    expect(planeCompoundMutationState(applyCall, resultFor(payload), expected)).toBe(true);
  });
  it("rejects error envelopes without authorizing save and rejects unrequested apply arguments", () => {
    expect(() => planeCompoundMutationState(applyCall, { ...resultFor(applyFixture()), isError: true }, expected)).toThrow(/save are not authorized/);
    expect(() => planeCompoundMutationState({ ...applyCall, arguments: { planeId: "other" } }, resultFor(applyFixture()), expected)).toThrow(/selection request/);
    expect(() => planeCompoundMutationState({ ...applyCall, arguments: { width: 1 } }, resultFor(applyFixture()), expected)).toThrow(/selection request/);
  });
  it.each([
    ["wrong project", ["planeProjectBindingIdentity", "digest"], "f".repeat(64)],
    ["wrong source", ["sourceContractIdentity", "digest"], "f".repeat(64)],
    ["wrong connectivity", ["contractIdentity", "digest"], "f".repeat(64)],
    ["missing spec", ["preparedSpecIdentity"], undefined],
    ["wrong spec domain", ["preparedSpecIdentity", "schemaVersion"], "wrong"],
    ["missing receipt", ["stageReceiptIdentity"], undefined],
    ["empty receipt", ["stageReceiptIdentity", "size"], 0],
    ["empty before source", ["beforePcbContentIdentity", "size"], 0],
    ["empty staged source", ["stagedPcbContentIdentity", "size"], 0],
    ["oversized receipt", ["stageReceiptIdentity", "size"], 8_388_609],
    ["oversized staged source", ["stagedPcbContentIdentity", "size"], 1_048_577],
    ["missing comparison", ["mutationComparisonIdentity"], undefined],
    ["wrong comparison domain", ["mutationComparisonIdentity", "schemaVersion"], "wrong"],
    ["generic mix", ["genericProjectBindingIdentity"], projectBindingIdentity],
    ["not mutated", ["mutated"], false],
    ["idempotent", ["idempotent"], true],
    ["no native actions", ["nativeActionsPerformed"], false],
    ["native save claimed", ["nativeSaveCalledByStage"], true],
    ["acceptance claimed", ["acceptanceEvaluated"], true],
    ["DC claimed", ["connection"], "verified"],
    ["completion claimed", ["completion"], "completed"],
    ["reference claimed", ["referenceCoverage"], "verified"],
    ["thermal claimed", ["thermalAcceptance"], "verified"],
    ["island area claimed", ["islandAreaAcceptance"], "verified"],
    ["unsupported operation", ["operation"], "delete"],
    ["invalid UUID", ["targetZoneUuid"], "not-a-uuid"],
    ["unknown requirement", ["requirements", "extra"], true],
    ["bad spokes", ["requirements", "minimumSpokes"], 5],
    ["incoherent spokes", ["requirements", "minimumSpokes"], null],
    ["negative area", ["requirements", "minimumIslandAreaMm2"], -1],
    ["forged hash", ["identity", "digest"], "f".repeat(64)],
  ] as const)("rejects plane apply %s", (label, path, replacement) => {
    const payload = applyFixture(); let parent = payload;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    if (replacement === undefined) delete parent[path.at(-1)!]; else parent[path.at(-1)!] = replacement;
    if (label !== "forged hash") { const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, applySchemaVersion); }
    expect(() => planeCompoundMutationState(applyCall, resultFor(payload), expected)).toThrow();
  });
  it.each([true, false])("rejects contradictory rehashed sourceChanged=%s", (sourceChanged) => {
    const payload = applyFixture(); payload.sourceChanged = sourceChanged;
    if (sourceChanged) payload.stagedPcbContentIdentity = payload.beforePcbContentIdentity;
    const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, applySchemaVersion);
    expect(() => planeCompoundMutationState(applyCall, resultFor(payload), expected)).toThrow(/sourceChanged/);
  });
  it.each(["replace", "append", "delete"])("accepts bound incremental route %s without claiming completion", (mode) => {
    const request = structuredClone(routeCall);
    const payload = routeFixture();
    if (mode === "append") { request.arguments.deleteItemIds = []; payload.deletedItemIds = []; }
    if (mode === "delete") { request.arguments.tracks = []; payload.addedTrackCount = 0; }
    const { identity: _identity, ...body } = payload;
    payload.identity = canonicalIdentity(body, routeSchemaVersion);
    expect(planeCompoundMutationState(request, resultFor(payload), expected)).toBe(true);
    expect(payload).toMatchObject({ completion: "not_evaluated", connection: "not_evaluated" });
    expect(() => compoundMutationState(request, resultFor(payload), connectivityIdentity)).toThrow(/invalid host board-mutation/);
  });

  it.each([
    ["selection", ["selectionIdentity", "digest"], "f".repeat(64)],
    ["net", ["net"], "VIN"],
    ["deletion", ["deletedItemIds"], ["a"]],
    ["unsorted deletion", ["deletedItemIds"], ["b", "a"]],
    ["duplicate deletion", ["deletedItemIds"], ["a", "a"]],
    ["track count", ["addedTrackCount"], 2],
    ["via count", ["addedViaCount"], 1],
    ["project identity", ["planeProjectBindingIdentity", "digest"], "f".repeat(64)],
    ["source identity", ["sourceContractIdentity", "digest"], "f".repeat(64)],
    ["connectivity identity", ["contractIdentity", "digest"], "f".repeat(64)],
    ["generic mix", ["genericProjectBindingIdentity"], projectBindingIdentity],
    ["legacy selection", ["selectionIdentity", "schemaVersion"], "evleda.fresh-route-selection.v1"],
    ["completion claim", ["completion"], "completed"],
    ["connection claim", ["connection"], "verified"],
    ["omitted limitations", ["notEvaluated"], []],
    ["scope", ["scope"], "completed-route"],
    ["forged hash", ["identity", "digest"], "f".repeat(64)],
  ] as const)("rejects plane route %s", (label, path, replacement) => {
    const payload = routeFixture();
    let parent = payload;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[path.at(-1)!] = replacement;
    if (label !== "forged hash") { const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, routeSchemaVersion); }
    expect(() => planeCompoundMutationState(routeCall, resultFor(payload), expected)).toThrow();
  });

  it("rejects route no-op and duplicate request deletion IDs", () => {
    const payload = routeFixture();
    payload.deletedItemIds = []; payload.addedTrackCount = 0;
    const { identity: _identity, ...body } = payload; payload.identity = canonicalIdentity(body, routeSchemaVersion);
    expect(() => planeCompoundMutationState({ ...routeCall, arguments: { ...routeCall.arguments, deleteItemIds: [], tracks: [] } }, resultFor(payload), expected)).toThrow();
    expect(() => planeCompoundMutationState({ ...routeCall, arguments: { ...routeCall.arguments, deleteItemIds: ["a", "a"] } }, resultFor(routeFixture()), expected)).toThrow();
  });
  it("accepts a bound plane result without relabeling literal NC quality; legacy rejects it", () => {
    const payload = fixture();
    expect(planeCompoundMutationState(call, resultFor(payload), expected)).toBe(true);
    expect(payload.upstreamMetrics).toMatchObject({ transferQuality: "DEGRADED", literalLines: ["Transfer quality: DEGRADED"] });
    expect(() => compoundMutationState(call, resultFor(payload), connectivityIdentity)).toThrow(/invalid host board-mutation/);
  });
  it("does not claim unrelated tool results", () => {
    expect(planeCompoundMutationState({ ...call, name: "pcb_get_board_summary" }, resultFor({}), expected)).toBeUndefined();
  });
  it("rejects nonempty sync arguments and invalid JSON", () => {
    expect(() => planeCompoundMutationState({ ...call, arguments: { force: true } }, resultFor(fixture()), expected)).toThrow(/empty-argument/);
    expect(() => planeCompoundMutationState(call, { toolCallId: call.id, content: "not JSON" }, expected)).toThrow(/invalid JSON/);
  });
  it.each([
    ["physical count", ["physicalPadCount"], 6],
    ["copper count", ["namedCopperPrimitiveCount"], 2],
    ["logical count", ["logicalTerminalCount"], 4],
    ["plated bound", ["platedFootprintHoleCount"], 5],
    ["logical upstream substitution", ["upstreamMetrics", "totalPadsConsidered"], 3],
    ["unknown upstream field", ["upstreamMetrics", "extra"], true],
    ["missing snapshot", ["nativePadSnapshotIdentity"], undefined],
    ["missing expected pads", ["physicalPadExpectedIdentity"], undefined],
    ["missing source contract", ["sourceContractIdentity"], undefined],
    ["wrong source contract", ["sourceContractIdentity", "digest"], "f".repeat(64)],
    ["wrong project", ["planeProjectBindingIdentity", "digest"], "f".repeat(64)],
    ["wrong connectivity", ["contractIdentity", "digest"], "f".repeat(64)],
    ["generic authority mix", ["genericProjectBindingIdentity"], projectBindingIdentity],
    ["old count mix", ["padCount"], 5],
    ["legacy version", ["schemaVersion"], "evleda.fresh-sync-from-schematic-result.v2"],
    ["premature placement acceptance", ["placementReview", "status"], "passed"],
    ["native parity false", ["nativeNetlistComparison", "equal"], false],
    ["mutation false", ["mutated"], false],
    ["forged identity", ["identity", "digest"], "f".repeat(64)],
  ] as const)("rejects %s even with coherent outer rehash", (label, path, replacement) => {
    const payload = fixture();
    let parent = payload;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    if (replacement === undefined) delete parent[path.at(-1)!]; else parent[path.at(-1)!] = replacement;
    if (label !== "forged identity") {
      const { identity: _identity, ...body } = payload;
      payload.identity = canonicalIdentity(body, schemaVersion);
    }
    expect(() => planeCompoundMutationState(call, resultFor(payload), expected)).toThrow();
  });
});
