# USBLC6 feed-through modeling correction

ST's [USBLC6-2 datasheet, DS4260 Rev.7](https://www.st.com/resource/en/datasheet/usblc6-2.pdf)
identifies pins **1/6 as I/O1**, **3/4 as I/O2**, **2 as GND** and **5 as VBUS**.
Figure 15 (printed page 10) models the input/output paths through package
resistance and inductance. Figure 17 (page 11) shows the corresponding PCB
connection and local 100 nF bypass. These are real internal electrical paths;
they are not PCB tracks or ideal zero-delay connections. The manufacturer PDF
was inspected through the document reader; no locally downloaded PDF hash is
asserted.

The retained [Orpheus source review](orpheus-reference.md) corroborates this
six-net approach. Its protection pins 1/6 and 3/4 use distinct native net names,
with series resistors between the protection device and MCU. No Orpheus artwork,
placement or copper is copied into this design.

The earlier EvlEDA four-net channel put both protection contacts of each
polarity on one native copper net. Its external parallel links passed copper
connectivity and DRC, but enclosed U4's supply/return access under the chosen
reference constraints. They are unnecessary when the actual device transfer is
represented explicitly.

The corrected candidate will retain the same 62 parts, all 262 logical pins,
all six U4 pins and all 14 USB signal anchors, on six native signal nets:

| Net | Physical terminals |
| --- | --- |
| USB_DP_MCU | U1.52, R1.1 |
| USB_DM_MCU | U1.51, R2.1 |
| USB_DP_ESD | R1.2, U4.1 |
| USB_DM_ESD | R2.2, U4.3 |
| USB_DP_PORT | U4.6, J1.A6, J1.B6 |
| USB_DM_PORT | U4.4, J1.A7, J1.B7 |

Total board nets become 67. The explicitly declared device transfers are
U4.1 ↔ U4.6 and U4.3 ↔ U4.4. Each native copper graph must remain independently
connected; the channel composes them through those manufacturer-backed transfer
declarations and the existing source resistors. Wrong pin pairs, lost contacts,
polarity swaps or fake native copper bridges remain invalid.

PCB etch length/skew includes all three copper sections per polarity. Package
electrical length, delay, skew and parasitics remain **not assessed**. Existing
ground/supply, polarity, width/escape, routing and native ERC/DRC requirements
remain applicable; no reference margin or copper clearance is reduced.

A source-only geometry check removing just `dp-esd-link:0` and
`dm-esd-link:0` opens a 0.30 mm local F.Cu VBUS escape:
`(9.60,11.0125) → (9.60,11.90) → (9.85,12.15) → (11.30,12.15)`.
Measured minimum foreign-pad and USB-trace gaps are 0.325 mm and 0.444622 mm,
respectively. The subsequent joint plan also supplies ground access with the
full 0.90 mm reference-drill guard. These are source-plan results, not a native
six-net board, complete power route, ESD-system test or impedance qualification.

The preceding native USB38 diagnostic and every four-net draft remain preserved
as historical evidence. The correction requires a revised compiled draft and a
source-bound interface model; existing project bindings are not edited in place.

The first real-source compile with this model is ready with **62 components,
67 nets and four board features**, using the unchanged approved v4 package. Its
separate source-plan replay has 41 proposed USB tracks and reaches all 14 signal
anchors. Topology, polarity, width, minimum gap, combined length/skew, branch,
uncoupled-length and transition checks pass. Full copper-path skews are
0.420167 mm to the A contacts and 0.945519 mm to the B contacts, within the
unchanged 1 mm budget. The B-contact output path has no unique forward coupled
interval, so its coupled-gap check remains **not assessed**. Package delay/skew,
native six-net routing and actual ground-reference/impedance acceptance remain
unassessed. This replay is a proposed-pose diagnostic, not the final placement
freeze or a completed native candidate.

Local evidence: `destination-verification/rp2350-feedthrough-preflight-01`, with
the exact draft/bundle, input primitives, full channel result and source hashes.
