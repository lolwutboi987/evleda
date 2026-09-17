import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { closePcbPlaneDesignIntentDraft, normalizePcbPlaneUnresolvedPath, parsePcbPlaneDesignContract,
  parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle,
  serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";
import { usbChannelBundle, usbChannelDependencies, usbChannelDraft, usbChannelLibraryResolver } from "../helpers/usb-channel-bundle.js";

const pair = (draft: Record<string, any>) => draft.interfaceRequirements.interfaces[0];
const channel = (draft: Record<string, any>) => pair(draft).channel;
const route = (draft: Record<string, any>, net: string) => draft.routingConstraints.nets.find((entry: any) => entry.net === net);
const endpointKeys = (endpoints: readonly { reference: string; pin: string }[]) => endpoints.map(point => `${point.reference}:${point.pin}`).sort();

function removeContact(draft: Record<string, any>, reference: string, pin: string) {
  const componentPin = draft.components.find((component: any) => component.reference === reference).pins.find((entry: any) => entry.pin === pin);
  const net = draft.nets.find((entry: any) => entry.name === componentPin.assignment.net);
  componentPin.assignment = { kind: "no_connect" };
  net.endpoints = net.endpoints.filter((point: any) => point.reference !== reference || point.pin !== pin);
  route(draft, net.name).referencePath.terminalReferences = route(draft, net.name).referencePath.terminalReferences
    .filter((entry: any) => entry.signalEndpoint.reference !== reference || entry.signalEndpoint.pin !== pin);
}

function addUndeclaredTap(draft: Record<string, any>) {
  draft.components.push({ reference: "R3", symbolLibId: "Device:R", footprintLibId: "Resistor_SMD:R_0603_1608Metric", value: "100", unit: 1,
    pins: [{ pin: "1", assignment: { kind: "net", net: "DP" } }, { pin: "2", assignment: { kind: "net", net: "GND" } }] });
  draft.placementConstraints.push({ ...structuredClone(draft.placementConstraints.find((entry: any) => entry.reference === "R1")), reference: "R3" });
  draft.nets.find((net: any) => net.name === "DP").endpoints.push({ reference: "R3", pin: "1" });
  draft.nets.find((net: any) => net.name === "GND").endpoints.push({ reference: "R3", pin: "2" });
  route(draft, "DP").referencePath.terminalReferences.push({ signalEndpoint: { reference: "R3", pin: "1" }, referenceEndpoint: { reference: "R3", pin: "2" } });
}

describe("explicit bounded four-net USB-shaped channel contract", () => {
  it("closes exact launch and line membership, compiles and round-trips the complete bundle", () => {
    const draft = usbChannelDraft(), before = canonicalJson(draft);
    const compilation = compilePcbPlaneDesignIntentDraft(draft, usbChannelDependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    if (compilation.disposition !== "ready") throw new Error("Expected ready fictional channel");
    expect(canonicalJson(draft)).toBe(before);
    const contract = compilation.contract;
    for (const [net, endpoints] of Object.entries({
      LP: ["R1:1", "U1:52"], LN: ["R2:1", "U1:51"],
      DP: ["D1:1", "D1:6", "J1:A6", "J1:B6", "R1:2"],
      DN: ["D1:3", "D1:4", "J1:A7", "J1:B7", "R2:2"],
    })) {
      expect(endpointKeys(contract.nets.find(entry => entry.name === net)!.endpoints)).toEqual(endpoints);
      const memberRoute = contract.routingConstraints.nets.find(entry => entry.net === net)!;
      expect(memberRoute).toMatchObject({ preferredLayer: "F.Cu", maxVias: 0,
        referencePath: { mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu" } });
    }
    expect(contract.interfaceRequirements!.interfaces[0]!.channel).toMatchObject({ kind: "source_series",
      launchNets: { positive: "LP", negative: "LN" }, protection: [{ componentReference: "D1",
        positivePins: ["1", "6"], negativePins: ["3", "4"], ground: { pin: "2", net: "GND" }, supply: { pin: "5", net: "VBUS" } }] });
    expect(parsePcbPlaneDesignContract(structuredClone(contract))).toEqual(contract);
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Fictional channel round-trip", compilation }, usbChannelDependencies);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), usbChannelDependencies)).toEqual(bundle);
    expect(bundle).toMatchObject({ nativeAuthoringPerformed: false, acceptanceEvaluated: false, fabricationAuthorized: false, qualificationEstablished: false });
    expect(bundle.executionGuidance).toContain("four signal nets");
    expect(bundle.executionGuidance).toContain("Resistor and protection internals are not imaginary PCB segments");
  });

  it("resolves each fictional symbol and footprint against exactly its explicit pins", () => {
    const draft = usbChannelDraft();
    for (const component of draft.components) {
      expect(usbChannelLibraryResolver.resolveSymbol(component.symbolLibId)!.pins.map(pin => pin.number).sort())
        .toEqual(component.pins.map((pin: any) => pin.pin).sort());
      expect([...usbChannelLibraryResolver.resolveFootprint(component.footprintLibId)!.pads].sort())
        .toEqual(component.pins.map((pin: any) => pin.pin).sort());
    }
    expect(usbChannelLibraryResolver.resolveSymbol("Fixture:Missing")).toBeNull();
    expect(usbChannelLibraryResolver.resolveFootprint("Fixture:Missing")).toBeNull();
  });

  it("retains independent per-receiver path and total unique copper budgets", () => {
    const draft = usbChannelDraft();
    channel(draft).maxEtchLengthMm = 12;
    channel(draft).maxTotalCopperLengthMm = 24;
    const bundle = usbChannelBundle(draft);
    expect(bundle.contract.interfaceRequirements!.interfaces[0]!.channel)
      .toMatchObject({ maxEtchLengthMm: 12, maxTotalCopperLengthMm: 24 });
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), usbChannelDependencies)).toEqual(bundle);
  });

  it.each([
    ["collapsed launch net", (draft: any) => { channel(draft).launchNets.positive = "DP"; }, /four distinct signal nets/],
    ["unknown launch net", (draft: any) => { channel(draft).launchNets.positive = "MISSING"; }, /explicit signal net|exact declared/],
    ["swapped positive series pins", (draft: any) => { pair(draft).terminations.source.positive.sourcePin = "2"; pair(draft).terminations.source.positive.linePin = "1"; }, /exact declared polarity/],
    ["swapped negative series pins", (draft: any) => { pair(draft).terminations.source.negative.sourcePin = "2"; pair(draft).terminations.source.negative.linePin = "1"; }, /exact declared polarity/],
    ["missing B6 contact", (draft: any) => removeContact(draft, "J1", "B6"), /exact declared polarity/],
    ["missing B7 contact", (draft: any) => removeContact(draft, "J1", "B7"), /exact declared polarity/],
    ["wrong protection ground net", (draft: any) => { channel(draft).protection[0].ground.net = "VBUS"; }, /Protection ground/],
    ["wrong protection ground pin", (draft: any) => { channel(draft).protection[0].ground.pin = "5"; }, /Protection return anchor/],
    ["wrong protection supply net", (draft: any) => { channel(draft).protection[0].supply.net = "GND"; }, /Protection supply/],
    ["omitted protection signal pin", (draft: any) => {
      channel(draft).protection[0].positivePins = ["1"];
      channel(draft).escapes = channel(draft).escapes.filter((escape: any) => escape.terminal.reference !== "D1" || escape.terminal.pin !== "6");
    }, /undeclared taps/],
    ["repeated protection signal pin", (draft: any) => { channel(draft).protection[0].positivePins = ["1", "1", "6"]; }, /distinct/],
    ["undeclared tap", addUndeclaredTap, /undeclared taps/],
    ["launch on forbidden layer", (draft: any) => { route(draft, "LP").preferredLayer = "B.Cu"; }, /same exact allowed signal layer|same signal layer/],
    ["launch class forbids interface layer", (draft: any) => {
      draft.netClasses.push({ ...structuredClone(draft.netClasses.find((entry: any) => entry.id === "SIGNAL")), id: "LAUNCH", allowedLayers: ["B.Cu"] });
      draft.nets.find((entry: any) => entry.name === "LP").netClassId = "LAUNCH";
    }, /Channel allowed layer/],
    ["launch without reference coverage", (draft: any) => { route(draft, "LP").referencePath = { mode: "none" }; }, /continuous reference-plane/],
    ["launch uses wrong reference plane", (draft: any) => { route(draft, "LN").referencePath.planeId = "OTHER_PLANE"; }, /interface plane/],
    ["launch vias", (draft: any) => { route(draft, "LP").maxVias = 1; }, /forbid vias/],
    ["line routes with undeclared branches", (draft: any) => { route(draft, "DP").topology = "point_to_point"; }, /tree routing|exactly two endpoints/],
    ["escape below native width floor", (draft: any) => { channel(draft).escapes[0].traceWidthMm.minimumMm = 0.199; }, /at least 0.2 mm/],
    ["inverted escape width interval", (draft: any) => { channel(draft).escapes[0].traceWidthMm = { minimumMm: 0.5, maximumMm: 0.4 }; }, /ordered/],
    ["escape above body maximum", (draft: any) => { channel(draft).escapes[0].traceWidthMm.maximumMm = 0.7; }, /body maximum/],
    ["escape on ground terminal", (draft: any) => { channel(draft).escapes[0].terminal = { reference: "D1", pin: "2" }; }, /channel signal terminal/],
    ["duplicate escape", (draft: any) => { channel(draft).escapes.push(structuredClone(channel(draft).escapes[0])); }, /unique/],
    ["zero total copper budget", (draft: any) => { channel(draft).maxTotalCopperLengthMm = 0; }, /0.000001|0.000_001/],
  ] as const)("rejects %s without compiling a guessed topology", (_label, mutate, reason) => {
    const draft = usbChannelDraft(); mutate(draft);
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(reason);
    expect(compilePcbPlaneDesignIntentDraft(draft, usbChannelDependencies).disposition).not.toBe("ready");
  });

  it.each([
    ["launch nets", (draft: any) => { channel(draft).launchNets = null; }, "launchNets"],
    ["positive launch net", (draft: any) => { channel(draft).launchNets.positive = null; }, "launchNets/positive"],
    ["receivers", (draft: any) => { channel(draft).additionalReceivers = null; }, "additionalReceivers"],
    ["negative receiver", (draft: any) => { channel(draft).additionalReceivers[0].negative = null; }, "additionalReceivers/J1:B6/negative"],
    ["positive receiver", (draft: any) => { channel(draft).additionalReceivers[0].positive = null; }, "additionalReceivers/0/positive"],
    ["protection", (draft: any) => { channel(draft).protection = null; }, "protection"],
    ["escapes", (draft: any) => { channel(draft).escapes = null; }, "escapes"],
    ["escape routed length", (draft: any) => { channel(draft).escapes[0].maximumRoutedLengthMm = null; }, "escapes/R1:2/maximumRoutedLengthMm"],
    ["launch length", (draft: any) => { channel(draft).maximumLaunchEtchLengthMm = null; }, "maximumLaunchEtchLengthMm"],
    ["branch length", (draft: any) => { channel(draft).maximumBranchEtchLengthMm = null; }, "maximumBranchEtchLengthMm"],
    ["receiver path length", (draft: any) => { channel(draft).maxEtchLengthMm = null; }, "maxEtchLengthMm"],
    ["total unique copper length", (draft: any) => { channel(draft).maxTotalCopperLengthMm = null; }, "maxTotalCopperLengthMm"],
    ["skew", (draft: any) => { channel(draft).maxEtchSkewMm = null; }, "maxEtchSkewMm"],
    ["source", (draft: any) => { channel(draft).source = null; }, "source"],
    ["source citation", (draft: any) => { channel(draft).source.reference = null; }, "source/reference"],
  ] as const)("asks a stable question for unknown %s before consulting libraries", (_label, mutate, suffix) => {
    const draft = usbChannelDraft(); mutate(draft);
    const resolver = { resolveSymbol: vi.fn(() => null), resolveFootprint: vi.fn(() => null) };
    const result = compilePcbPlaneDesignIntentDraft(draft, { ...usbChannelDependencies, libraryResolver: resolver });
    expect(result.disposition, JSON.stringify(result.issues)).toBe("needs_clarification");
    expect(result.questions).toContainEqual(expect.objectContaining({ path: `/interfaceRequirements/interfaces/LINK/channel/${suffix}` }));
    expect(resolver.resolveSymbol).not.toHaveBeenCalled();
    expect(resolver.resolveFootprint).not.toHaveBeenCalled();
  });

  it("normalizes channel arrays to semantic paths and preserves identity across permutations", () => {
    const draft = usbChannelDraft(), baseline = closePcbPlaneDesignIntentDraft(draft);
    draft.components.reverse(); draft.nets.reverse(); draft.routingConstraints.nets.reverse(); draft.placementConstraints.reverse();
    for (const component of draft.components) component.pins.reverse();
    for (const net of draft.nets) net.endpoints.reverse();
    for (const member of draft.routingConstraints.nets) member.referencePath?.terminalReferences.reverse();
    channel(draft).protection[0].positivePins.reverse(); channel(draft).protection[0].negativePins.reverse(); channel(draft).escapes.reverse();
    expect(closePcbPlaneDesignIntentDraft(draft).identity).toEqual(baseline.identity);
    for (const [numeric, keyed] of [
      ["additionalReceivers/0/negative", "additionalReceivers/J1:B6/negative"],
      ["protection/0/ground/net", "protection/D1/ground/net"],
      ["escapes/0/traceWidthMm/minimumMm", `escapes/${channel(draft).escapes[0].terminal.reference}:${channel(draft).escapes[0].terminal.pin}/traceWidthMm/minimumMm`],
    ]) {
      const path = `/interfaceRequirements/interfaces/LINK/channel/${keyed}`;
      draft.unresolved = [{ path: `/interfaceRequirements/interfaces/0/channel/${numeric}`, question: "Confirm explicit channel value." }];
      const parsed = parsePcbPlaneDesignIntentDraft(draft);
      expect(parsed.unresolved[0]!.path).toBe(path);
      expect(normalizePcbPlaneUnresolvedPath(parsed, path)).toBe(path);
      draft.unresolved.push({ path, question: "Duplicate keyed alias." });
      expect(() => parsePcbPlaneDesignIntentDraft(draft)).toThrow(/duplicated/);
    }
  });

  it("requires every present channel field and does not infer a channel for old source-series intent", () => {
    const complete = usbChannelDraft();
    for (const field of Object.keys(channel(complete))) {
      const draft = usbChannelDraft(); delete channel(draft)[field];
      expect(() => closePcbPlaneDesignIntentDraft(draft), field).toThrow();
      expect(compilePcbPlaneDesignIntentDraft(draft, usbChannelDependencies).disposition, field).not.toBe("ready");
      expect(Object.hasOwn(channel(draft), field), field).toBe(false);
    }
    const omitted = usbChannelDraft(); delete pair(omitted).channel;
    const compilation = compilePcbPlaneDesignIntentDraft(omitted, usbChannelDependencies);
    expect(compilation.disposition).toBe("unsupported");
    expect(compilation.issues).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_INTERFACE_TOPOLOGY" }));
    expect(Object.hasOwn(pair(omitted), "channel")).toBe(false);
  });

  it("rejects channel tampering even if only the outer bundle identity is recomputed", () => {
    const bundle = usbChannelBundle(), forged = structuredClone(bundle);
    const alteredChannel = forged.contract.interfaceRequirements!.interfaces[0]!.channel!;
    Reflect.set(alteredChannel, "maximumBranchEtchLengthMm", alteredChannel.maximumBranchEtchLengthMm + 1);
    const { identity: _identity, ...payload } = forged;
    const resigned = { ...payload, identity: canonicalIdentity(payload, bundle.schemaVersion) };
    expect(() => parsePcbPlaneCompilationBundle(resigned, usbChannelDependencies)).toThrow(/reconstruction/);
  });

  it("preserves the captured HEAD identity with interface intent present and channel omitted", () => {
    // Captured by git archive of 8fa120343111107763433c7204bdbdbc240fc609 and running its
    // own interfaceConstructionDraft() and closePcbPlaneDesignIntentDraft() in an isolated temporary tree.
    const contract = closePcbPlaneDesignIntentDraft(interfaceConstructionDraft());
    expect(contract.interfaceRequirements).toBeDefined();
    expect(Object.hasOwn(contract.interfaceRequirements!.interfaces[0]!, "channel")).toBe(false);
    expect(contract.identity).toEqual({ algorithm: "sha256",
      digest: "6ef53cf0b02c995dc949fad016658dc830b511a4faceaf91f37665856bb19a5f",
      schemaVersion: "evleda.pcb-design-contract.v2", canonicalizationVersion: "evleda-c14n-json-v1" });
  });
});
