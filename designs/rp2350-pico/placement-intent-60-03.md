# Placement intent — saved candidate 60-03

This explains the **actual saved placement** in the
[native 60-03 snapshot](native-placement-60-03/README.md): **22 × 60 mm, two layers**.
Coordinates are footprint origins in millimetres, viewed from the component side:
`(0,0)` is upper-left, X increases rightward and Y downward.

The arrangement follows the circuit: USB enters at the top; protection and CC
termination follow below it; the MCU occupies the middle, with flash northwest
and the crystal south. The larger external 3V3 converter occupies the lower
interior. Sense/filter circuits occupy the right side, while the two long header
rows and four mounting positions retain their mechanical relationships.

| Actual components | Saved location / anchor | Purpose and placement intent |
| --- | --- | --- |
| J1, U4, R3/R4, C26; R1/R2 | J1 `(11,4.975)`, 180°; U4 `(10.85,12)`, 90°; CC at Y=10.35; R1/R2 near `(10,27)` | Top USB-C ingress, ESD protection, separate 5.1 kΩ CC pulldowns and U4 VBUS bypass. The 27 Ω data resistors sit at the MCU end of the intended USB path. |
| U1, L1, R8, C1–C14 | U1 `(10.4,32.5)`, 0°; L1 `(12.45,24.85)` | Central RP2350A; its core converter sits above it. Capacitors serve 3V3, 1V1 and VREG_AVDD around the MCU and north/west passage. L1/CORE_LX is distinct from U2's converter. |
| U3, R5/R6, C15/C18/C19 | U3 `(6.05,24)`, 90°; R5 `(5.81,27.2)`, 0°; R6 `(5.27,29)`; C15 at `(5.3,20.85)`; C18/C19 at Y=18.5 | Northwest QSPI flash, supply capacitors and CS pullup R6. R5 starts the BOOT branch. Current capacitor spacing still needs satisfactory supply and return routing. |
| Y1, R7, C24/C25 | Y1 `(9.6,40.8)`; R7 `(9.5,38.48)` | 12 MHz crystal south of U1's oscillator pins, with XOUT series resistor and two load capacitors; oscillator loop geometry remains to be resolved. |
| SW1, SW2, D2/R18 | BOOTSEL `(5.5,39.5)`; RUN `(16.2,42)`; LED and resistor at Y=44.8 | Controls flank the lower MCU region; D2/R18 provide GPIO25 indication below it. SW1 connects through R5 to QSPI_CS; SW2 grounds RUN when pressed. |
| J4, R19/R20 | J4 `(8.46,57.2)`, 90°; resistors near `(13.3,40–43)` | South-edge SWD access, with separate 100 Ω SWCLK/SWDIO series resistors between MCU and header nets. |
| U2, L2, C20/C21/C22, R9/R10 | U2 `(10.5,48.6)`, 90°; L2 `(10.5,53.01)`; C20/C21 flank U2 | Lower RT6150B-33 converter, input/output capacitors, inductor and enable/power-save resistors. Grouping the large parts here leaves the dense USB/MCU north edge available. |
| D1, R11/R12 | D1 `(16.9,13.2)`; divider at X=16.75, Y=16.9/18.1 | Right-side USB power ingress: D1 connects VBUS to VSYS; R11/R12 divide VBUS for GPIO24 sensing. |
| Q1, R13/R14/R15, C23; R16/R17, C16/C17 | Q1 `(17.14,27.5)`; R15 `(17.98,36.35)`; ADC capacitors at X=16.5, Y=30.32/31.45 | Right-side VSYS divider/MOSFET sensing and separate ADC filter: 3V3 → R16 → ADC_VREF → R17 → ADC_AVDD, with C16/C17 to ground. |
| J2/J3; H1–H4 | Header X=2.11/19.89; holes at X=3.53/18.47 and Y=2/58 | Retain 2.54 mm header pitch, 17.78 mm row spacing and four 2.10 mm mounting bores. Opposite header numbering directions are preserved. |

Header service bands **X=0–3.46 and 18.54–22 mm, on both layers**, reserve rework
access: unrelated tracks, vias, pads and zone fill stay outside them. Existing
header lands/barrels and checked own entries are retained. This is source-planning policy, not encoded arbitrary native
keepouts. Mounting head/tool envelopes are separately checked, not implied by the
bare-hole footprints.

**Placement is still subject to routing.** The controls source study leaves
BOOT_SW and RUN incomplete. Its alternative R5 `(4.79,27.2,180°)` conflicts with
the later common scene and is not adopted. Resolving BOOT escape or the shared
RUN/SWD/analog passage may require a reviewed R5 or SW2 move; the saved positions
above remain unchanged. Return/reference continuity and other joint routing
conflicts remain open. The snapshot contains **zero tracks, vias or zones**;
neither complete high-frequency/thermal optimization nor routing acceptance is
claimed.

Basis: snapshot PCB `f2444cd2…e3bed3` and schematic `f75ee87d…16adfd`; 62 poses,
values, 260 net-assigned pins, two native no-connect names and four mounting poses
checked against candidate-03. Service bands follow its frozen packet. Routing
limits follow local evidence
`rp2350-candidate-60-routing-controls-01/continuation-02/WORKING-STATUS.md`
(SHA-256 `4d0f1f02a605fd8a15876a94cf4a03c97b85722c4411645922cc59fc3d0a2ad0`).
