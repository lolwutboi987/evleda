import { describe, expect, it } from "vitest";
import { channelTrackWidthAllowed, materializeChannelTrackWidth } from "../../src/harness/pcb-channel-width.js";
import { routeSourceMmToNativeNm } from "../../src/harness/fresh-route-native-units.js";
import { parsePlaneRouteMutationArguments } from "../../src/harness/fresh-plane-route-mutation.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { usbChannelBundle, usbChannelDraft } from "../helpers/usb-channel-bundle.js";

describe("explicit channel track width authorization", () => {
  it("preserves omitted class width and materializes explicit widths once in integer nm", () => {
    const contract = usbChannelBundle().contract;
    expect(materializeChannelTrackWidth(contract, "DP", 0.5)).toBe(500_000);
    expect(materializeChannelTrackWidth(contract, "DP", 0.5, 0.200000499999)).toBe(200_000);
    expect(materializeChannelTrackWidth(contract, "DP", 0.5, 0.2000015)).toBe(200_002);
    expect(materializeChannelTrackWidth(undefined, "OTHER", 0.5)).toBe(500_000);
    expect(() => materializeChannelTrackWidth(undefined, "OTHER", 0.5, 0.5)).toThrow(/Explicit track width/);
  });
  it("authorizes only member-local explicit intervals, retaining gaps between them", () => {
    const draft = usbChannelDraft();
    for (const escape of draft.interfaceRequirements.interfaces[0].channel.escapes) escape.traceWidthMm.maximumMm = 0.3;
    const contract = usbChannelBundle(draft).contract;
    expect(channelTrackWidthAllowed(contract, "DP", 0.5)).toBe(true);
    expect(channelTrackWidthAllowed(contract, "DP", 0.2)).toBe(true);
    expect(channelTrackWidthAllowed(contract, "DP", 0.199999)).toBe(false);
    expect(channelTrackWidthAllowed(contract, "DP", 0.35)).toBe(false);
    expect(channelTrackWidthAllowed(contract, "GND", 0.2)).toBe(false);
    expect(materializeChannelTrackWidth(contract, "GND", 0.5, 0.5)).toBe(500_000);
    expect(() => materializeChannelTrackWidth(contract, "DP", 0.5, 0.35)).toThrow(/interval/);
    expect(() => channelTrackWidthAllowed(contract, "DP", 0.2000001)).toThrow(/integer nanometre/);
  });
  it("permits wider ordinary power copper while retaining the exact existing class floor", () => {
    const draft = usbChannelDraft();
    draft.netClasses.find((netClass: { id: string }) => netClass.id === "POWER").traceWidthMm = 0.2;
    const contract = usbChannelBundle(draft).contract;
    expect(materializeChannelTrackWidth(contract, "VBUS", 0.2)).toBe(200_000);
    expect(materializeChannelTrackWidth(contract, "VBUS", 0.2, 0.2)).toBe(200_000);
    expect(materializeChannelTrackWidth(contract, "VBUS", 0.2, 0.800000499999)).toBe(800_000);
    expect(() => materializeChannelTrackWidth(contract, "VBUS", 0.2, 0.199999)).toThrow(/class floor/);
    expect(() => materializeChannelTrackWidth(contract, "VBUS", 0.2, 0.199999999999)).toThrow(/class floor/);
    expect(() => materializeChannelTrackWidth(contract, "VBUS", 0.1, 0.2)).toThrow(/exact bound/);
    expect(() => materializeChannelTrackWidth(contract, "VBUS", 0.2000000001, 0.8)).toThrow(/exact bound/);
    expect(() => materializeChannelTrackWidth(contract, "UNBOUND", 0.2, 0.8)).toThrow(/exact bound/);
  });
  it("keeps exact readback width units and does not round one-nm changes into compliance", () => {
    const contract = usbChannelBundle().contract, expected = materializeChannelTrackWidth(contract, "DP", 0.5, 0.2);
    expect(routeSourceMmToNativeNm(0.2)).toBe(expected);
    expect(routeSourceMmToNativeNm(0.200001)).not.toBe(expected);
    expect(routeSourceMmToNativeNm(0.199999)).not.toBe(expected);
    expect(() => routeSourceMmToNativeNm(0.2000001)).toThrow(/exact integer/);
  });
  it("parses the existing contract width range while channel authorization keeps its 0.2mm floor", () => {
    const args = { selectionIdentity: canonicalIdentity({}, "evleda.fresh-plane-route-selection.v1"), net: "DP", deleteItemIds: [],
      tracks: [{ x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 1, layer: "F.Cu", widthMm: 0.2 }], vias: [] };
    expect(parsePlaneRouteMutationArguments(args).tracks[0]!.widthMm).toBe(0.2);
    expect(parsePlaneRouteMutationArguments({ ...args, tracks: [{ ...args.tracks[0], widthMm: 0.199999 }] }).tracks[0]!.widthMm).toBe(0.199999);
    expect(() => materializeChannelTrackWidth(usbChannelBundle().contract, "DP", 0.5, 0.199999)).toThrow(/interval/u);
    expect(() => parsePlaneRouteMutationArguments({ ...args, tracks: [{ ...args.tracks[0], widthMm: 0.049999 }] })).toThrow();
    expect(() => parsePlaneRouteMutationArguments({ ...args, tracks: [{ ...args.tracks[0], terminalException: "U1:52" }] })).toThrow();
  });
  it("materializes an explicit ordinary .15mm class without lowering its class rule or any USB interval", () => {
    const draft = usbChannelDraft();
    draft.netClasses.find((value: { id: string }) => value.id === "POWER").traceWidthMm = 0.15;
    const contract = usbChannelBundle(draft).contract;
    const args = { selectionIdentity: canonicalIdentity({}, "evleda.fresh-plane-route-selection.v1"), net: "VBUS", deleteItemIds: [],
      tracks: [{ x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 1, layer: "F.Cu", widthMm: 0.15 }], vias: [] };
    for (const widthMm of [0.15, 0.20]) {
      const parsed = parsePlaneRouteMutationArguments({ ...args, tracks: [{ ...args.tracks[0], widthMm }] });
      expect(materializeChannelTrackWidth(contract, parsed.net, 0.15, parsed.tracks[0]!.widthMm)).toBe(widthMm * 1e6);
    }
    expect(materializeChannelTrackWidth(contract, "VBUS", 0.15)).toBe(150_000);
    expect(() => materializeChannelTrackWidth(contract, "VBUS", 0.15, 0.149999)).toThrow(/class floor/u);
    expect(() => materializeChannelTrackWidth(contract, "DP", 0.5, 0.15)).toThrow(/interval/u);
  });
});
