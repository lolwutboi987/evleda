# RP2350 final-target engineering review

This records read-only review of **unmanaged target 117**. It is not a claim that
the managed project has finished adopting the target, checkpointed or been
published. The final managed result must receive its own source-bound checks.

## Layout and placement intent

The board is 22 x 60 mm with four copper layers. The existing 2.54 mm GPIO pitch
and 17.78 mm row spacing are retained. F.Cu carries components and the declared
USB, QSPI, clock and debug reference routes; In1.Cu is the dedicated ground plane.
In2.Cu carries additional signals/power and supplemental ground fill. B.Cu carries
the remaining routing. The header service regions are protected on every copper
layer, including fill.

| Circuit group | Native placement and purpose |
| --- | --- |
| USB connector/protection | J1 is centred at x=11, y=4.975 mm; U4 USBLC6-2SC6 is directly below at (10.85,12). The connector's duplicated contacts and the protection device's documented internal transfer remain distinct copper graphs. |
| MCU and USB termination | U1 RP2350A is at (10.4,32.5). R1/R2, the 27 ohm USB series resistors, are immediately above the MCU at (10.06,27.5) and (11.94,27.65); the saved channel assessment checks the actual pin-based topology and lengths. |
| Flash and internal regulator | U3 W25Q32RV is at (6.05,24), above-left of U1. L1 is at (12.45,24.85), with the retained internal-regulator circuit. QSPI stays on F.Cu over In1 ground. |
| Clock and controls | Y1 is at (9.6,40.8), below U1. BOOT is at (5.5,39.5); RESET/RUN is at (13.5,19.7). Their accessible locations avoid the GPIO soldering strips. |
| External supply | U2 RT6150B-33 at (10.5,48.6), C20 at (14,47.96), C21 at (7,48.09), C22 at (11,45.96), and L2 at (10.5,53.01) form the lower power section. Input/output bulk capacitors are on opposite sides of the regulator. |
| Debug and mounting | J4 is on the bottom edge at y=57.2. Four 2.1 mm bare NPTH bores are at x=3.53/18.47 and y=2/58; screw-head or washer fit is not established by bare-bore clearance. |

These placements were coordinated with actual pad geometry, support-component
connections and routing corridors. Placement intent is not thermal or physical
qualification.

## Verified target geometry

`source-audit.json` binds this review to the target PCB bytes. It records 1,099
tracks, 118 vias, 66 footprints and two zones. The production numerical route
guard passes all 67 functional nets. All 887 measured sequential turns are
straight or 45 degrees. The six generic branch notices remain in the record;
their actual contacts are:

| Net | Position, mm | Physical feature |
| --- | --- | --- |
| 3V3 | 15.5,37.14 | C8.1 |
| 1V1 | 11.9,30.325 | Through via, 0.55 mm diameter / 0.20 mm drill |
| VSYS | 14,49.61 | C20.1 |
| VSYS_DIV | 17.78,25.5 | C23.1 |
| VBUS | 13.04,11.95 | Through via, 0.55 mm diameter / 0.20 mm drill |
| VBUS | 16.9,11.8 | D1.2 |

The full-height outer strips x=0..3.46 and x=18.54..22 mm contain no unrelated
tracks, vias, non-header copper pads or stored plane fill. Forty-two exact
straight inward copper leads connect their own header pads, including allowed
connections on different layers. The audit includes finite trace/via widths,
conservative non-header pad bounds and all 7,142 saved fill vertices.

The target's configured native DRC is zero, including unconnected and schematic
parity findings. Its native connectivity review has no disconnected functional
nets. DRC still ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and
footprint_type_mismatch; this is not unrestricted checker coverage.

## Interface and return-path limits

`usb-source-assessment.json` passes declared source-polarity mapping, complete
copper topology, widths, minimum opposite-polarity gaps, lengths, skew, stub and
uncoupled budgets, and transition restrictions. It matches saved construction
and source termination facts. Coupled-gap coverage remains not_assessed and
physical impedance remains unassessed. It does not qualify the package's internal
electrical delay, solder mask, actual material constants or a manufactured USB
channel.

The separate `reference-coverage.json` covers all 145 selected
segments on 19 declared reference nets at their original margins: 0.23 mm for
USB and 0.25 mm for the other declared nets. Sixteen nets are fully covered,
including all USB, QSPI and crystal nets and SWCLK_MCU. Four segment results
remain distinct:

- SWCLK_HDR has an uncovered approach to J4.1, whose signal through-hole needs
  clearance in the ground plane. The recorded witness is (8.13475,56.87475) mm.
- SWDIO_HDR has an uncovered approach to J4.3, with witness (12.84,56.5) mm.
- Two SWDIO_MCU segments around (13.9,38.055) mm are boundary_uncertain under
  the calculator's conservative ribbon bounds near the RUN through-via.

These findings are retained without reducing the required margins or claiming
complete debug return-path qualification. The check uses stored fill; live fill
freshness, drill-clipped continuity and intended-plane acceptance need the
managed collection. In1 has one stored filled component; supplemental In2 has
ten. Native all-net connectivity does not prove the contract's separate
single-plane-component requirement for In2, which remains to be assessed and
reported explicitly.

## Portable delivery preflight

`portable-copy-manifest.json` records the packaging trial.
PCB, schematic, project and rules are byte-exact copies. Only the custom-library
URI in each library table changes to `${KIPRJMOD}/library`; the original library,
its provenance and notices are included. This copy passes native ERC and DRC
with zero findings. Original source bytes remain unchanged. This does not claim
that the still-running managed authoring job or final managed-project delivery has completed.

Physical build, firmware, fabrication release, component derating at final
operating conditions, controlled-impedance manufacture and connector/fastener
fit remain outside this native-layout verification.
