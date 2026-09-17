# RP2350 Pico-like placement intent

Reviewed 2026-09-17 against the 62-reference circuit inventory, component-selection overlay, current v2 package and installed KiCad footprint sources. This is an **original floorplan proposal, not CAD, native placement, a clearance pass or a validated board**. It does not resolve the draft's null placement/routing fields. The companion [placement-intent.json](placement-intent.json) accounts for every reference without assigning an arbitrary grid.

Use one coherent arrangement: USB at the north end; the MCU's verified USB/QSPI/core-regulator edge faces north; flash sits northwest of the MCU, the core buck northeast, analog circuits east, and the crystal immediately south. Put the larger RT6150/Coilcraft/1210 power group in the lower interior, where its actual footprints fit as a compact group. Its longer VSYS feed is preferable to spreading its switching loop around the USB connector. This is a layout tradeoff requiring voltage-drop, return-path and thermal review, not a demonstrated optimum.

Read first: [the compact floorplan](placement-intent.svg) shows that arrangement and its reasons. Header/board anchors are scaled; coloured group boxes are approximate. The critical unresolved fit is the dense U1 north edge, followed by the header/edge and selected capacitor-land issues. The later tables account for all 62 references.

Whole-component orientation and trace bends are separate decisions. The +90/180-degree poses below rotate complete packages to face the relevant pins or connector mouth toward their destinations. **Copper still retains the existing 45-degree routing policy; no right-angle trace corner is authorized.** Shortness must come from placement and suitable 45-degree escapes, not waived routing rules.

## Coordinate frame and fixed mechanical relationships

All dimensions are millimetres, viewed from the component side, with origin at the northwest board corner, +X east and +Y south. The proposed outline is 21 x 51. Components are intended on F.Cu; B.Cu is primarily the continuous ground reference. The two-layer construction, USB impedance geometry, actual via strategy and fabrication rules remain unresolved. A component-side preference does not preapprove routing or ground continuity.

| Item | Reference-derived relationship / proposed anchor | Meaning and remaining limit |
| --- | --- | --- |
| J2 left row | Pad n = `(1.61, 1.37 + 2.54*(n-1))`, n=1..20 | J2.1/Pico1 at the USB end; J2.20/Pico20 at the south end. The 1.61/1.37 offsets are the arithmetic consequence of centring the verified 17.78 mm rows and 48.26 mm first-to-last span in 21 x 51 mm. |
| J3 right row | Pad n = `(19.39, 49.63 - 2.54*(n-1))`, n=1..20 | J3.1/Pico21 at the south end; J3.20/Pico40 at the USB end. A stock origin-at-pad1 header would be rotated 180 degrees relative to J2. Do not mirror its net map or reuse J2's downward numbering. |
| J1 USB-C | Provisional origin `(10.50, 3.675)`, rotation 180 | The stock mouth/`PCB Edge` line at local y=+3.675 faces north; this anchor aligns that line to y=0. Contact centres then lie at y=7.355. Final edge, shell, cable and stake fit need the GCT drawing, actual thickness and an assembled view. |
| U1 MCU | Provisional centre `(10.50, 22.00)`, rotation 0 | Chosen from the actual QFN pad locations below. This anchor gives the connector/ESD a separate area and reserves the exact-reference core group north of U1. |
| J4 SWD | Provisional pad1 `(7.96, 48.20)`, rotation +90 | For the inspected vertical 1x3 stock geometry, pins run west-to-east: SWCLK, GND, SWDIO. Pad centres are x=7.96/10.50/13.04. The courtyard would be x=6.19..14.81, y=46.43..49.97. Exact header/probe part, access and mounting holes still need review. |

The Pico reference specifies 1 mm main-contact bores and four 2.1 mm mounting holes. **No mounting-hole centres, screw-head keepouts, castellations or custom bare-contact lands have been invented.** They must be resolved before treating the provisional anchors as placeable. A header-only candidate is not automatically an exact mechanical replacement for Pico 2. [P, printed p.7 and Figure 3; local reference review]

Both 1x20 stock bodies fit nominally: each body is 2.54 x 50.80, leaving 0.34 mm from the body's outer side to the board edge and 0.10 mm at each end under the centred placement. However, the stock courtyard is x=-1.77..+1.77, y=-1.78..50.03 relative to pad1. J2 would occupy x=-0.16..3.38 and y=-0.41..51.40; J3 would occupy x=17.62..21.16 and y=-0.40..51.41. **The required courtyard/edge clearance is therefore not established.** No courtyard may be shrunk or clearance waived to make this fit. Select and qualify the actual fitted header or an authoritative bare-contact option first.

The resulting inner strip between the two stock courtyard boundaries is only **14.24 mm**, x=3.38..17.62. That is a useful conservative packing screen, not a new electrical keepout or proof that a stock header is approved.

## Why U1 faces this way

The inspected stock `QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm` has a 7 x 7 body, an 8.2 x 8.2 courtyard and perimeter pad centres at x/y=+/-3.45. At rotation 0:

| Edge / actual pins | Function | Placement consequence |
| --- | --- | --- |
| North, 46..50, x=+2.8..+1.2 | VREG_AVDD, PGND, LX, VIN, FB | Preserve the small buck group immediately northeast, before placing less critical parts. |
| North, 51/52, x=+0.8/+0.4 | USB DM/DP | R2/R1 immediately north of those pads; connector flow approaches along the central lane. DP is west of DM at U1. |
| North, 53/54, x=0/-0.4 | USB_OTP_VDD / QSPI_IOVDD | Reserve room for two separate local decouplers C14/C15; do not let USB resistors or flash use all this space. |
| North, 55..60, x=-0.8..-2.8 | QSPI IO3, clock, IO0, IO2, IO1, CS | Flash northwest, with short routes into this pin bank and BOOT branching at the flash end. |
| West, 1..15 | IOVDD/DVDD and GPIO0..11 | GPIO fanout heads toward J2; retain C5/C6/C11 at their actual supply pads. |
| South, 16..30 | GPIO12..18, XIN/XOUT21/22, DVDD23, SWCLK24, SWDIO25, RUN26 | Crystal and its load network immediately south; C4/C12 local to pin23; debug/reset escape continues toward accessible south controls. |
| East, 31..45 | GPIO19..29, supply pins38/39, ADC_AVDD44, IOVDD45 | GPIO/analog routes reach J3; ADC filter and VSYS sense stay in an east-side quiet region, separate from the core LX group above and the RT group below. |

This orientation is an engineering choice supported by the pin map, not a claim that all GPIO fanout is already routable. The long edge-header traces and ground-plane perforation still require a two-layer routing review. [D/H/K pin map; actual stock footprint]

## Floorplan and measured space

This diagram shows regions and relationships, not exact component shapes or clearance:

```text
                         NORTH / USB cable
  J2.1   +-----------------------------------+   J3.20 / Pico40
         |            J1 mouth               |
         |        CC / U4 ESD / C26      D1   |
         | BOOT     USB approach              |
         |    U3 flash       L1 core buck     |
         |    C18/C19       C1/C2/R8/C3       |
         |            U1 RP2350A   ADC/sense |
         |              Y1        RUN        |
         |            quiet clock      LED   |
         |          C21 / output             |
         |     L2       U2       controls    |
         |          C20 / input              |
         |                                   |
  J2.20  |          J4 SWD access            |   J3.1 / Pico21
         +-----------------------------------+
                         SOUTH
```

| Group | Proposed region or sizing anchor | Fit observation, not clearance acceptance |
| --- | --- | --- |
| USB receptacle | North-centred anchor above | Nominal body 8.94 x 7.35; stock courtyard 10.64 x 8.94, including its intentional connector-side extension. At the anchor it spans x=5.18..15.82, y=-0.505..8.435. Review the actual connector boundary; an external mating envelope is not blanket permission for copper or unrelated courtyards beyond the board. |
| ESD U4 | Below the connector, provisional centre `(10.5,10.6)`, +90 | SOT23-6 courtyard becomes 3.40 x 4.10: x=8.8..12.2, y=8.55..12.65. +90 places the D+ channel west and D- east, matching U1's eventual pair order. C26 and the ground return must still fit beside the actual return pins. |
| Flash U3 and local passives | Northwest; sizing anchor U3 `(7.2,16.2)`, rotation 0 | v2 flash courtyard 4.26 x 2.50: x=5.07..9.33, y=14.95..17.45. Pins5/6/7 are on its east side facing the QSPI bank; pin8 VCC is northeast. C18/C19 must stay at pin8, with C18 first. This pose is a starting comparison, not a solved six-signal escape. |
| Core buck | Exact U1-relative group in the next section | L1 at the proposed anchor occupies x=11.4..13.6, y=13.9..15.7 by its selected courtyard. Its switch-copper keepout and the USB reference region must not overlap. |
| Analog/sense | Immediately east of U1's upper-east pin bank, below the core filter | U1 courtyard ends at x=14.6; stock header inner courtyard begins x=17.62. Only 3.02 mm remains. Q1's courtyard is 2.30 x 2.10; analog passives must be ordered along this narrow region, not placed as a second wide block beside U1. |
| Clock | Immediately south of pins21/22 | Crystal body 3.2 x 2.5; the inspected generic 3225 candidate has a 4.2 x 3.5 courtyard. Exact ABM8-272 land compatibility remains pending. Keep the crystal, R7 and C24/C25 together before filling this region with debug/control traces. |
| BOOT | Upper-left, accessible below/beside the USB shell | The inspected Wurth stock courtyard is 5.7 x 3.7. A +90 rotation reduces its width to 3.7, useful in the left region. Pose remains pending the pin-number mismatch and cable/finger-access check. |
| RUN and LED | RUN south/east of U1, LED in the lower-right open region | Keep SW2 accessible without crossing the clock network; keep D2 visible with fitted headers. Neither needs to occupy a sensitive launch area. |
| RT power group | Lower interior, roughly y=32.7..42.3; sizing anchors below | Uses the selected 4 mm inductor and two 1210 parts rather than pretending they are the smaller Pico passives. Power-control and bulk lands remain conditional. |
| SWD | South end, anchor above | Courtyard fits nominally between header rows. Reserve probe insertion and mounting-hole space before accepting this anchor. |

Key stock footprint envelopes actually read for this review:

| Footprint / refs | Nominal body or F.Fab envelope | F.CrtYd envelope | Specific caveat |
| --- | --- | --- | --- |
| v2 RT6150B / U2 | 2.5 x 2.5 | x=-2.05..1.90, y=-1.55..1.55 | EP11 and both ground pins need real ground copper; its footprint is asymmetric. |
| `L_Coilcraft_XxL4020` / L2 | 4.0 x 4.0 nominal | 4.52 x 4.52 | Selected part body tolerance is +/-0.3 mm, maximum height 2.10 mm; this is substantially larger than L1. |
| `C_1210_3225Metric` / C20,C21 | 3.2 x 2.5 nominal graphic | 4.6 x 3.2 | Selected TDK maximum body is 3.65 x 2.85 x 2.85 mm. Stock land discrepancy remains unresolved; these bounds are for packing only. |
| `C_0402_1005Metric` / 24 capacitors | 1.0 x 0.5 | 1.82 x 0.92 | Pad centres +/-0.48; copper pads 0.56 x 0.62. Reference core lands differ. |
| `R_0402_1005Metric` / R1..R20 | 1.05 x 0.54 graphic | 1.86 x 0.94 | Pad centres +/-0.51; copper pads 0.54 x 0.64. |
| `SOT-523` / Q1 | 0.8 x 1.6 | 2.3 x 2.1 | Gate/source west and drain east at rotation 0; orient by the actual ADC/divider route, retaining source/drain identity. |
| `Nexperia_CFP3_SOD-123W` / D1 sizing candidate | 2.6 x 1.7 | 4.5 x 2.2 | Existing inventory ID `D_SOD-123W` is absent in this installation. This discovered exact stock candidate is not silently substituted. |
| `LED_0603_1608Metric` / D2 | 1.6 x 0.8 | 2.96 x 1.46 | Pad1 cathode/GND, pad2 anode/LED_A. |

The 14.24 mm inner strip is wide enough to explore this arrangement, but raw area cannot prove fit. Tight north-edge decoupling/USB escapes, the two converters' actual copper, header courtyards, unplaced mechanical holes and assembly access are the controlling constraints. No all-62-components overlap-free result is claimed.

## Core regulator: transfer the topology, then reconcile the lands

The following numbers are **exact recorded Minimal-reference offsets**, not invented maximum-distance rules. They are relative to U1 centre at rotation 0. Project references are mapped explicitly because the Minimal design uses different capacitor numbers. [K; local Raspberry Pi reference review, core-buck table]

| Project ref | Minimal ref / role | Offset X,Y | Rotation | Provisional absolute centre for U1=(10.5,22) |
| --- | --- | --- | --- | --- |
| L1 | L1, core inductor | +2.00,-7.20 | 0 | 12.50,14.80 |
| C2 | C7, COUT | +2.00,-5.55 | 0 | 12.50,16.45 |
| C1 | C6, CIN | +2.00,-4.61 | 0 | 12.50,17.39 |
| R8 | R3, AVDD filter | +4.20,-6.90 | -90 | 14.70,15.10 |
| C3 | C9, quiet AVDD capacitor | +4.20,-5.05 | -90 | 14.70,16.95 |

Preserve L1 marked pad1=1V1 and pad2=CORE_LX. C2 must take FB at its output node; return the switching-current group locally to U1's exposed-pad ground through the documented nearby ground arrangement. Keep C3's return quiet and separate from that local switching return. Minimize LX copper and remove extra top copper beneath the inductor; review its effect on the USB return corridor before routing. The reference switching ground vias are at offsets (+3.10,-5.50) and (+3.10,-4.90), and its quiet-filter ground via at (+3.85,-3.85), each 0.25 drill / 0.60 diameter. These are reference geometry, not accepted drill/annular-ring rules for a chosen fabricator. [D pp.454-455; K]

**Do not paste these coordinates onto different lands and call the group reproduced.** K's CIN/COUT pad centres are +/-0.515, filter C/R centres +/-0.475, and L1 centres +/-0.7. The selected stock capacitors use +/-0.48 and resistors +/-0.51. Only the chosen v2 Minimal L1 variant preserves its stated reference lands. The original C1/C2 spacing is 0.94 mm; stock 0402 capacitor courtyards would leave only 0.02 mm between them. The reference offsets also put stock C1's courtyard 0.05 mm north of U1's courtyard. These calculated gaps make the placement intentionally compact, but do not validate pad clearance, copper shape, thermal return, assembly or solder-mask manufacture. Qualify reference-compatible lands or re-engineer the group against the documented circuit constraints; do not waive clearance.

U1's stock footprint has one 3.4 x 3.4 exposed copper pad. It does not by itself reproduce K's nine drilled ground connections. Ground-via authoring, actual EP contact, paste/assembly treatment and the reference's local current returns remain explicit work. C4 stays at DVDD23 on the other side of U1, not beside L1.

## RT6150 group: a compact independent switching circuit

A physically reasoned **packing probe**, using the current conditional footprints, is U2 `(10.50,37.50)` at 0 degrees, L2 `(6.15,37.50)` at +90, C21 `(11.00,34.30)` at 0 and C20 `(11.00,40.70)` at 0. At this orientation U2's LX1/LX2 pins face west; L2 pad1 is south and pad2 north, facing LX1 pin4 and LX2 pin2 respectively. The 1210 positive pads are west, near the regulator's VIN5/VOUT1 side; their ground pads are east. This packs the switching path together instead of putting L2 across the board from U2.

Their individual stock courtyards are U2 x=8.45..12.40/y=35.95..39.05, L2 x=3.89..8.41/y=35.24..39.76, C21 x=8.70..13.30/y=32.70..35.90, and C20 x=8.70..13.30/y=39.10..42.30. The nominal U2/L2 courtyard gap is only 0.04 mm and the capacitor/U2 gaps only 0.05 mm. These are **sizing observations, not acceptable-clearance declarations**. They deliberately expose the space cost and require adjustment after land qualification and native DRC. Leave room east of U2 for C22 at VINA8, R9 at EN6 and R10 at PS7.

Keep the input loop C20/VIN5/GND local and the output loop VOUT1/C21/GND local. Minimize both RT_LX1 and RT_LX2 copper; the quiet FB10 trace senses C21's positive output node, away from L2/LX. Connect pins3/9/EP11 to the local power return and ground plane without forcing switching return through the ADC/crystal region. C22 is the separate local bypass for VINA8. The main 3V3 feed leaves from the output-capacitor node, and VSYS arrives at the input-capacitor node. [R, printed p.11]

D1 belongs near the USB/VSYS input end and right-row power contacts; its cathode feeds VSYS, its anode VBUS. Route the longer VSYS feed toward this lower converter outside the quiet analog filter, with width, loss and return checked for the actual current. The longer DC feed is not permission to lengthen the local hot loops. Keep this converter electrically and spatially distinct from U1/L1: `RT_LX1`, `RT_LX2` and `CORE_LX` are three different nets. L2's winding mark does not license swapping the selected net-to-pad mapping without a reviewed orientation decision.

C20/C21 remain blocked on the documented TDK land review: stock inner gap is 1.80 mm and pad width 2.70 mm, whereas the retained TDK recommendations are PA=2.00..2.40 and PC=1.90..2.50 (PB=1.00..1.20). No new land has been drawn here. Effective biased capacitance and both converters' electrical/thermal performance are also still open. [component-selection.md]

## USB flow and the interleaved Type-C contacts

Physical order is **J1 contacts -> short connector fan-in -> U4 -> paired trunk -> R1/R2 at U1 -> U1.52/51**. U4 remains near the connector with C26 at VBUS5 and a short return from GND2. R1/R2 terminate at the MCU; they are not moved to the connector to fill empty space. Their MCU-side pad1/port-side pad2 identities remain intact. R3 and R4 stay local to their own CC contact and ground, independent of the data path. Preserve both shield stakes on each side, all power/ground contacts and both NPTH locators.

At the proposed J1 rotation, left-to-right signal-contact order is B6(D+), A7(D-), A6(D+), B7(D-), all at y=7.355. Both D+ contacts and both D- contacts require real board copper. This prevents a simple straight same-side fan-in; **it does not prove all same-layer routing impossible**. Inspect a bounded detour on opposite sides of the pad row, while preserving clearance to adjacent contacts, body metal/locators, reference copper and the complete-channel length/skew budgets. Do not drop a contact, invent an internal connector tie or quietly introduce a via into the draft's forbidden-layer-transition case.

A read-only check of retained Orpheus source demonstrates the topology, not GCT compatibility: its J1 row is y=36.93; D+ joins below that row through y=37.681 and D- above it through y=36.179. Its six USB-named/split data nets contain only F.Cu segments and zero vias in the saved source. It uses different connector geometry and separates protection input/output nets, relying on actual package channel connectivity. Our inventory instead keeps U4 pins1/6 and 3/4 as physical anchors on their respective port nets. Therefore neither its coordinates nor its net simplification are transferable approval. No Orpheus asset/copper was copied. [O, source pinned in the local review]

For our U4 +90 pose, D+ pins1/6 lie west and D- pins3/4 east; the route enters the north contact of each channel and leaves toward the south. Every physical anchor still needs evidence. Do not claim an imaginary PCB segment through the protection package as copper; likewise, do not add a long external tie merely to satisfy an unsuitable connectivity checker. Resolve this with the selected-device connectivity model and the actual saved layout.

No generic numeric “within 2 mm”, zero-skew or maximum-branch rule has been invented. Short direct launches, matched pair flow, no uncontrolled stubs and a continuous ground reference are retained requirements. The final numeric budgets, permitted explicit branch topology, 90-ohm geometry, mask/stackup model and escape widths must be established before route authoring. In particular, the space between the proposed flash's east courtyard and L1's west courtyard is only about 2.07 mm where those regions overlap; decoupling, inductor copper restrictions and pair/reference clearance still need simultaneous resolution. The guide's example width/gap is not automatically valid for this board's unresolved stackup. [H, USB layout; ST, layout; design-draft-notes.md]

## All 62 references have a placement reason

The component groups below cover U1..U4, J1..J4, L1/L2, Q1, D1/D2, SW1/SW2, Y1, R1..R20 and C1..C26 exactly once. Subgroups describe physical attachment to actual terminals, not a shared net alone.

| Refs | Group and required association |
| --- | --- |
| U1 | Central pin-oriented anchor; EP ground and all supply escapes reserved. |
| U2,L2,C20,C21,C22,R9,R10 | Lower RT power island: C20->VIN5, C21->VOUT1/FB10, C22->VINA8; R9 at EN6/VSYS, R10 at PS7/GND. |
| U3,C18,C19,R5,R6 | Northwest QSPI group. C18/C19 at VCC8; R6 local CS1 pullup; R5 starts the BOOT branch near CS1, not at the far button end. Keep unbuffered QSPI branches short. |
| U4,J1,C26,R3,R4 | North connector/protection group; C26->U4.5, U4.2 short GND, independent R3/R4 at J1 CC1/CC2. |
| R1,R2 | USB launch group immediately at U1.52/51; pad1 faces the MCU and pad2 the port. Preserve the 27-ohm terminations and reserve equal-flow 45-degree launches with the separate C14/C15 supply bypasses. |
| J2,J3 | Mechanical anchors with opposite numbering directions, exact pitch/row spacing and pending accepted lands. |
| J4,R19,R20 | South debug access; reserve short MCU launches for SWCLK24/SWDIO25, then route to J4. R19 near the MCU clock entry; R20 begins near U1 as a provisional bidirectional SWD damping choice, subject to probe/interface review. |
| L1,C1,C2,C3,R8 | Source-relative core group described above; C1->VIN49, C2->FB50/output and local PGND47 return, C3/R8->AVDD46. |
| Q1,R13,R14,R15,C23 | Quiet east-side VSYS sense: R13/R14/C23 close to Q1 drain3; Q1 source2/R15 close to GPIO29 pin43; gate1=3V3. Keep the high-impedance sense node away from both inductors/LX, USB and crystal clocks. |
| D1 | North/right supply ingress, cathode=VSYS and anode=VBUS; selected land unresolved. |
| D2,R18 | Visible GPIO25 indication outside sensitive regions; R18 is series current limiting, not an MCU power decoupler. |
| SW1 | Accessible BOOT near flash group, preserving R5 current limiting and exact contact pairs. Cold-BOOT power sequencing remains a separate open issue. |
| SW2 | Accessible RUN/reset south/east of U1 and near the RUN route; keep away from crystal load nodes. |
| Y1,R7,C24,C25 | One quiet oscillator group at U1.21/22: R7 directly on XOUT22-to-Y1.3 path, C24 at XIN/Y1.1 and C25 at Y1.3; ground case2/4 locally. Exact crystal orientation must minimize those two loops after its footprint is qualified. |
| R16,R17,C16,C17 | Quiet ADC supply east of U1.44: 3V3->R16->ADC_VREF/J3.15->R17->ADC_AVDD44. C16 at pin44 with C17 adjacent; J3.13/Pico33 joins GND locally. Do not split AGND into an isolated plane or route switching return through this filter. |
| R11,R12 | VBUS divider at GPIO24 pin36, rather than beside the USB data launch; keep the divider output local, with a routed VBUS feed. |
| C4,C5,C6,C7,C8,C9,C10,C11,C12,C13,C14,C15 | Individual U1 supplies, mapped below; distribute by pin location, not in a decorative capacitor bank. |

| Ref | Supply pin | Side at U1 rotation 0 / attachment priority |
| --- | --- | --- |
| C5 | IOVDD1 | Upper west. |
| C6 | IOVDD11 | Lower west. |
| C7 | IOVDD20 | South, near the clock-side supply pin. |
| C8 | IOVDD30 | Southeast. |
| C9 | IOVDD38 | East, below the analog bank. |
| C10 | IOVDD45 | Upper east; preserve local return separately from switching-current paths. |
| C11 | DVDD6 | West; 1V1, not 3V3. |
| C12 and C4 | DVDD23 | South. C12 is local HF bypass and C4 the additional 4.7 uF bulk, physically remote from L1 as required. |
| C13 | DVDD39 | East; 1V1, not 3V3. |
| C14 | USB_OTP_VDD53 | North central; reserve its own capacitor despite dense USB escape. |
| C15 | QSPI_IOVDD54 | North central/west; separate from C14. |

For each bypass, the placement objective is a short pin-capacitor-ground loop with a local ground access, not merely a short distance between body centres. Feeding a whole supply rail through a long daisy chain of decouplers is not the intended topology. Noise-sensitive loops keep continuous reference/return copper; “quiet analog” does not authorize a ground split under signals. [D/H decoupling; P ADC circuit]

## Concrete gaps to close before native placement is accepted

1. **Header/edge/mounting fit:** actual fitted header or bare-contact source, full castellated/uncastellated decision, 1 mm bore tolerance, four hole centres and screw/cable/probe envelopes. The measured stock courtyard overrun is still present.
2. **Selected lands:** C20/C21 TDK land mismatch; reference core capacitor/resistor lands versus the selected stock 0402 lands; exact Y1 land comparison; D1's missing inventory ID. The v2 flash has a conditional land/assembly review, including 0.25 mm side-pad width versus up to 0.30 mm package contact width.
3. **Button numbering:** the inspected Wurth stock footprint has four physical pads numbered `1,1,2,2`; inventory SW1/SW2 has four logical vendor pins `1,2,3,4`, with contact pairs1-2 and3-4. A reviewed mapping/library decision is necessary. Do not bind these unchanged or silently merge/drop logical endpoints.
4. **Dense U1 north edge:** jointly solve R1/R2, C14/C15, six QSPI nets, flash bypass, the reference core group and USB reference corridor. Provisional macro anchors are movable if the actual geometry cannot satisfy all these constraints together.
5. **Complete USB path:** bounded opposite-side connector detours, all 14 signal anchors, exact ESD model, justified branch/launch/skew/etch budgets, actual stackup and reference continuity. Any needed change to the no-layer-transition constraint must be an explicit engineering decision, not a side effect of routing.
6. **Power/return copper:** short independent switching loops, correct EP/via connections, quiet C3/ADC returns, switch-copper restrictions, adequate VSYS/3V3 feeds and thermal area. Component placements alone do not satisfy them.
7. **Native evidence:** after admitted footprints and rules are available, place through the toolbox, inspect physical pads and both header numbering directions, render from component and bottom views, check courtyard/edge/mechanical access, author routes/ground, refill, save/read back, and collect independent ERC/DRC, complete connectivity and USB/reference checks. No such native evidence was generated by this planning task.

## Evidence used and scope of verification

Input precedence is [circuit-inputs.json](circuit-inputs.json) for connections, [component-selection.json](component-selection.json) for passive candidates, [v2 manifest](../../resources/pcb-libraries/rp2350-pico/v2/manifest.json) for the custom package, and actual installed footprint text for the measured geometry. Stock observations here came from `C:/Program Files/KiCad/10.0/share/kicad/footprints`; this does not assert that they are already admitted/bound for a project. The JSON companion retains SHA-256 identities and all 62 group assignments. A source/text geometry review and accounting check were performed, not a native CAD test or circuit qualification.

The local source reviews remain the detailed evidence record:

- [Raspberry Pi reference review](../../docs/research/rp2350-pico/raspberry-pi-reference.md): pin map, exact K offsets, regulator and decoupling requirements, mechanical dimensions and the unresolved USB-stackup mismatch.
- [Power selection](../../docs/research/rp2350-pico/power-selection.md): RT6150 pin map, topology and layout requirements.
- [USB selection](../../docs/research/rp2350-pico/usb-selection.md): GCT endpoints, ST protection and full-channel constraints.
- [Orpheus review](../../docs/research/rp2350-pico/orpheus-reference.md): pinned source identity and no-asset-copy boundary. The additional saved-route inspection above is read-only topology evidence, not a board-level assessment.

Primary sources: **D** [RP2350 datasheet](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf), pp.454-455; **H** [Hardware design with RP2350](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf); **P** [Pico 2 datasheet](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf); **K** [RP2350A Minimal KiCad](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip); **R** [RT6150A/B datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf); **G** [GCT USB4105 drawing](https://gct.co/files/drawings/usb4105.pdf); **ST** [USBLC6-2 datasheet](https://www.st.com/resource/en/datasheet/usblc6-2.pdf); **O** [pinned Orpheus source](https://github.com/hackclub/orpheus-pico/blob/05783d768ec096b691b0abdcdfd95991eee68c41/orphkicad.kicad_pcb). Live browser retrieval reopened R during this review; H/G retrieval failed, so their detailed facts above use the retained source review and footprint evidence, not a claimed fresh download.
