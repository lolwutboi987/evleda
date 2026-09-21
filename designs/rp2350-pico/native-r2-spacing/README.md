# RP2350 R2: corrected crystal-block spacing

This **22 x 60 mm, four-layer review candidate** has 1,098 tracks, 118 vias,
62 electrical components and four mounting bores. All 67 functional nets connect.
Configured native ERC/DRC and portable schematic parity are clean. Native save,
normal close and fresh read-only reopening are verified.

Open [the KiCad project](native/rp2350-pico-4layer.kicad_pro) with KiCad 10.0.3,
its stock libraries and the included native/library directory. The package includes
[top](previews/top.png), [assembly](previews/assembly.png), [schematic](previews/schematic.svg),
[pinout](pinout.md), [candidate BOM](bom-candidates.csv) and [BOM notes](bom-notes.md).
R2 names this delivery package; the retained board silkscreen still reads R1.

## Placement correction

The new reusable checker found a 0.02 mm C12–R7 courtyard gap against the
unchanged 0.10 mm requirement. R7 moves 0.10 mm left and the nearby GND via
moves 0.15 mm down to an existing diagonal endpoint. The redundant 0.15 mm
ground stub is removed. The resulting courtyard gap is **0.12 mm**.
All signal tracks, component rotations, via dimensions and clearance requirements
are preserved. Only R7's placement-region minimum X extends from 9.35 to 9.25 mm.
The [revision record](spacing-revision.json) and original failed baseline are retained.

All **62 placement rows** now pass against actual saved geometry and approved
courtyard sources. This checks the declared region, side, rotation, board-edge
bounds and pair spacing; physical housings, fasteners and assembly tolerances
remain separate. The original R1 remains available as historical evidence.

## Routing and checks

Both full-height GPIO service strips are clear of unrelated copper; 42 exact
own-pad inward leads remain. Header pitch/row spacing stay 2.54/17.78 mm.
The current source audit measures **886 straight/45-degree turns
with zero violations**, retaining 6 generic junction notices
and their pad/via attribution. All 19 declared geometric reference rows and
nominal drilled-copper paths from all 64 physical GND pads to the primary plane
pass. Existing debug-terminal launch conditions and margins remain unchanged.

The [complete native assessment](../../../proofs/placement-spacing-20260921/public-report.json)
records **225 pass, 349 unknown, 0 fail; accepted=false**. Unknowns include
unfinished assessment integration plus electrical and construction requirements;
they are not a count of observed defects. USB attach/startup/inrush, current,
voltage drop, physical copper/thermal widths and interface performance remain
open. The board is not yet an electrically accepted or manufacturing-ready design.

Read-only reopening retains placement results and all 67 connected nets without
recreating the earlier session's fresh-fill authority. Its plane/reference rows
remain unknown as returned. The four portable design files are byte-exact;
only the two library-table URI prefixes change for portability.

The native visual heuristic still reports WARN. Its four reference-overlap
warnings use hidden F.Fab fields; its body/off-board estimates center dimensions
on footprint origins. The [source and preview review](verification/visual-review.json)
retains all 13 findings and the actual header courtyards. Both current previews
were visually inspected. This is not a machine-certified visual or assembly pass.

ERC ignores single_global_label, four_way_junction, simulation_model_issue and
footprint_filter. DRC ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and footprint_type_mismatch.
Complete native reports retain checker settings and exclusions.

## Managed continuation

Continue with project **0474c726-1b0c-492b-b376-9c6a06ee9d72** in the existing qualified workspace.
Both edit and fresh read-only sessions closed normally. Parent **f464e518-2b03-453a-9f9c-a31f7d044d4a**
and the older protected allocation remain preserved. No historical lease or
unsafe marker was removed. Host60 is stored on D:, which must stay mounted.
Firmware, physical testing, board ordering and manufacturing release are outside
this delivered scope.
