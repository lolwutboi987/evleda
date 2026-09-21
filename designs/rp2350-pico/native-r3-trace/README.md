# RP2350 R3: remove a redundant 3.3 V routing loop

This 22 x 60 mm, four-layer review candidate contains 1,089 tracks, 118 vias,
62 electrical components and four mounting bores. All 67 functional nets connect.
Configured native ERC/DRC and portable schematic parity are clean.

Open [the KiCad project](native/rp2350-pico-4layer.kicad_pro) with KiCad 10.0.3,
its stock libraries and the included native/library directory. See the
[top](previews/top.png), [assembly](previews/assembly.png),
[schematic](previews/schematic.svg), [pinout](pinout.md) and
[candidate BOM](bom-candidates.csv). R3 is the delivery label; the retained
physical silkscreen still reads R1.

The new topology checker found a 3V3 loop where a trace already contacted a via
before taking a detour back to that same via. Nine existing In2.Cu segments were
removed. Every remaining track, all vias and all footprint geometry were
preserved. No clearance, turn, placement or electrical rule was relaxed.
The [revision record](trace-revision.json) binds the exact before/after sources.

Both full-height GPIO service strips remain clear of unrelated copper, with
42 exact own-pad inward leads. Header pitch and row spacing remain 2.54 and
17.78 mm. The source audit measures 876 straight/45-degree turns with no
violations; six generic junction notices retain their pad/via attribution.
All 62 placement checks, 19 geometric reference checks and nominal drilled-copper
paths from all 64 GND pads remain verified after fresh refill.

The [full assessment](../../../proofs/trace-topology-20260921/fresh-fill-report.json)
reports **559 pass, 15 unknown, 0 fail; accepted=false**. Of 66 declared trace
topologies, 64 pass. XIN and XTAL_OUT remain unknown because their live native
roundrect ratios need geometry support beyond the checker's exact integer-radius
model. Endpoint connectivity alone does not resolve those topology rows.

USB attach/startup/inrush, current/voltage-drop/thermal limits, physical copper
widths and interface performance still need review. This is an engineering
candidate, not an electrically accepted or manufacturing-ready board.

The saved board was closed normally and reopened read-only with the same six
source files and byte-identical top preview. Read-only results retain 330 pass,
244 unknown and 0 fail; prior fill/clearance authority is not recreated.
The four portable design files are byte-exact; only library-table URI prefixes
change for portability. Native visual findings and the inspected images are
recorded in [the visual review](verification/visual-review.json).

ERC ignores single_global_label, four_way_junction, simulation_model_issue and
footprint_filter. DRC ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and footprint_type_mismatch.
The complete native reports retain checker settings and exclusions.

Managed continuation uses project 0474c726-1b0c-492b-b376-9c6a06ee9d72, now holding R3. The unchanged
[historical R2 package](../native-r2-spacing/README.md) and exact pre-edit source
snapshot are retained. Host63 lives on D:, which must remain mounted. Firmware,
physical testing, board ordering and manufacturing release remain outside scope.
