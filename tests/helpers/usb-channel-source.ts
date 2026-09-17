/** Synthetic saved source for software tests only; no physical or native authority. */
export const usbChannelSourceId = (value: number) => `33333333-3333-4333-8333-${value.toString(16).padStart(12, "0")}`;
export const usbChannelTrackSource = (uuid: number, net: string, start: string, end: string, width = "0.5") =>
  `(segment (start ${start}) (end ${end}) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${usbChannelSourceId(uuid)}"))`;
export const usbChannelPadSource = (uuid: number, pin: string, net: string, at: string, shape = "rect") =>
  `(pad "${pin}" smd ${shape} (at ${at}) (size 0.5 0.5) (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${usbChannelSourceId(uuid)}"))`;
const footprint = (uuid: number, reference: string, pads: readonly string[]) => {
  const libraryId = reference === "U1" ? "Fixture:ChannelSource" : reference === "J1" ? "Fixture:UsbContacts"
    : reference === "D1" ? "Fixture:ChannelProtection" : "Resistor_SMD:R_0603_1608Metric";
  const value = reference.startsWith("R") ? "22" : `FICTIONAL_${reference}`;
  return `(footprint "${libraryId}" (layer "F.Cu") (at 0 0) (uuid "${usbChannelSourceId(uuid)}") (property "Reference" "${reference}") (property "Value" "${value}") ${pads.join("\n")})`;
};
export interface UsbChannelSourceOptions { extra?: string; protectionGroundNet?: string; protectionSupplyNet?: string; protectionShape?: string; launchWidth?: string }
export function usbChannelPcb(options: UsbChannelSourceOptions = {}) {
  const footprints = [
    footprint(10, "U1", [usbChannelPadSource(11, "52", "LP", "0 0"), usbChannelPadSource(12, "51", "LN", "0 1"), usbChannelPadSource(13, "1", "GND", "0 2")]),
    footprint(20, "R1", [usbChannelPadSource(21, "1", "LP", "1 0"), usbChannelPadSource(22, "2", "DP", "2 0")]),
    footprint(30, "R2", [usbChannelPadSource(31, "1", "LN", "1 1"), usbChannelPadSource(32, "2", "DN", "2 1")]),
    footprint(40, "J1", [usbChannelPadSource(41, "A6", "DP", "10 0"), usbChannelPadSource(42, "A7", "DN", "10 1"),
      usbChannelPadSource(43, "B6", "DP", "10 -3"), usbChannelPadSource(44, "B7", "DN", "10 4"), usbChannelPadSource(45, "A1", "GND", "10 5"), usbChannelPadSource(46, "A4", "VBUS", "10 6")]),
    footprint(50, "D1", [usbChannelPadSource(51, "1", "DP", "5 0"), usbChannelPadSource(56, "6", "DP", "6 0", options.protectionShape),
      usbChannelPadSource(53, "3", "DN", "5 1"), usbChannelPadSource(54, "4", "DN", "6 1"),
      usbChannelPadSource(52, "2", options.protectionGroundNet ?? "GND", "5.5 2"), usbChannelPadSource(55, "5", options.protectionSupplyNet ?? "VBUS", "5.5 -1")]),
  ];
  return `(kicad_pcb (version 20260206) (general (thickness 1.57))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (15 "B.Paste" user))
    (setup (stackup (layer "F.Mask" (type "Top Solder Mask") (thickness 0)) (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "core") (thickness 1.5) (material "fixture laminate") (epsilon_r 4) (loss_tangent 0.02))
      (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0)) (copper_finish "fixture bare copper")))
    ${footprints.join("\n")}
    ${usbChannelTrackSource(1, "LP", "0 0", "1 0", options.launchWidth)} ${usbChannelTrackSource(2, "LN", "0 1", "1 1")}
    ${usbChannelTrackSource(3, "DP", "2 0", "10 0")} ${usbChannelTrackSource(4, "DN", "2 1", "10 1")}
    ${usbChannelTrackSource(5, "DP", "6 0", "6 -3")} ${usbChannelTrackSource(6, "DP", "6 -3", "10 -3")}
    ${usbChannelTrackSource(7, "DN", "6 1", "6 4")} ${usbChannelTrackSource(8, "DN", "6 4", "10 4")}
    (zone (net "GND") (layer "B.Cu") (uuid "${usbChannelSourceId(100)}") (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
      (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy -2 -5) (xy 12 -5) (xy 12 8) (xy -2 8))))
    ${options.extra ?? ""})`;
}
