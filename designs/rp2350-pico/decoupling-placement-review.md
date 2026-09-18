# RP2350 decoupling and oscillator placement review

Reviewed 2026-09-17. **Prefer the modest joint north move of C14/C15 and R1, and the Y1 rotation with C24/C25 target exchange, as proposals to integrate.** The C1/C2 north shift is a plausible local adaptation, but must be evaluated with the complete core switching-current and ground-return geometry. No circuit, placement input, route plan or native project was edited by this review.

This review uses the actual selected footprint pads through `source-geometry.mjs`, not component centers or courtyard proximity as substitutes for current loops. The current board coordinates are millimetres from the northwest corner, +X right, +Y down; U1 is at (10.50,22.00), rotation 0. Distances below are positive-pad-center to associated MCU-pad-center **straight-line lower bounds**, not routed lengths or electrical pass/fail limits.

## Complete C1-C15 map

All listed capacitors have pad1 on the indicated supply and pad2 on GND. Selected stock 0402 pads are 0.56 x 0.62 mm, spaced 0.96 mm center-to-center; dimensions exchange axes at 90/270 degrees. U1 north/south pads are 0.20 x 0.80 mm; east/west pads are 0.80 x 0.20 mm. U1.61 is the 3.4 x 3.4 mm exposed ground pad centered at (10.50,22.00).

| Ref / value | Actual rail and associated U1 function | U1 pad center | Cap pad1 center | Cap GND pad2 center | Direct distance mm | Local-return intent |
| --- | --- | --- | --- | --- | --- | --- |
| C1 / 4.7 uF | 3V3 -> pin49 VREG_VIN | (12.10,18.55) | (12.02,17.39) | (12.98,17.39) | 1.163 | Core high-current return with C2/PGND47; low-impedance local connection to EP61 |
| C2 / 4.7 uF | 1V1 -> pin50 VREG_FB; L1 output reservoir | (11.70,18.55) | (12.02,16.45) | (12.98,16.45) | 2.124 | Core high-current return to PGND47 at (12.90,18.55), then local main-GND connection |
| C3 / 4.7 uF | VREG_AVDD -> pin46, after R8 | (13.30,18.55) | (14.70,16.47) | (14.70,17.43) | 2.507 | Separate quiet ground access to EP61; do not share CIN/COUT ground vias |
| C4 / 4.7 uF | 1V1 -> pin23 DVDD, extra bulk | (10.50,25.45) | (11.65,26.64) | (11.65,27.60) | 1.655 | South-side local ground to EP61, away from core LX/COUT group |
| C5 / 100 nF | 3V3 -> pin1 IOVDD | (7.05,19.20) | (5.78,20.00) | (4.82,20.00) | 1.501 | West-side local ground access to EP61 through GND plane |
| C6 / 100 nF | 3V3 -> pin11 IOVDD | (7.05,23.20) | (5.78,23.20) | (4.82,23.20) | 1.270 | West-side local ground access to EP61 |
| C7 / 100 nF | 3V3 -> pin20 IOVDD | (9.30,25.45) | (8.35,26.64) | (8.35,27.60) | 1.523 | South-side local ground access to EP61 |
| C8 / 100 nF | 3V3 -> pin30 IOVDD | (13.30,25.45) | (14.00,26.64) | (14.00,27.60) | 1.381 | South/east local ground access to EP61 |
| C9 / 100 nF | 3V3 -> pin38 IOVDD | (13.95,22.00) | (15.52,23.20) | (16.48,23.20) | 1.976 | East-side local ground access to EP61 |
| C10 / 100 nF | 3V3 -> pin45 IOVDD | (13.95,19.20) | (15.52,18.80) | (16.48,18.80) | 1.620 | East/northeast local ground access to EP61; preserve nearby ADC quiet routing |
| C11 / 100 nF | 1V1 -> pin6 DVDD | (7.05,21.20) | (5.78,21.30) | (4.82,21.30) | 1.274 | West-side local ground access to EP61 |
| C12 / 100 nF | 1V1 -> pin23 DVDD | (10.50,25.45) | (10.55,26.64) | (10.55,27.60) | 1.191 | South-side local ground access to EP61; retain the close HF bypass in addition to C4 |
| C13 / 100 nF | 1V1 -> pin39 DVDD | (13.95,21.60) | (15.52,22.10) | (16.48,22.10) | 1.648 | East-side local ground access to EP61 |
| C14 / 100 nF | 3V3 -> pin53 USB_OTP_VDD | (10.50,18.55) | (9.165,17.38) | (9.165,16.42) | 1.775 | North local quiet ground access to EP61; distinct from core switching return |
| C15 / 100 nF | 3V3 -> pin54 QSPI_IOVDD | (10.10,18.55) | (8.225,17.38) | (8.225,16.42) | 2.210 | North local quiet ground access to EP61; distinct from core switching return |

The map matches the circuit inventory, the official native reference pin map and the selected RP2350A footprint. Pin1 is IOVDD; pin54 is QSPI_IOVDD. The retained datasheet's later summarized supply table appears to list 54 among ordinary IOVDD while omitting 1; that apparent summary discrepancy must not override the actual pin map or reconnect C5. C1-C15 alone are not the entire MCU decoupling inventory: C16/C17 cover ADC_AVDD44, and C18/C19 belong to flash U3.8. Keep those existing roles intact.

## Assessing the current targets

C5-C13 form recognizable local banks around their corresponding package sides. Their supply pads face the MCU; this is a sensible starting arrangement, not proof of low loop impedance. C5 and C9 have lateral offsets, so their pad-to-pin straight lines cannot be assumed available through neighboring pin clearances. Route short local supply branches and their ground accesses before treating the remaining area as unconstrained signal space.

C12 is the close 100 nF at DVDD23; C4 is additional south-side bulk. If the SWD passage needs adjustment, preserve C12's local HF bypass first and move C4 modestly within that same bottom-side supply region if needed. Do not move C4 back to the north switching island merely to clear the south fanout. Do not combine the 1V1 capacitors with nearby 3V3 capacitors because their package/values look alike.

The current power-route plan explicitly describes the core and quiet-return requirements but has no realized MCU-local ground-via geometry; its four proposed vias belong to the RT6150 island. A cap-ground coordinate does not itself establish a return path. The ordinary bypasses need nearby plane access plus nearby MCU EP stitching. Short shared access between adjacent quiet bypasses can be a reasonable space/via-budget tradeoff; a long ground daisy chain around the package is not equivalent. Avoid feeding switching-current return through the analog filter or oscillator grounds. The 32-via budget should be allocated across these loops before signal routing consumes the available passages.

## Joint north proposal

Latest small joint trial received from both placement owners:

- R1 -> (10.125,16.50), rotation90; R2 stays (11.085,16.70).
- C14 -> (9.165,16.75), rotation90; C15 -> (8.225,16.75), rotation90.
- C1 -> (12.50,17.24), rotation0; C2 -> (12.50,16.30), rotation0.
- U1 and other core-group members remain at their published targets.

| Ref | New positive / GND pad centers | Direct distance before -> after mm | Assessment |
| --- | --- | --- | --- |
| C14 | (9.165,17.23) / (9.165,16.27) | 1.775 -> 1.877 | Small increase; reasonable tradeoff if actual supply and local-return branches fit with the complete QSPI bus |
| C15 | (8.225,17.23) / (8.225,16.27) | 2.210 -> 2.293 | Small increase; same condition |
| C1 | (12.02,17.24) / (12.98,17.24) | 1.163 -> 1.312 | Modest change but affects switching-current loop, not merely ordinary bypass distance |
| C2 | (12.02,16.30) / (12.98,16.30) | 2.124 -> 2.273 | Pair spacing is preserved and C2 moves toward L1; FB/PGND routing still must be short and quiet |

Prefer the modest C14/C15 move over the larger alternative that puts a capacitor at (8.3,15.5), rotation180, increasing the associated positive-pad-to-pin distance to roughly3.50 mm. The larger study has not demonstrated the complete bus with its 3V3/ground loops; it should not gain priority merely because some signal paths fit. No arbitrary maximum distance is imposed here: the comparison is relative loop quality and actual routing coexistence.

Both C14/C15 are on 3V3, and adjacent pins53/54 can use a short local common supply connection while retaining both bypass parts and their associations. The official Minimal reference shares one bypass at these pins to make room for the regulator; its own guide explicitly treats longer bypass paths as a speed/noise tradeoff. This candidate's two capacitors should not become a distant parallel bank whose long common branch defeats their purpose.

## Core-loop return review and candidate via locations

The [RP2350 datasheet, section6.3.8.1](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf) makes the high-current loop area, local GND connection, independent CFILT return, FB pickup and LX copper geometry explicit. Keep C1/L1/C2 on the MCU side; take FB50 from C2.1 without routing under LX. C3.2 must have separate quiet ground access. The selected stock capacitor lands differ from Raspberry Pi's native `generic_capc1005x50_wide` lands, so retained center offsets alone do not copy its validated copper. The reference wide-cap pads are0.47 x0.55 mm at+/-0.515 mm; selected stock pads are0.56 x0.62 mm at+/-0.480 mm. Their inter-pad gaps are0.56 and0.40 mm respectively, before considering trace-width/clearance requirements.

For the joint trial, the following **source-only return candidates** were checked against actual selected foreign pads and the current north-revision USB tracks. They are not routed-board results and must be rechecked with new CORE_LX, feedback, supply and QSPI copper:

| Purpose | Candidate center(s), diameter/drill mm | Basis and remaining work |
| --- | --- | --- |
| Core high-current connection | (13.60,16.50), (13.60,17.10), each0.60/0.25 | Matches the reference-relative adjacent-via pair; source pad/USB clearance screen is clear. Explicitly connect C1.2/C2.2/PGND47 with short broad local copper and retain low-impedance access to the main GND/EP return. It is not two remote independent return loops. |
| C3 quiet return | (14.35,18.15),0.60/0.25 | Source-clear0.30 mm stub: C3.2(14.70,17.43) -> (14.70,17.80) -> via. Do not join through the high-current pair. |
| MCU EP-side stitching | (10.50,19.80), (11.10,19.80), each0.60/0.25 | Source-clear candidate positions between the northern pin row and EP, outside the EP paste area. Short F.Cu connections into EP and actual B.Cu plane contact remain to be authored/checked. They do not substitute for the outer switching-loop via pair. |
| C14/C15 quiet shared access | (8.525,15.65),0.60/0.25 | Source-clear local stubs below; distinct from switching return. One shared nearby access is a proposal to consider under the via budget, not a requirement to share. |

C14.2 local stub, width0.30 mm: `(9.165,16.27) -> (8.895,16.27) -> (8.525,15.90) -> (8.525,15.65)`.

C15.2 local stub, width0.30 mm: `(8.225,16.27) -> (8.225,15.95) -> (8.525,15.65)`.

The shared candidate via's closest existing USB copper gap is approximately0.523 mm versus0.20 mm required. These stubs passed the shared source pad/drill/trace checker against the current north USB path snapshot, before new QSPI routes. By contrast, putting C14's via directly north at(9.165,15.60) conflicts with `dp-body:0`. Thus even apparently obvious ground access must be reserved and checked alongside the bus. No complete core switching loop is supplied or accepted by this note.

## Crystal rotation and capacitor target exchange

The preferred proposal rotates Y1 at (9.10,30.30) from180 to0 degrees and swaps the target poses of identical15 pF C24/C25. Logical identities stay unchanged: C24=XIN/Y1.1, C25=XTAL_OUT/Y1.3. The resulting Y1 signal-pad centers are1=(8.00,31.15) and3=(10.20,29.45); ground pads2/4 remain at the same spatial pair, now2=(10.20,31.15),4=(8.00,29.45). Both are genuine ground terminals. Occupied courtyard/copper envelopes remain unchanged, but the signal-net assignment to physical locations changes and must follow the new rotation.

The originally reported3.827 mm output tree has been superseded by the complete turn-compliant artifact. Current measured polylines give:

| Copper measure | Fixed poses mm | Preferred proposal mm |
| --- | --- | --- |
| U1 XOUT22 -> R7.1 | 1.582 | 1.582 |
| R7.2 -> crystal output terminal | 13.374 | 2.101 |
| Output load-cap branch | 2.320 | 2.404 |
| XTAL_OUT total tree | 15.694 | **4.505** |
| U1 XIN21 -> crystal input terminal | 8.285 | 8.653 |
| Input load-cap branch | 1.726 | 3.090 |
| XIN total tree | 10.011 | **11.743** |
| Three oscillator-net copper totals | 27.288 | **17.831** |

The large reduction in the output path makes the rotation a meaningful improvement. XIN and its load branch become longer, so do not judge the oscillator only by XTAL_OUT. The result is a better integrated starting point, not proof that every parasitic or startup margin is unchanged. Retain ABM8-272-T3, the two15 pF C0G parts and the1 kohm R7 damping resistor; do not change values to compensate for an unmeasured parasitic estimate.

The [hardware design guide, pages13-14](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf) calls for short oscillator paths because PCB/pin capacitance contributes to the load. It does not provide a hard millimetre limit to apply here. Keep load-cap ground and crystal-case ground short and quiet, with a continuous local return to MCU ground; avoid shared switching-current paths and adjacent fast signal coupling. Further shrinking the C24 branch is worthwhile if achievable without sacrificing that return or the south-side DVDD bypasses.

The clock owner is considering0.60/0.25 mm off-pad ground vias at C24:(5.00,32.42), C25:(12.70,29.60), Y1.2:(10.20,32.00), Y1.4:(8.00,28.50). Treat these as that owner's unadopted integration proposals. The east alternative for C25 at(13.35,29.00) conflicts with SWCLK_HDR; moving below the cap is therefore sensible to investigate. Their complete joint via/drill/trace/budget checks are not asserted by this review. Physical startup testing is a later qualification activity, not a prerequisite to adopting this demonstrably improved placement proposal.

## Evidence boundary

Reviewed source snapshots (SHA-256):

- `placement-constraints.json`: `265a177213958ba5a5f546bbe2fb676b5ef558bcb25457bcb86cee96cd51d7b3`.
- `design-ready-draft.json`: `43bce7ba0e3178b271878eba464623cf51ed3119957a1809cae6c16a97a6d45d`.
- `qspi-clock-route-plan.json`: `23eb129bc523b17157d338c3f4bc3334a240b69d19ce4711ae7e4444c64a67a5`.
- `north-routing-revision.json`: `5ce7d92d3327cddd956755f9d9afec6d5a4623196b8e1311791b205931166a79`.
- `power-route-plan.json`: `466c89b6afb904b5794ff63f0286f8476bcacbbe868edd67eee5a7e27f6a8fbc`.
- Shared read-only geometry helper: `d331d0e455b78d5b0170c3e130b0284b945923a7703616240997026a4a227ba0`.

The MCU pin/function map was cross-checked against the circuit inventory and retained official native reference; local geometry came from source-hash-checked actual footprints. Distances and oscillator totals were recomputed. The narrow proposed ground-access checks inspect source geometry only; no native operations, builds, ground refill, complete plane-return analysis or physical measurements were performed. Active routing artifacts may change after these snapshots; coordinate all proposals in one final coherent placement/routing state.
