# RP2350 USB construction and channel candidate

Reviewed 2026-09-17. [usb-construction.json](usb-construction.json) contains a complete `interfaceRequirements` object shaped for the current V2 construction/channel schema, calculator receipts, all 14 signal anchors, layout budgets, sources and assumptions. It is ready to use as an explicit input choice for a layout candidate. It is not an authenticated bundle, a routed board, a fabrication order or a USB/ESD qualification.

## Selected nominal construction

Use the nominal **1 mm, two-layer FR4 build** in [JetPCB Manufacturing Standards, §3.5, PDF p.4](https://us.jetpcb.com/Public/en-US/docs/Specifications.pdf), discovered through [JetPCB's own fabrication page](https://us.jetpcb.com/rule/standard_pcb.aspx). The source was retrieved directly: 141,386 bytes, SHA-256 `292022cf8c97dc79aa638b97c2f7b30ce5fbf8a082bb3665ab6325bfb6534f9b`. The PDF gives no identified dated revision; current delivery and material availability still need confirmation before procurement.

| Native declaration | Nominal thickness |
| --- | ---: |
| F.Mask | 0.010 mm |
| F.Cu, foil plus plating | 0.018 + 0.025 = 0.043 mm |
| FR4 core, actual signal-to-reference dielectric height | **0.900 mm** |
| B.Cu, foil plus plating | 0.043 mm |
| B.Mask | 0.010 mm |
| Exact declared layer sum | **1.006 mm** |

The 1.006 mm value preserves the source's nominal layer dimensions in a native schema that requires exact sum agreement. The vendor calls this a nominal 1.0 mm construction. Six micrometres is not a claimed manufacturing tolerance; neither 1.0 nor 1.006 mm is substituted for the 0.900 mm dielectric height. Finish adds local metal at mask openings, not another uniform whole-board layer in this model.

Select the listed **ENIG** option for the candidate, with masks present on both sides and air outside. Finish thickness, the actual mask process/product and final stack tolerances remain procurement inputs. The source's general material table and detailed copper build are not proof of a characterized controlled-impedance process.

The official [Raspberry Pi Minimal design](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip) instead declares **1.6 mm total, 1.51 mm core, 35 µm copper, 10 µm masks, Er 4.5 and loss tangent 0.02**. Those dimensions are not mixed with the selected JetPCB build. Likewise, the [RP2350 hardware guide's](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf) 1 mm / 0.8 mm width / 0.15 mm gap example is not assumed valid for this construction.

## Material declarations and honest limits

The schema requires numeric electrical properties even though JetPCB does not specify a laminate manufacturer or frequency-dependent data. The JSON labels these fields as **analytical idealizations**, separately from published dimensions:

| Field | Declared analytical input | Evidence boundary |
| --- | --- | --- |
| Core permittivity and loss | Er 4.5; tan δ 0.02 at 100 MHz | Values appear in the Raspberry Pi native reference without a frequency. Applying them to the selected FR4 at 100 MHz is an assumption, not JetPCB data. |
| Core permeability | μr = 1 | Homogeneous, nonmagnetic approximation. |
| Copper | 58 MS/m; μr = 1; zero roughness | Smooth bulk-copper approximation, not measured foil, plating or finish. |
| Mask electrical properties | Er 3.8; tan δ 0.02 at 100 MHz | Illustrative placeholders only. Another vendor [publishes mask Er 3.8](https://jlcpcb.com/help/article/multi-layer-pcb-standard-laminated-structures), but this does not establish JetPCB's material or its frequency data. |
| Mask product | Green LPI candidate | Exact ink, cure and profile are unreported; the process choice needs confirmation. |
| Analysis frequency | 100 MHz | An explicit engineering checkpoint, not a claim about the USB data rate, a measured material frequency or a specified RP2350 edge. |

The chosen numerical inputs make the intended model reviewable; they do not fill the missing fabrication evidence. Named laminate/mask, Dk/Df with test frequency and method, actual copper roughness/conductivity, ENIG details and dimensional tolerances remain open.

## Calculated body geometry

The advertised read-only `evleda_transmission_line` tool was used directly. No new calculator, editor session or application code was created. Receipts retain KiCad commit `146a4f2a7585c65bc580427a19b6fe2ec4a3f622`, protocol 4, implementation `evleda-uncovered-coupled-microstrip-v1`, and helper SHA-256 `b6398ef3cd9c4ffaf95873c2c5353e157a4eb8b3c292580a5da69d782b6a2430` (384,000 bytes).

Inputs are explicitly SI: H=0.000900 m, T=0.000043 m, Er=4.5, tan δ=0.02, σ=58,000,000 S/m, μr=1, roughness=0, frequency=100,000,000 Hz, illustrative uniform length=0.020 m, no metallic top cover. Holding gap at 0.000200 m gives a synthesized width of **0.820253156 mm** for frequency-dependent differential impedance 90.000000133 Ω.

A separate forward analysis of the rounded **0.82 mm width / 0.20 mm gap** gives **90.009301 Ω**. The native quasistatic result is separately retained as 90.026774 Ω; it is not substituted for the frequency-dependent value.

| Width / gap, mm | Calculated differential Ω at 100 MHz |
| --- | ---: |
| 0.80 / 0.20 | 90.753242 |
| 0.80 / 0.22 | 92.679172 |
| 0.84 / 0.20 | 89.283106 |
| 0.84 / 0.22 | 91.149949 |

Use a nominal 0.82 / 0.20 mm body, an authored body-width interval of 0.80–0.84 mm, and a coupled-gap interval of 0.20–0.22 mm. The channel retains **90 ± 9 Ω** as an engineering target. The ±9 Ω is a project choice, not an attributed USB compliance tolerance. These geometry intervals describe intended saved geometry, not a manufacturer's etch tolerances.

Illustrative one-at-a-time sensitivity gives 93.506 Ω at Er=4.1 and 86.877 Ω at Er=4.9; 88.668 Ω at H=0.81 mm and 91.055 Ω at H=0.99 mm. Holding all other assumptions fixed at 12 MHz gives 90.025 Ω. These are sensitivity probes, not a worst-case bound or evidence that a laminate has those tolerances.

**The model is bare microstrip.** It does not include the declared masks, ENIG, lateral copper, finite plane, package pads, branches, bends, neckdowns, resistors or ESD device. The gap/thickness ratio S/(2T)=2.326 does not establish the retained model assumption that S is much greater than 2T; no numeric sufficiency threshold is published. The broad Kirschning–Jansen width/height, gap/height, frequency-height and Er envelope is met, but that does not resolve the separate finite-thickness assumption.

The saved-board implementation explicitly rejects positive signal-side mask thickness with `MASKED_MICROSTRIP_UNSUPPORTED`. **Keep the masks declared.** This is useful preliminary sizing while masked-board impedance remains unresolved; it does not justify `impedance: none`, a fictitious absent mask, or a pass on the complete channel.

## Complete copper channel and placement intent

Preserve these exact anchors:

| Net | All physical signal anchors |
| --- | --- |
| USB_DP_MCU | U1.52, R1.1 |
| USB_DM_MCU | U1.51, R2.1 |
| USB_DP_PORT | R1.2, J1.A6, J1.B6, U4.1, U4.6 |
| USB_DM_PORT | R2.2, J1.A7, J1.B7, U4.3, U4.4 |

R1 and R2 stay 27 Ω, with pad1 toward the MCU and pad2 toward the port. Adopted resistor poses are R1=(10.125,16.90), R2=(11.085,16.70), both +90°. R2 moves 0.20 mm north to open the source-pad launch corridor. R1 source/port pads lie at y=17.41/16.39; R2 source/port pads lie at y=17.21/16.19. The source-pad-center distances to U1.52/51 are approximately 1.378486 and 1.357139 mm respectively, within the unchanged 2 mm placement budget; actual routed launches still require the 3 mm check. The primary receiver pair remains A6/A7; B6/B7 remains an additional receiver pair. These are bookkeeping roles for a bidirectional USB link. U4.2 is GND and U4.5 is VBUS. No parallel board termination is added at the receptacle; Type-C CC resistors remain separate.

Route all four nets on **F.Cu with zero vias**, over the continuous **B.Cu GND** reference. Preserve 45-degree trace turns, normal polarity, and all signal, ground, shield and locating features. The candidate class is 0.82 mm body width, 0.20 mm clearance and 0.50 mm copper-to-edge, with terminal-bound widths permitted as below. The current schema requires the class default of every channel net, including both launches, to stay inside the body-width interval; a separate 0.20 mm launch class would reject. Set the defaults to 0.82 mm and authorize actual narrow tracks through the explicit channel escapes.

The existing poses put U1.52/51 at (10.90,18.55)/(11.30,18.55) mm. With the adopted recessed J1 at (10.50,4.975), 180°, its left-to-right data order is B6(+), A7(−), A6(+), B7(−), all at y=8.655 mm. A same-layer fan-in can be explored by joining the two polarities on opposite sides of that row and taking their outputs around the appropriate outer ends. Actual finite-width clearance to adjacent CC/SBU/power pads, body metal and NPTH locators must be checked. Retained Orpheus source demonstrates this topology without USB vias, but uses different lands and split ESD nets; none of its coordinates or copper is copied.

With adopted U4 at (9.60,12.15), +90°, D+ is west at x=8.65 and D− east at x=10.55. Connector-facing pads6/4 are at y=11.0125; MCU-facing pads1/3 are at y=13.2875. This 0.25 mm southward target revision stays inside its existing placement region and accommodates the proposed port tree. Actual source-tree copper must contact both pads per polarity. A short real F.Cu segment beneath/around the SOT23 body may be explored after footprint clearance review. Package-internal connectivity is not an imaginary PCB edge, and a long external loop is not a valid shortcut around a missing topology model.

The nominal pair envelope is 1.84 mm; its maximum declared envelope is 1.90 mm. Reserve **at least 2.40 mm** including 0.25 mm lateral clearance on both sides. The adopted U3 pose (6.50,15.50), +90°, opens a nominal 3.65 mm courtyard lane toward L1, compared with the former 2.07 mm gap. This creates space to investigate the body route; actual copper and reference clearance still need checking. Do not quietly extend neckdowns as a routing workaround. A **0.90 mm ground-coverage guard beyond each trace edge** is an explicit geometric review margin equal to one nominal dielectric height. It is not proof of an infinite reference or adequate EMC return behavior. Keep unrelated top copper farther away where feasible; lateral copper remains outside this calculator's model.

## Numeric routing budgets

These are explicit choices for the 21 × 51 mm candidate, retained after the recessed connector reduces the north-south source-pad/contact-row separation to 9.895 mm. They are not manufacturer limits.

| Check | Candidate limit |
| --- | ---: |
| MCU pad to source resistor pad, Euclidean center distance | 2 mm |
| Each actual MCU-side copper launch | 3 mm |
| Each R1.2/R2.2-to-contact port path | 22 mm |
| Each complete MCU-to-contact copper-only path | 25 mm |
| Total copper per polarity, launch plus port tree including branches | 35 mm |
| Each declared connector/protection branch | 5 mm |
| Each port-pair skew and every complete paired-contact channel skew | 1 mm |
| Uncoupled length in each assessed pair view | 12 mm |

Series-resistor and protection internals do not contribute invented PCB etch length. Pair A and pair B must each be checked; passing one plug orientation cannot hide the other contact path. Every tree leaf and branch attachment remains at a declared physical pad center under the current source geometry contract. The 1 mm skew budget corresponds to roughly 5.65 ps using the model's reported odd-mode delay, but the native delay approximation is separately warned and no signal-integrity pass follows from this estimate.

Use **0.20 mm** at narrow source/contact escapes, with local 0.40/0.60 mm steps or shoulders toward 0.82 mm where clearance allows. The source contract's minimum supported channel width is 0.20 mm; do not request a narrower route that it cannot represent. The explicit escape interval is 0.20–0.84 mm, limited by routed distance to the exact terminal:

- U1.51/52 and R1.1/R2.1: 3.0 mm.
- R1.2/R2.2: 2.0 mm.
- Each U4 signal pad: 2.5 mm.
- Each J1 data contact: 3.5 mm.

These are maxima, not invitations to keep the whole channel narrow. A hypothetical uniform 0.20 / 0.20 mm pair on this build calculates to 132.705 Ω; 0.40 / 0.20 mm gives 111.621 Ω. Actual launches and fan-in are even less uniform, which is why they are bounded discontinuities rather than qualified 90 Ω body sections.

C26 stays beside U4.5 with a short supply path; U4.2 needs a short low-inductance ground access that does not cut the data reference. [ST's USBLC6-2 guidance](https://www.st.com/resource/en/datasheet/usblc6-2.pdf) supports keeping these connections short, without assigning these project-specific distances or proving a board-level ESD result. The selected [GCT drawing](https://gct.co/files/drawings/usb4105.pdf) remains the mechanical/contact authority.

## Verification and open evidence

The JSON's strict `interfaceRequirements` object and an in-memory overlay on the actual unresolved V2 draft **pass current source schemas**. All 14 anchors match the actual four net endpoint sets; their board coordinates have been recomputed from the adopted five component poses. Source-resistor distances pass the 2 mm source-geometry check. Dimensions and the 1,006,000 nm construction sum pass integer-nanometre checks. Rounded calculator geometry matches the declared core/copper/frequency inputs, and all four body-width/gap corners are within the authored numerical target under the stated model. No draft, native, application, build or configuration source is modified by this proposal.

Placement and source-tree closure still require actual native geometry, finite-width clearances, saved 45-degree-turn evidence, both connector paths, complete escape/branch/skew budgets, termination placement, fresh reference fill/contact and native checks. Mask-aware impedance/material acceptance, manufacturer build confirmation and physical USB/ESD/thermal testing remain independent of the useful layout input choice.
