# RP2350 R1 with explicit supplemental ground policy

This separate native candidate preserves the physical R1 board: **22 x 60 mm,
four layers, 1,099 tracks, 118 vias, 62 electrical parts and four mounting bores**.
All 67 functional nets are connected. Configured ERC/DRC and native schematic
parity are clean. Both board preview PNGs are byte-identical to the prior R1.

Open [the KiCad project](native/rp2350-pico-4layer.kicad_pro) with KiCad 10.0.3
and its stock libraries, keeping the included native/library beside the project.
[Pinout](pinout.md), [candidate BOM](bom-candidates.csv), [BOM notes](bom-notes.md),
[top view](previews/top.png), [assembly view](previews/assembly.png), and
[schematic](previews/schematic.svg) are included.

## Explicit policy change

The primary In1 ground plane retains its single-component requirement and every
required signal/interface reference. The supplemental In2 pour now explicitly
permits separate stored regions, each requiring qualified native/source via
contact to the primary and a retained-area lower bound above the unchanged
**1 mm2** floor. Native island removal remains enabled. The [bound policy](policy.json)
records the reference and engineering rationale.

The separate public revision operation preserved the original project, circuit,
placement, construction, routing and numeric constraints. It rebound only the
owned identifiers needed by the new compilation. Original [native R1](../native-r1/README.md)
and its failed single-component requirement remain available; no old result was
relabelled and no saved contract or checkpoint was edited in place.

## Verification and limits

Both planes were freshly filled and saved. All ten In2 regions have qualified
via contacts; their conservative retained-area bounds meet 1 mm2, with the
smallest approximately **1.024 mm2**. The native project closed normally, then
reopened read-only with all six source files unchanged and repeated native
connectivity/checks clean. The portable copy changes only two library URI prefixes.

All 887 measured sequential turns meet the straight/45-degree rule. The full-height
GPIO service strips are clear, with 42 permitted own-pad inward leads. Native
via/copper/hole checks remain active under the same constraints. Six generic
junction notices remain attributed to actual pad/via centres in the source audit.

The full [assessment](verification/assessment.json) is still **incomplete: 141 pass,
431 unknown, zero fail; accepted=false**. Regional contact and area conditions are
verified, while complete drill-clipped continuity, physical widths/current
capacity, debug-header launches, USB startup/inrush and other electrical checks
remain open. The [startup screen](../usb-startup-screen-20260920/README.md) is not a
measured waveform or a current-control solution. The prior [exact debug review](../native-r1-followup-review/README.md)
retains its nominal scope; unchanged routes, bores and normalized fill geometry
are documented in [geometry equivalence](verification/geometry-equivalence.json).

ERC ignores single_global_label, four_way_junction, simulation_model_issue and
footprint_filter. DRC ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and
footprint_type_mismatch. Full reports retain visual/bounding-box notices; selected
header housings and fasteners remain unqualified. The GPIO pitch and row spacing
remain 2.54 mm and 17.78 mm. Physical tests, firmware, board orders and manufacturing
release were not performed. This remains a review candidate.
