# RP2350 R1 with explicit debug-terminal launches

This candidate preserves the completed **22 x 60 mm four-layer board**:
1,099 tracks, 118 vias, 62 electrical parts and four mounting bores. All 67
functional nets are connected. Configured ERC/DRC and portable schematic parity
are clean. Native save, normal close and fresh read-only reopen are verified.
Both board PNGs remain byte-identical to the earlier R1.

Open [the KiCad project](native/rp2350-pico-4layer.kicad_pro) with KiCad 10.0.3,
its stock libraries and the included native/library directory. The package
includes [pinout](pinout.md), [candidate BOM](bom-candidates.csv), [BOM notes](bom-notes.md),
[top](previews/top.png), [assembly](previews/assembly.png) and [schematic](previews/schematic.svg).

## Explicit connector transition

The [bound declarations](launch-requirements.json) separate at most 1.9 mm of
the J4 clock approach and 1.5 mm of the data approach, measured from their pad
centres, from the continuously referenced body. Both use J4.2 as the local
return within 2.54 mm. These lengths include the portion inside the signal pads.
The body keeps its full 0.25 mm margin. No trace, via, clearance, routing limit,
component, source circuit or canonical native rule changed.

Fresh native evaluation verifies both local launch rows: matching terminal
geometry, direct eligible ground contact, separation from all foreign bore
enclosures and configured native clearances. The body ribbons are covered.
The original [regional R1](../native-r1-regional/README.md) and its full-ribbon
failures remain preserved under their original requirements. This is a separate
intent revision through the public toolbox, not an edited old report.

## Remaining engineering review

The original [launch-qualified assessment](verification/assessment.json) records
143 pass, 431 unknown, 0 fail. The [current host57 assessment](../../../proofs/plane-region-network-20260921/native-assessment.json)
on these same native sources records **143 pass, 431 unknown, 0 fail; accepted=false**.
The primary plane's connected planar interior after drill subtraction is now
verified, including strict exterior separation of all four mounting bores. Each
of the 10 supplemental regions also has a verified interior after drilling;
its geometric connection to the primary plane through intact via annuli is
now verified, as is the declared supplemental island policy. Full terminal,
physical-width and current acceptance remain separate.
Local launch conditions do not prove complete drilled-copper return continuity,
impedance, cable performance or EMC. Supplemental In2 contact and area conditions
remain verified. USB startup/inrush, current/thermal suitability and other
electrical/construction checks remain open. The [startup screen](../usb-startup-screen-20260920/README.md)
does not establish a charging waveform or a current-control solution.

The current source audit retains all 887 measured straight/45-degree turns with
zero violations, both clear GPIO service strips and 42 own-pad inward leads.
GPIO pitch/row spacing stay 2.54 mm/17.78 mm. Six generic junction notices remain
attributed to actual pad/via centres. The four design files are byte-exact copies;
only two library URI prefixes change for portability.

ERC ignores single_global_label, four_way_junction, simulation_model_issue and
footprint_filter. DRC ignores missing_courtyard, track_not_centered_on_via,
tuning_profile_track_geometries, footprint_filters_mismatch and footprint_type_mismatch.
Header housings and fasteners remain assembly choices. This is a review candidate;
physical tests, firmware, board ordering and manufacturing release were not performed.

## Managed workspace reference

Continue managed work with project **7e129f34-8a45-454c-b8dd-cf06b770ba74**. The earlier
host53 workflow [restored this exact candidate](../../../proofs/plane-exterior-bores-20260920/managed-restoration.json)
through the existing public revision operation and closed it normally. All six
native files match the published candidate. The failed startup and interrupted
allocations remain preserved with their leases. No old live fill or electrical
acceptance authority transfers to the new allocation.

The [earlier host50 restoration](verification/managed-restoration.json) remains
historical evidence. The portable native files are unchanged.
