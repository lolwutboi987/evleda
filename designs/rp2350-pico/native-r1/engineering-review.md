# RP2350 saved-candidate engineering review

The managed authoring, save, native checks, normal close and fresh read-only
reopen lifecycle are complete for this snapshot. Engineering acceptance remains
**failed/incomplete**, with 141 passed, 429 unknown and two failed contract rows.
The archive is a review candidate, not a fabrication release.

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


## Saved geometry and native checks

The PCB SHA-256 is `7b374f36237dd914d89cc6d676965a3dafe3ec11b47fb35c0d9bf6052ff56f57`. It contains 1,099 tracks, 118 vias, 66
footprints and two filled zones. All 67 functional nets pass the source numerical
route guard and native endpoint connectivity; the portable copy independently
queries all 265 named physical pads without disconnected functional nets or
foreign-net pad reachability. Configured ERC/DRC and strict schematic parity
report zero findings. These facts do not establish manufactured performance.

All 887 measured sequential turns are straight or 45 degrees. Six generic
junction notices are retained at real pad/via centres: C8.1, C20.1, C23.1, D1.2,
and the 1V1 (11.9,30.325) and VBUS (13.04,11.95) vias. The outer service strips
x=0..3.46 and 18.54..22 mm are clear of unrelated copper on every layer; the audit
includes finite track/via widths, 42 own-pad inward leads and 7,138 fill vertices.
GPIO pitch is 2.54 mm and row spacing is 17.78 mm.

ERC ignores single_global_label, four_way_junction, simulation_model_issue and
footprint_filter. DRC ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and
footprint_type_mismatch. The full checker reports are retained in verification/.

Visual QA reports off-board component bounds at J2/J3/J4, reference-overlap
warnings at C12/C18/Q1/R13, and body-overlap notices at C20/C21/H1/H4/J4/SW1.
All 132 Reference/Value properties are hidden on F.Fab; the reference-overlap
heuristic therefore does not establish visible front-silkscreen overlap.
Native top/assembly views were inspected, and native silk/courtyard checks are
clean under the listed settings. Stock graphic/bounding-box notices and actual
fitted header/fastener fit remain distinct; no selected header housing or
screw-head clearance is claimed.

## Findings still requiring engineering resolution

1. **Supplemental In2 pour:** BACK_GND has ten stored filled components, violating
   its bound single-component requirement. GND_PLANE on In1 has one component
   and verified scoped intended-plane connectivity. All-net connectivity does
   not waive the supplemental-plane policy failure.
2. **Plane-contact evaluation:** both plane-policy rows also retain unsupported
   USB shield-pad shape/property cases and eight GPIO ground pads without direct
   zone contact. Those header pads intentionally use inward access tracks to
   protect the service strips. The checker currently does not qualify that
   indirect contact as complete thermal/plane acceptance. Its failed rows are
   preserved, not relabelled as passes.
3. **Debug reference coverage:** SWCLK_HDR and SWDIO_HDR each have one uncovered
   segment approaching the through-hole debug connector. Two SWDIO_MCU segments
   near the RUN via remain boundary_uncertain. No reference margin was reduced.
   All USB, QSPI, crystal and SWCLK_MCU selected ribbons are geometrically covered;
   the complete three query batches cover 145 segments on 19 nets. Geometric
   coverage is not full high-frequency return-path qualification.
4. **Interface/construction:** saved USB source geometry passes declared polarity,
   copper topology, width, minimum gap, length, skew, stub, uncoupled-length and
   transition checks. Coupled-gap coverage and manufactured masked/plated
   impedance remain unassessed. The declared construction and original part/load
   conditions are retained in basis/; physical material, derating, current and
   thermal qualification are not inferred from geometry.
5. **Evaluator limits:** complete bore-aware intended-plane continuity, actual
   minimum copper width, complete island attribution and remaining mandatory
   general rows are not established. The full 572-row report is included, so the
   unknown count is not a claim of 429 demonstrated board defects.

## Saved workflow and portability

The edit session saved both complete native fills and closed normally. A separate
read-only session reopened the same six source files, repeated endpoint/native
checks and previews, and closed with the sources unchanged. Read-only reopening
does not recreate fresh-fill authority; the edit-session acceptance report is
retained separately. The four native design files in this archive are byte-exact;
only the two custom-library URI prefixes change to ${KIPRJMOD}/library.

The candidate BOM lists 62 electrical references; H1-H4 are board-only bores.
J2/J3/J4 fitted header MPNs are unselected, U1 requires the documented A4 stepping,
and C20/C21 use the later approved custom TDK lands. Firmware, physical bring-up,
board ordering and manufacturing release were not performed.
