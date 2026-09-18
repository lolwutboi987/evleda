import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { assertPcbChannelFeedThroughSources } from "../../src/harness/pcb-channel-feed-through.js";
import { assessDifferentialChannelGeometry } from "../../src/harness/differential-channel-geometry.js";
import { assessSavedInterface } from "../../src/harness/saved-interface-assessment.js";
import { channelMemberNets, channelTrackWidthAllowed } from "../../src/harness/pcb-channel-width.js";
import { summarizeSavedInterface } from "../../src/mcp/toolbox-interface-report.js";
import { getPcbPlaneDesignIntentModelGuide, PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES } from "../../src/harness/pcb-design-plane-model-guide.js";
import { assertPlaneIncrementalRouteGeometry } from "../../src/harness/fresh-plane-route-mutation.js";
import type { FreshContractPadPosition, FreshRouteSelectionItem } from "../../src/harness/kicad-tools.js";
import { cleanupDerivedPowerFixtures } from "../helpers/derived-power-bundle.js";
import { usbChannelBundle, usbChannelDependencies } from "../helpers/usb-channel-bundle.js";
import { usbChannelPcb, usbChannelTrackSource as track, usbChannelPadSource as pad } from "../helpers/usb-channel-source.js";
import { usbFeedThroughDraft, usbFeedThroughFixture, usbFeedThroughPcb, usbFeedThroughStock } from "../helpers/usb-feed-through-bundle.js";

afterEach(cleanupDerivedPowerFixtures);
const pairOf = (draft: Record<string, any>) => draft.interfaceRequirements.interfaces[0];
const length = (mm: number) => ({ twiceAxisNm: String(mm * 2_000_000), twiceDiagonalNm: "0" });
const assess = (bundle: ReturnType<typeof usbFeedThroughFixture>["bundle"], source = usbFeedThroughPcb()) => assessSavedInterface({ savedPcbBytes: Buffer.from(source), compilationBundle: bundle, interfaceId: "LINK" });

describe("explicit bounded source-inspected protection transfers", () => {
  it("closes six exact copper nets, retains every pin and round-trips with the same approved sources", () => {
    const f = usbFeedThroughFixture(), pair = f.bundle.contract.interfaceRequirements!.interfaces[0]!;
    expect(channelMemberNets(pair)).toEqual(["DP", "DN", "LP", "LN", "MP", "MN"]);
    const expected: Record<string, string[]> = { LP: ["R1:1", "U1:52"], LN: ["R2:1", "U1:51"], MP: ["D1:1", "R1:2"], MN: ["D1:3", "R2:2"], DP: ["D1:6", "J1:A6", "J1:B6"], DN: ["D1:4", "J1:A7", "J1:B7"] };
    for (const [net, keys] of Object.entries(expected)) expect(f.bundle.contract.nets.find(value => value.name === net)!.endpoints.map(point => `${point.reference}:${point.pin}`).sort()).toEqual(keys);
    expect(Object.values(expected).flat()).toHaveLength(14);
    expect(f.bundle.contract.components.find(value => value.reference === "D1")!.pins).toHaveLength(6);
    expect(f.bundle.executionGuidance).toContain("six distinct native copper nets");
    expect(f.bundle.executionGuidance).not.toContain("retains four signal nets");
    expect(() => assertPcbChannelFeedThroughSources(f.bundle.contract, f.bundle.libraryBinding, f.resolver)).not.toThrow();
    const bytes = serializePcbPlaneCompilationBundle(f.bundle);
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(bytes, f.dependencies))).toEqual(bytes);
    expect(channelTrackWidthAllowed(f.bundle.contract, "MP", 0.2)).toBe(true);
    expect(channelTrackWidthAllowed(f.bundle.contract, "MN", 0.199)).toBe(false);
  });
  it.each([
    ["omitted transfer", (d: any) => { delete pairOf(d).channel.feedThrough; }],
    ["collapsed input/output nets", (d: any) => { pairOf(d).channel.feedThrough.inputNets.positive = "DP"; }],
    ["unknown input net", (d: any) => { pairOf(d).channel.feedThrough.inputNets.positive = "MISSING"; }],
    ["wrong component", (d: any) => { pairOf(d).channel.feedThrough.componentReference = "U1"; }],
    ["second stage", (d: any) => { pairOf(d).channel.protection.push(structuredClone(pairOf(d).channel.protection[0])); }],
    ["same input/output pin", (d: any) => { pairOf(d).channel.feedThrough.positive.outputPin = "1"; }],
    ["crossed polarity pin", (d: any) => { pairOf(d).channel.feedThrough.positive.outputPin = "4"; }],
    ["undeclared transfer pin", (d: any) => { pairOf(d).channel.feedThrough.negative.inputPin = "99"; }],
    ["missing manufacturer source", (d: any) => { delete pairOf(d).channel.feedThrough.source; }],
    ["unqualified source kind", (d: any) => { pairOf(d).channel.feedThrough.source.kind = "verified_device"; }],
    ["invented package length", (d: any) => { pairOf(d).channel.feedThrough.lengthMm = 0; }],
    ["wrong protection ground", (d: any) => { pairOf(d).channel.protection[0].ground.net = "VBUS"; }],
    ["wrong protection supply", (d: any) => { pairOf(d).channel.protection[0].supply.net = "GND"; }],
    ["missing input reference coverage", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "MP").referencePath = { mode: "none" }; }],
    ["input via", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "MN").maxVias = 1; }],
    ["input on another layer", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "MP").preferredLayer = "B.Cu"; }],
  ])("rejects %s", (_name, mutate) => {
    const draft = usbFeedThroughDraft(); mutate(draft);
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
  });
  it.each(["feedThrough", "componentReference", "inputNets", "positive", "negative", "source"])("preserves unresolved %s without closing", field => {
    const draft = usbFeedThroughDraft(), channel = pairOf(draft).channel;
    if (field === "feedThrough") channel.feedThrough = null; else channel.feedThrough[field] = null;
    expect(() => parsePcbPlaneDesignIntentDraft(draft)).not.toThrow();
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
  });
  it("requires host source pin inspection, never reduced caller-supplied names", () => {
    const result = compilePcbPlaneDesignIntentDraft(usbFeedThroughDraft(), usbChannelDependencies);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some(issue => /source-pinned/u.test(issue.message))).toBe(true);
  });
  it.each([
    ["IO name mismatch", (s: string) => s.replace('(name "IO1")', '(name "OTHER")')],
    ["collapsed two-channel name", (s: string) => s.replaceAll('"IO2"', '"IO1"')],
    ["active IO type", (s: string) => s.replace('(symbol "ChannelProtection_1_1" (pin passive', '(symbol "ChannelProtection_1_1" (pin output')],
    ["wrong ground name", (s: string) => s.replaceAll('(name "GND")', '(name "OTHER_RETURN")')],
    ["passive supply", (s: string) => s.replace('(pin power_in line (at -3.81 10.16 0)', '(pin passive line (at -3.81 10.16 0)')],
  ])("rejects inspected %s", (_name, mutate) => {
    const stock = usbFeedThroughStock(mutate), result = compilePcbPlaneDesignIntentDraft(usbFeedThroughDraft(), stock.dependencies);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some(issue => /Feed-through|feed-through/u.test(issue.message))).toBe(true);
  });
  it("rejects raw source drift after compilation and during bundle reconstruction", () => {
    const f = usbFeedThroughFixture(), bytes = serializePcbPlaneCompilationBundle(f.bundle);
    writeFileSync(f.file, f.source + "\n", "utf8");
    expect(() => assertPcbChannelFeedThroughSources(f.bundle.contract, f.bundle.libraryBinding, f.resolver)).toThrow();
    expect(() => parsePcbPlaneCompilationBundle(bytes, f.dependencies)).toThrow();
  });
  it("rejects source drift occurring inside the added full-geometry inspection", () => {
    const f = usbFeedThroughStock(); let changed = false;
    const resolver = { resolveSymbol: f.resolver.resolveSymbol.bind(f.resolver), resolveFootprint: f.resolver.resolveFootprint.bind(f.resolver),
      captureSourceSelection: f.resolver.captureSourceSelection.bind(f.resolver), inspectSymbol: f.resolver.inspectSymbol.bind(f.resolver),
      inspectSymbolTerminalGeometry(libraryId: string) {
        const geometry = f.resolver.inspectSymbolTerminalGeometry(libraryId);
        if (libraryId === "Fixture:ChannelProtection" && !changed) { changed = true; writeFileSync(f.file, f.source + "\n", "utf8"); }
        return geometry;
      } };
    expect(compilePcbPlaneDesignIntentDraft(usbFeedThroughDraft(), { ...f.dependencies, libraryResolver: resolver }).disposition).toBe("needs_clarification");
    expect(changed).toBe(true);
  });
});

describe("six-net PCB geometry, package electrical behavior unassessed", () => {
  it("counts each section and branch once, keeps14 anchors, and exposes the unmodeled package transfer", async () => {
    const { bundle } = usbFeedThroughFixture(), result = await assess(bundle), channel = result.channel!;
    expect(result.sourceInventory).toMatchObject({ status: "complete", projectionComplete: true });
    expect([...new Set(result.sourceInventory.selected.tracks.map(t => t.net))].sort()).toEqual(["DN", "DP", "LN", "LP", "MN", "MP"]);
    expect(channel.anchors).toHaveLength(14); expect(channel.anchors.every(anchor => anchor.status === "pass")).toBe(true);
    expect(channel.feedThrough!.inputSection.routes.positive.mainLength).toEqual(length(3));
    expect(channel.receiverPaths.map(path => path.positiveEtchLength)).toEqual([length(8), length(11)]);
    expect(channel.copperEtchLength).toEqual({ positive: length(15), negative: length(15) });
    expect(channel.feedThrough!.downstreamPaths.map(path => path.positiveEtchLength)).toEqual([length(7), length(10)]);
    expect(channel.feedThrough!.componentTransfers).toHaveLength(2);
    for (const transfer of channel.feedThrough!.componentTransfers) expect(transfer).toMatchObject({ authority: "caller_asserted_component_transfer", pcbEtchContribution: "excluded_component_path",
      electricalDelay: "not_assessed", electricalSkew: "not_assessed", physicalInternalPath: "not_verified", pinMapping: { status: "pass" } });
    expect(result.referenceRequirements.memberNets).toEqual(["DP", "DN", "LP", "LN", "MP", "MN"]);
    expect(result.terminations.pins.find(pin => pin.reference === "R1" && pin.pin === "2")!.expectedNet).toBe("MP");
    expect(result.boardAccepted).toBe(false); expect(channel.accepted).toBe(false);
    const summary = summarizeSavedInterface(result);
    expect(JSON.stringify(summary)).toContain("excluded_component_path"); expect(JSON.stringify(summary)).toContain("inputSection");
  });
  it("enforces combined input/port budgets rather than testing the port segment alone", async () => {
    const { bundle } = usbFeedThroughFixture(), result = await assess(bundle), pair = structuredClone(bundle.contract.interfaceRequirements!.interfaces[0]!);
    Object.assign(pair.geometry, { maxEtchLengthMm: 8 });
    const combined = assessDifferentialChannelGeometry(pair, result.sourceInventory.selected, true);
    expect(combined.feedThrough!.inputSection.checks.length.status).toBe("pass");
    expect(combined.receiverPaths.every(path => path.geometry.checks.length.status === "pass")).toBe(true);
    expect(combined.feedThrough!.downstreamBudgets.length.status).toBe("fail"); expect(combined.checks.length.status).toBe("fail");
  });
  it("combines signed input/port imbalance before applying downstream and complete-channel skew limits", async () => {
    const { bundle } = usbFeedThroughFixture();
    const source = usbFeedThroughPcb()
      .replace(pad(53, "3", "MN", "5 1"), pad(53, "3", "MN", "4 1"))
      .replace(pad(54, "4", "DN", "6 1"), pad(54, "4", "DN", "5 1"))
      .replace(track(4, "MN", "2 1", "5 1"), track(4, "MN", "2 1", "4 1"))
      .replace(track(202, "DN", "6 1", "10 1"), track(202, "DN", "5 1", "10 1"))
      .replace(track(7, "DN", "6 1", "6 4"), track(7, "DN", "5 1", "5 4"))
      .replace(track(8, "DN", "6 4", "10 4"), track(8, "DN", "5 4", "10 4"));
    const captured = await assess(bundle, source), pair = structuredClone(bundle.contract.interfaceRequirements!.interfaces[0]!);
    Object.assign(pair.geometry, { maxEtchSkewMm: 0.1 }); Object.assign(pair.channel!, { maxEtchSkewMm: 0.1 });
    const result = assessDifferentialChannelGeometry(pair, captured.sourceInventory.selected, captured.sourceInventory.projectionComplete);
    expect(result.feedThrough!.inputSection.etchSkew).toEqual(length(1));
    expect(result.receiverPaths.map(path => path.geometry.etchSkew)).toEqual([length(1), length(1)]);
    expect(result.feedThrough!.downstreamPaths.map(path => path.etchSkew)).toEqual([length(0), length(0)]);
    expect(result.budgets.pathSkew.status).toBe("pass"); expect(result.checks.skew.status).toBe("pass");
  });
  it.each([
    ["disconnected input", (s: string) => s.replace(track(3, "MP", "2 0", "5 0"), "")],
    ["unwanted input-to-output copper", (s: string) => s.replace(track(3, "MP", "2 0", "5 0"), track(3, "MP", "2 0", "6 0"))],
    ["wrong output pad net", (s: string) => s.replace(pad(56, "6", "DP", "6 0"), pad(56, "6", "MP", "6 0"))],
  ])("rejects %s without inventing a package track", async (_name, mutate) => {
    const { bundle } = usbFeedThroughFixture(), result = await assess(bundle, mutate(usbFeedThroughPcb()));
    expect(result.channel!.checks.topology.status).not.toBe("pass");
    expect(result.boardAccepted).toBe(false);
  });
  it("retains middle-net escape, cross-section gap and via counterexamples", async () => {
    const { bundle } = usbFeedThroughFixture(), source = usbFeedThroughPcb();
    const narrow = await assess(bundle, source.replace(track(3, "MP", "2 0", "5 0"), track(3, "MP", "2 0", "5 0", "0.2")));
    expect(narrow.channel!.checks.width.status).toBe("fail");
    const close = await assess(bundle, source.slice(0, -1) + track(600, "MP", "6 0.4", "10 0.4") + ")");
    expect(close.channel!.checks.minimumGap.status).toBe("fail");
    const via = await assess(bundle, source.slice(0, -1) + '(via (at 4 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "MP") (uuid "33333333-3333-4333-8333-000000000259")))');
    expect(via.channel!.checks.transitions.status).toBe("fail");
  });
  it("keeps exact four-net bundle and saved assessment goldens unchanged", async () => {
    const bundle = usbChannelBundle(), result = await assessSavedInterface({ savedPcbBytes: Buffer.from(usbChannelPcb()), compilationBundle: bundle, interfaceId: "LINK" });
    expect(contentIdentity(serializePcbPlaneCompilationBundle(bundle))).toEqual({ algorithm: "sha256", digest: "1cb789797b2ce71bcf5b8365bc80cba40ca8ab223bd8814840bcb05ac71e9f71", size: 90673 });
    expect(contentIdentity(canonicalJson(result))).toEqual({ algorithm: "sha256", digest: "b40ffcb294999747782381674ae3e777a968a5717a2c9533bd80ac7470701970", size: 118011 });
    expect(result.channel).not.toHaveProperty("feedThrough");
  });
  it("offers bounded opt-in six-net guidance without changing the old channel guide", () => {
    const legacy = getPcbPlaneDesignIntentModelGuide(true, true, true, true), guide = getPcbPlaneDesignIntentModelGuide(true, true, true, true, true);
    expect(legacy).not.toContain("channel.feedThrough"); expect(guide).toContain("channel.feedThrough");
    expect(guide).toContain("Package delay/skew"); expect(Buffer.byteLength(guide)).toBeLessThanOrEqual(PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES);
  });
});

describe("qualified transfer-output fork without fabricated incoming copper", () => {
  it("permits the actual two outgoing45-degree-separated rays while preserving every ordinary corner rejection", () => {
    const contract = usbFeedThroughFixture().bundle.contract;
    const source: FreshContractPadPosition = { reference: "D1", pad: "6", net: "DP", xMm: 8.65, yMm: 11.0125, layers: ["F.Cu"],
      physical: { id: "qualified-output-pad", footprintId: "qualified-protection", padType: "smd", shape: "rect", sizeMm: { x: 0.6, y: 0.8 }, drill: null } };
    const item = (id: string, x: number, y: number, endX: number, endY: number): FreshRouteSelectionItem => ({ kind: "track", id, net: "DP", layer: "F.Cu", widthMm: 0.5, start: { xMm: x, yMm: y }, end: { xMm: endX, yMm: endY } });
    const tracks = [item("to-b6", 8.65, 11.0125, 8.65, 9.95), item("to-a6", 8.65, 11.0125, 9, 10.6625)];
    expect(() => assertPlaneIncrementalRouteGeometry(contract, "DP", tracks, [source])).not.toThrow();
    for (const pads of [[], [{ ...source, pad: "1" }], [{ ...source, net: "MP" }], [{ ...source, xMm: source.xMm + 0.000001 }], [{ ...source, physical: undefined }] as unknown as FreshContractPadPosition[]]) {
      expect(() => assertPlaneIncrementalRouteGeometry(contract, "DP", tracks, pads)).toThrow(/turn bound/u);
    }
    expect(() => assertPlaneIncrementalRouteGeometry(contract, "DP", [...tracks, item("bad-nearby-90", 8.65, 9.95, 7.65, 9.95)], [source])).toThrow(/turn bound/u);
    expect(() => assertPlaneIncrementalRouteGeometry(contract, "DP", [...tracks, item("reverse", 8.65, 9.95, 8.65, 10.5)], [source])).toThrow(/overlap/u);
  });
});
