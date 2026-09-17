import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createPcbPlaneCompilationBundleRef, verifyPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { assessSavedInterface, type SavedInterfaceAssessment } from "../../src/harness/saved-interface-assessment.js";
import { summarizeSavedInterface } from "../../src/mcp/toolbox-interface-report.js";
import { usbChannelBundle, usbChannelDraft } from "../helpers/usb-channel-bundle.js";

import { usbChannelPcb as pcb, usbChannelSourceId as id, usbChannelTrackSource as track } from "../helpers/usb-channel-source.js";

const length = (mm: number) => ({ twiceAxisNm: String(mm * 2_000_000), twiceDiagonalNm: "0" });
const bundle = usbChannelBundle();
const assess = (source = pcb()) => assessSavedInterface({ savedPcbBytes: Buffer.from(source), compilationBundle: bundle, interfaceId: "LINK" });
function reidentify(value: SavedInterfaceAssessment): SavedInterfaceAssessment {
  const { identity: _identity, ...payload } = value;
  return { ...payload, identity: canonicalIdentity(payload, value.schemaVersion) };
}

describe("saved USB source-series channel evidence", () => {
  it("retains all four signal nets, every protection I/O, and both return mappings from exact saved bytes", async () => {
    const source = pcb(), result = await assess(source);
    expect(result.sourceIdentity).toEqual(contentIdentity(source));
    expect(result.bundleIdentity).toEqual(bundle.identity);
    expect(result.requirementIdentity).toEqual(canonicalIdentity(bundle.contract.interfaceRequirements!.interfaces[0], "evleda.saved-interface-requirement.v1"));
    expect(result.sourceInventory).toMatchObject({ status: "complete", projectionComplete: true });
    expect(result.sourceInventory.selected.tracks).toHaveLength(8);
    expect(result.sourceInventory.selected.pads).toHaveLength(16);
    expect(result.sourceInventory.observations).toHaveLength(24);
    expect([...new Set(result.sourceInventory.selected.tracks.map(track => track.net))].sort()).toEqual(["DN", "DP", "LN", "LP"]);
    expect(result.sourceInventory.selected.pads.filter(pad => pad.reference === "D1").map(pad => pad.pad).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(result.channel!.anchors).toHaveLength(14);
    expect(result.channel!.anchors.every(anchor => anchor.status === "pass")).toBe(true);
    expect(result.channel!.protectionReturns).toEqual([
      { reference: "D1", pin: "2", expectedNet: "GND", matchingPadUuids: [id(52)], status: "pass" },
      { reference: "D1", pin: "5", expectedNet: "VBUS", matchingPadUuids: [id(55)], status: "pass" },
    ]);
    expect(result.geometry!.checks.topology.status).toBe("pass");
    expect(result.channel!.receiverPaths.map(path => [path.positiveEtchLength, path.negativeEtchLength, path.etchSkew])).toEqual([
      [length(9), length(9), length(0)], [length(12), length(12), length(0)],
    ]);
    expect(result.channel!.copperEtchLength).toEqual({ positive: length(16), negative: length(16) });
    expect(result.referenceRequirements.memberNets).toEqual(["DP", "DN", "LP", "LN"]);
    expect(result.terminations).toMatchObject({ status: "matched_source_facts", resistanceVerification: "caller_assertion_only", deviceInternalTermination: "not_verified" });
    expect(result).toMatchObject({ nativeReachability: "not_evaluated", libraryMembership: "not_verified", boardAccepted: false, interfaceAccepted: false, fabricationAuthorized: false });
    expect(result.channel!.accepted).toBe(false);
    expect(result.impedance.completeRouteModelCoverage).toBe(false);
    const { identity, ...payload } = result;
    expect(identity).toEqual(canonicalIdentity(payload, result.schemaVersion));
    expect(Object.isFrozen(result.channel!.receiverPaths)).toBe(true);
  });

  it.each([
    ["truncated root", () => pcb().slice(0, -1)],
    ["nested launch copper", () => pcb({ extra: `(group ${track(400, "LP", "0 0", "0 -1")})` })],
    ["line arc", () => pcb({ extra: `(arc (start 6 0) (mid 7 -1) (end 8 0) (width 0.5) (layer "F.Cu") (net "DP") (uuid "${id(400)}"))` })],
    ["duplicate launch UUID", () => pcb({ extra: track(1, "LP", "0 -2", "1 -2") })],
  ] as const)("withholds complete channel facts for %s", async (_name, makeSource) => {
    const result = await assess(makeSource());
    expect(result.sourceInventory.status).toBe("unsupported");
    expect(result.sourceInventory.projectionComplete).toBe(false);
    expect(result.geometry === null || result.geometry.checks.topology.status === "not_assessed").toBe(true);
    if (result.channel) {
      expect(result.channel.inventoryComplete).toBe(false);
      expect(result.channel.checks.topology.status).toBe("not_assessed");
      expect(result.channel.receiverPaths.every(path => path.positiveEtchLength === null && path.negativeEtchLength === null && path.etchSkew === null)).toBe(true);
    }
    expect(result.boardAccepted).toBe(false);
    expect(result.interfaceAccepted).toBe(false);
  });

  it("retains an unsupported protection pad observation and preserves only independent local failures", async () => {
    const result = await assess(pcb({ protectionShape: "custom", launchWidth: "0.1" }));
    expect(result.sourceInventory).toMatchObject({ status: "unsupported", projectionComplete: false });
    expect(result.sourceInventory.observations).toContainEqual(expect.objectContaining({ kind: "pad", uuid: id(56), net: "DP", status: "unsupported" }));
    expect(result.sourceInventory.selected.tracks).toHaveLength(8);
    expect(result.channel!.checks.width.status).toBe("fail");
    expect(result.geometry!.checks.width.status).toBe("fail");
    expect(result.channel!.checks.topology.status).toBe("not_assessed");
    expect(result.channel!.checks.length.status).toBe("not_assessed");
    expect(result.channel!.receiverPaths.every(path => path.positiveEtchLength === null && path.negativeEtchLength === null)).toBe(true);
    expect(result.channel!.protectionReturns.every(anchor => anchor.status === "not_assessed")).toBe(true);
  });

  it.each([
    ["ground", { protectionGroundNet: "VBUS" }, "2", "GND"],
    ["supply", { protectionSupplyNet: "GND" }, "5", "VBUS"],
  ] as const)("fails saved protection %s mapping without dropping the misassigned pad", async (_role, options, pin, expectedNet) => {
    const result = await assess(pcb(options));
    expect(result.sourceInventory.status).toBe("complete");
    expect(result.sourceInventory.selected.pads).toHaveLength(16);
    expect(result.channel!.protectionReturns).toContainEqual(expect.objectContaining({ reference: "D1", pin, expectedNet, status: "fail" }));
    expect(result.geometry!.checks.topology).toEqual({ status: "fail", reasons: ["PROTECTION_RETURN_MAPPING_MISMATCH"] });
    expect(result.channel!.checks.topology).toEqual(result.geometry!.checks.topology);
    expect(result.interfaceAccepted).toBe(false);
  });

  it("rejects copied bundles and stale exact bundle references", async () => {
    await expect(assessSavedInterface({ savedPcbBytes: Buffer.from(pcb()), compilationBundle: structuredClone(bundle), interfaceId: "LINK" })).rejects.toThrow(/authenticated/);
    const reference = createPcbPlaneCompilationBundleRef(bundle), changed = usbChannelDraft();
    changed.interfaceRequirements.interfaces[0].channel.maxEtchLengthMm += 1;
    const changedBundle = usbChannelBundle(changed);
    expect(() => verifyPcbPlaneCompilationBundleRef(reference, changedBundle)).toThrow(/exact authenticated bundle/);
    expect(verifyPcbPlaneCompilationBundleRef(reference, bundle)).toEqual(reference);
  });

  it("captures source bytes before the caller can mutate its buffer", async () => {
    const source = pcb(), bytes = Buffer.from(source);
    const pending = assessSavedInterface({ savedPcbBytes: bytes, compilationBundle: bundle, interfaceId: "LINK" });
    bytes.fill(0);
    const result = await pending;
    expect(result.sourceIdentity).toEqual(contentIdentity(source));
    expect(result.sourceInventory.status).toBe("complete");
    expect(result.channel!.receiverPaths[1]!.positiveEtchLength).toEqual(length(12));
  });

  it("projects complete channel evidence while sanitizing nested diagnostics and excluding private fields", async () => {
    const result = await assess(), raw = structuredClone(result) as any;
    raw.channel.privateSavedSource = "(kicad_pcb PRIVATE_SOURCE_TOKEN)";
    raw.channel.launch.diagnostics.push("C:/private/board.kicad_pcb");
    raw.channel.receiverPaths[1].geometry.routes.positive.reasons.push("Saved form (segment (start 0 0) (end 1 0))");
    const report = summarizeSavedInterface(reidentify(raw));
    expect(report.channel!.receiverPaths).toHaveLength(2);
    expect(report.channel!.anchors).toHaveLength(14);
    expect(report.channel!.protectionReturns).toHaveLength(2);
    expect(report.channel!.receiverPaths.map(path => path.positiveEtchLength)).toEqual([length(9), length(12)]);
    expect(report.channel!.copperEtchLength).toEqual({ positive: length(16), negative: length(16) });
    expect(report.channel!.launch.diagnostics.at(-1)).toBe("Private diagnostic detail retained in the complete assessment.");
    expect(report.channel!.receiverPaths[1]!.geometry.routes.positive.reasons.at(-1)).toBe("Private diagnostic detail retained in the complete assessment.");
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SOURCE_TOKEN|C:\/private|\(kicad_pcb|\(segment/);
    expect(report).toMatchObject({ nativeReachability: "not_evaluated", libraryMembership: "not_verified", boardAccepted: false, interfaceAccepted: false, fabricationAuthorized: false });
    expect(report.channel!.accepted).toBe(false);
    expect(report.channel!.launch.accepted).toBe(false);
    expect(report.channel!.receiverPaths.every(path => path.geometry.accepted === false)).toBe(true);
  });

  it("rejects a stale assessment identity after receiver-path findings change", async () => {
    const raw = structuredClone(await assess()) as any;
    raw.channel.receiverPaths[1].positiveEtchLength.twiceAxisNm = "1";
    expect(() => summarizeSavedInterface(raw)).toThrow(/complete source-bound public report/);
  });

  it.each(["channel", "launch", "receiver"])("rejects invented %s acceptance even with a recomputed identity", async scope => {
    const raw = structuredClone(await assess()) as any;
    if (scope === "channel") raw.channel.accepted = true;
    if (scope === "launch") raw.channel.launch.accepted = true;
    if (scope === "receiver") raw.channel.receiverPaths[1].geometry.accepted = true;
    expect(() => summarizeSavedInterface(reidentify(raw))).toThrow(/complete source-bound public report/);
  });
});
