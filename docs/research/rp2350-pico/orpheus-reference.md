# Orpheus Pico reference for an original RP2350 board

Reviewed 2026-09-16. This is a source inspection and design-input note, not electrical, manufacturing, or license clearance. No native project was opened, changed, or built. The downloaded reference is isolated outside the EvlEDA repository.

## Reference identity and reuse boundary

Use [hackclub/orpheus-pico][repo] as the current Hack Club reference. Its README calls the board **Orpheus Pico 2**, but its schematic, PCB, and BOM all specify **RP2040**, not RP2350. The inspected main-branch snapshot is **05783d768ec096b691b0abdcdfd95991eee68c41**, committed 2026-05-23 UTC. GitHub identifies this repository as a fork of [mpkendall/orph-pico-reloaded][parent]; that parent's current main was 98f7b70bd9497a834703dc6e6f991b0093c0f751 when checked.

The PCB silkscreen says "Orpheus Pico 2 v1.0" while the schematic title block retains revision 1v2 and date 2025-03-12. Use the commit identity, not those inconsistent human-readable revision fields, to identify the inspected design. Both native source files last changed in commit 846eecd880cc291645225f771f0db9994ba9d460 (2026-04-23); production/bom.csv last changed in 78bd27946d431f8d7f0ff18baaa333762f8eebff (2026-03-09). The manufacturing outputs were not regenerated or proven to match the newer native snapshot. [PCB][pcb], [schematic][sch], [BOM][bom].

Licensing findings from the actual repositories:

- Current hackclub/orpheus-pico and its mpkendall parent have no tracked LICENSE, COPYING, or NOTICE file identified, and GitHub reports no detected license. The current README provides ordering instructions but no explicit general license grant.
- The older [adammakesthingsdev/Orpheus-Pico-Kicad README][legacy] at 9c5451decb336d425bbfbb709049df61477aa0eb says a formal license is still to be chosen. It permits inspiration/derivatives and noncommercial board orders, prohibits selling those boards even at cost, and requests retained author attribution.
- The separate [adammakesthingsdev/Orpheus-Pico license][legacy-license] at 96bd3ba6422bc2cdfc4ec7e630d72926cc687f72 is a temporary custom license for that repository's digital material, allowing noncommercial use with credit. Do not assume it automatically licenses later hardware contributions in a different repository.

**Decision:** learn the circuit choices below and create original RP2350 schematic/layout work from component documentation. Do not import Orpheus schematic/PCB files, custom footprints, artwork, logo, photos, or production outputs into the new design under an assumed permissive license. Direct asset reuse would need separately established permission and attribution terms. This review did not contact any authors.

## Circuit facts and implications

The table reports saved source properties and pad-net assignments, cross-checked against BOM values. It does not establish routed continuity or physical behavior.

| Area | Observed Orpheus implementation | Implication for RP2350 work |
|---|---|---|
| MCU | U1 RP2040; QFN-56 plus exposed ground pad, 7 x 7 mm, 0.4 mm pitch. LCSC C2040. IOVDD, USB_VDD, ADC_AVDD, and VREG_IN use +3V3; VREG_VOUT supplies the +1V1 net and DVDD pins. | Preserve the compact development-board concept. Rebuild the RP2350 power, core-regulator, pin mapping, decoupling, and package design from the selected RP2350 variant's documentation. The RP2040 circuit is not an interchangeable MCU template. |
| USB receptacle | J1 uses a USB 2.0 Type-C symbol with both D+ contacts tied and both D- contacts tied. Footprint name USB-C-SMD_TYPE-C-6PIN-2MD-073; BOM C2765186. Shell pads go to GND. CC1 and CC2 each have their own 5.1 kohm resistor to GND (R5/R6). | Carry forward USB-C device convenience and separate CC pull-downs. The misleading "6PIN" footprint name is not sufficient connector qualification; confirm a complete manufacturer part and pin drawing before selecting it. No USB-PD controller is present. |
| USB protection and data | U3 is labeled USBLC6-2SC6, SOT-23-6, BOM C5180249. VBUS/GND connect to its clamp rails; D+/D- pass through the paired protection terminals and then R3/R4, 33 ohms each, to U1 USB_DP/USB_DM. | Retain low-capacitance ESD protection as a candidate feature. Check the exact sourced device, RP2350 termination requirements, placement, and return path; this reference does not verify a new board's USB interface. |
| Main power path | J1 VBUS and J3.1 share VBUS. D1 1N5819WS (C191023) has its anode on VBUS and cathode on +5V. J3.2 exposes that +5V net at the Pico VSYS position. U5 input is +5V, output +3V3, ground GND. | The topology isolates the USB source through a Schottky diode. The net named +5V is diode-fed and is not a regulated 5 V output. Define the new board's allowed external supply range, backfeed behavior, and current budget explicitly. |
| 3.3 V regulator | U5 is generically named XC6206PxxxMR, SOT-23-3, BOM C5446; the source does not provide a complete manufacturer ordering code. C18 is 1 uF input bypass; C17 is 1 uF output bypass. No regulator enable pin exists in this source symbol. | Do not carry forward a "high-current" or "does not overheat" rating from the README. Qualify an exact 3.3 V regulator for RP2350, LED, flash, and external loads, including package thermal behavior. |
| Flash | U2 W25Q16JVUXIQ (C2843335), 3 V, 16 Mbit = 2 MiB, USON-8 plus exposed pad, 3 x 2 mm. Six QSPI signals run directly to U1; VCC is +3V3, GND/exposed pad are GND. C8 is 100 nF. | External QSPI flash is a useful reference pattern. Capacity, boot compatibility, package pads, and actual supply/timing limits require a fresh RP2350 choice; 2 MiB is an observed reference value, not a new requirement. |
| Clock | Y1 is labeled X322512MOB4SI 12pF (C70565), 12 MHz designation, 3.2 x 2.5 mm, grounded pins 2/4. C9/C10 are 15 pF to GND; R7 is 1 kohm in series between XOUT and the crystal. | Retain a compact crystal circuit concept. Verify the exact crystal manufacturer, load capacitance, ESR, drive level, and RP2350 oscillator requirements; do not copy capacitor values without a load/stray-capacitance basis. |
| BOOT and reset | SW1 grounds QSPI chip-select through R2 = 1 kohm. SW2 grounds RUN. R10 = 1 kohm pulls RUN to +3V3. J2 is a 3-pin SWD header: 1 SWCLK, 2 GND, 3 SWDIO. | Carry forward accessible BOOT, reset, and SWD. Derive RP2350 boot/reset details independently, including recovery access after enclosure/header assembly. |
| User control | SW3 connects GPIO23 to GND, without a discrete pull-up. The README instructs firmware to use a pull-up. | A spare user button is useful. It consumes a GPIO and differs from the standard Pico internal assignment; document it in the board firmware definition. |
| LEDs | D2 power LED: +3V3 through R8 = 1 kohm, with its ground return through normally bridged JP1. D3 active-high user LED: GPIO25 through R9 = 1 kohm to LED/GND. D4 XL-1615RGBC-WS2812B footprint (C5349954): +3V3 supply, GPIO24 DIN, DOUT unconnected. | The cuttable power-LED jumper and GPIO25 status LED are useful. RGB is optional; source a device explicitly suitable for the selected supply/logic levels and include its current/decoupling needs. A generic WS2812 datasheet link in the symbol is not qualification of the exact XL part. |

Evidence locations in the [schematic][sch] and [PCB][pcb]: U1/U2/U3/U5; J1-J4; D1-D4; R2-R10; SW1-SW3; JP1; Y1; C8-C11/C17/C18. The [production BOM][bom] contains the values and procurement IDs above; those IDs are upstream metadata, not validated sourcing selections for the new board. ST's [USBLC6-2 datasheet][esd] identifies the protection function and emphasizes layout-dependent effectiveness (pages 1 and 6). Torex's [XC6206 datasheet][ldo] documents a linear-regulator family with voltage-dependent current capability and package/board-dependent dissipation (pages 1-5); it does not substantiate a board-level high-current claim.

## Mechanical and pin-compatibility findings

The saved [PCB outline][outline] spans x = 50..71 mm and y = 30..81 mm: **21 x 51 mm**, with 1 mm corner radii. It declares 1.6 mm thickness and two copper layers. Header row centers are x = 51.61 and 69.39 mm (**17.78 mm separation**), with **2.54 mm pitch** and 20 holes per row. These are ordinary through-hole pin-socket footprints in this snapshot; matching header spacing alone does not establish castellated-module, connector-envelope, or mechanical compatibility. Ground zones are declared on both copper layers; native fill quality and return-path continuity were not assessed.

With the USB connector at the top, J4 runs down the left side as Pico physical pins 1-20; J3 runs down the right side as physical pins 40-21. The file uses separate 1-20 numbering on each connector. J4 carries GPIO0-15 and GND at positions 3, 8, 13, 18. J3 carries GPIO16-22 and GPIO26-28, RUN, power, and ground. That makes **26 GPIO signals on the 40-pin interface**, not 32. [Header footprints and pad nets][headers].

| Pico physical pin / function | Orpheus source connection | Compatibility consequence |
|---|---|---|
| 40 / VBUS | J3.1 VBUS | Direct USB supply net. |
| 39 / VSYS | J3.2 +5V | Diode-fed regulator input; operating range must be derived from this power circuit, not inherited from a Pico buck-boost supply. |
| 37 / 3V3_EN | J3.4 intentionally unconnected | No regulator shutdown through this position. |
| 36 / 3V3 | J3.5 +3V3 | Regulator output; no unqualified external-current rating. |
| 35 / ADC_VREF | J3.6 intentionally unconnected | No exposed ADC reference through this position. U1 ADC_AVDD is tied to +3V3. |
| 33 / AGND | J3.8 GND | Shares the main GND net. |
| 30 / RUN | J3.11 RUN | Shares reset-button/pull-up network. |

Pico pin names/numbering were cross-checked with the official [Pico 2 datasheet][pico2], section 3.1, printed page 8. Internal assignments also differ: Orpheus uses GPIO23 for its button and GPIO24 for RGB, so software expecting standard Pico power-save control or VBUS sensing must be adapted. The README's 32-GPIO statement is not supported by the inspected source. U1 GPIO29 has a named net but no routed segment, via, or other footprint pad identified on that net; TP1's flag footprint contains graphics and no pads. Do not advertise the flag or GPIO29 as a verified touch/test interface.

## Carry-forward decisions

Adopt as design intent: Pico-style header geometry and explicit pin mapping; USB-C device port with separate CC pull-downs; a qualified ESD path; accessible BOOT/reset/SWD; an active-high GPIO25 LED; optional user button, RGB LED, and power-LED disconnect. These are engineering recommendations, not assertions that Orpheus assets have been licensed for copying.

Resolve afresh for RP2350: MCU/package and support supplies; exact regulator/current and input-voltage budget; flash capacity and boot support; crystal/load network; USB termination and routing; decoupling; connector footprint; stackup/return paths; exposed-pad implementation. If Pico compatibility is intended, decide and implement 3V3_EN, ADC_VREF, and internal GPIO behavior explicitly rather than inheriting Orpheus omissions.

## Reproducibility

Read-only reference checkout: C:/Users/kidch/Documents/EvlEDA-Transfer-2026-09-09/rp2350-reference-inputs-01/orpheus. Git status was clean after inspection. Sources were read as text/S-expressions; no KiCad launch, ERC, DRC, or physical test was performed. SHA-256 below covers the original Git blob bytes at the pinned commit; Windows checkout newline conversion can yield different working-file hashes.

| Source | SHA-256 of Git blob |
|---|---|
| README.md | a81b57d759dcf19a7c44f7aca1a12908e12837143def1ccd34f68f1b9bd39fac |
| orphkicad.kicad_sch | 2766cd6d6e5372f088321990973a7c8d99bf91121c412e57f1fbe53b4955d9a7 |
| orphkicad.kicad_pcb | 0a523efb9d433a44c4f81b0dbf5fffe7463d41ef01e530e1363d3a86e40b9c4f |
| production/bom.csv | eb0313e4eac683e9e36b343d5f4be505dc7a35ebe5169f14eab11ba1d44df79d |

[repo]: https://github.com/hackclub/orpheus-pico/tree/05783d768ec096b691b0abdcdfd95991eee68c41
[parent]: https://github.com/mpkendall/orph-pico-reloaded/tree/98f7b70bd9497a834703dc6e6f991b0093c0f751
[sch]: https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/orphkicad.kicad_sch
[pcb]: https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/orphkicad.kicad_pcb
[bom]: https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/production/bom.csv
[legacy]: https://github.com/adammakesthingsdev/Orpheus-Pico-Kicad/blob/9c5451decb336d425bbfbb709049df61477aa0eb/README.md
[legacy-license]: https://github.com/adammakesthingsdev/Orpheus-Pico/blob/96bd3ba6422bc2cdfc4ec7e630d72926cc687f72/LICENSE
[esd]: https://www.st.com/resource/en/datasheet/usblc6-2.pdf
[ldo]: https://product.torexsemi.com/system/files/series/xc6206.pdf
[outline]: https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/orphkicad.kicad_pcb#L17604
[headers]: https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/orphkicad.kicad_pcb#L3403
[pico2]: https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf
