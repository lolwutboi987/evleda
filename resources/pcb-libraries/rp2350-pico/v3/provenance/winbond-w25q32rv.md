# W25Q32RVXHJQ symbol and XH footprint

Reviewed 2026-09-17 against [Winbond W25Q32RV Rev. E, 2025-11-13](https://www.winbond.com/resource-files/W25Q32RV_SPI_QPI%20RevE%2011132025%20Plus.pdf), printed pp.5-6,77,80-81 (PDF pages6-7,78,81-82). Local PDF identity is in `source-identities.json`; no manufacturer PDF is redistributed.

The exact part is 32 Mbit / 4 MiB, 2.7-3.6V; J is -40 to +105 C and Q fixes QE=1. Pins3/7 therefore use IO2/IO3, not selectable WP/HOLD/RESET names. XH is listed as special order; source recognition does not establish availability.

| Vendor terminal | Function | Local electrical type |
| --- | --- | --- |
| 1 | active-low CS | input |
| 2 | IO1 | bidirectional |
| 3 | IO2 | bidirectional |
| 4 | VSS | power_in |
| 5 | IO0 | bidirectional |
| 6 | CLK | input |
| 7 | IO3 | bidirectional |
| 8 | VCC | power_in |
| CAD9 (not a vendor pin number) | center metal | passive |

The manufacturer numbers eight signal/supply terminals. The center metal has no internal electrical connection and may float or connect to device GND. This board explicitly chooses GND for CAD9, separately from VSS4; no component-internal copper tie is assumed. The symbol has nine visible, separate terminals and no inheritance. Avoid exposed PCB vias under the center metal as specified by Winbond.

## Package dimensions and orientation

The drawing names the package 2x3x0.4mm. With pins1-4 down the left and8-5 down the right, its nominal X/Y body is **3.0 x 2.0mm**, not 2.0 x 3.0mm: E=3.0 horizontal and D=2.0 vertical. Pitch e=0.50mm; nominal contact length L=0.45mm, width b=0.25mm; center metal E2=0.20mm by D2=1.60mm. Contact centers inferred from that nominal drawing are x=+/-1.275mm, y=-0.75,-0.25,+0.25,+0.75mm. These are package-contact dimensions, not a recommended PCB land drawing.

## PCB lands

The native footprint is a renamed, locally self-contained adaptation of the installed KiCad footprint `Winbond_USON-8-1EP_3x2mm_P0.5mm_EP0.2x1.6mm`, whose source identity is retained. Geometry and physical pad properties are unchanged; the name/value/description identify this selected part, value is hidden and the external 3D-model reference is removed. Source/license are detailed in `kicad-winbond-land.md` and `KiCad-Libraries-LICENSE.md`.

The source lands are roundrect 0.90x0.25mm at x=+/-1.425mm and the four y positions above; corner ratio0.25. Relative to nominal contacts this adds 0.375mm outward and0.075mm inward length, with no nominal side extension. Numbering agrees with the vendor top view. CAD9 is rectangular 0.20x1.60mm at origin, on copper/mask, with inherited direct zone connection and thermal-pad property; neither property establishes a vendor internal GND connection. Its separate unnumbered paste aperture is a 0.16x1.29mm roundrect with ratio0.25 (about64% area coverage). No unnumbered copper pad exists.

**The PCB lands are KiCad-derived candidate lands, not a Winbond recommended land pattern.** Comparison confirms the nominal package, contact pitch/order and center metal, but does not qualify the KiCad land pattern across part tolerances or an assembly process. Keep paste/mask capability, 0.25mm side-pad width versus b up to0.30mm, center-pad stencil release, solder joints, assembly clearance and exact-part procurement as open reviews. No native board or manufacturing release is created.
