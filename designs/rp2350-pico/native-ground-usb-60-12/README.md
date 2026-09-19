# RP2350 candidate 60-12: ground links and USB bend correction

The board remains **22 × 60 mm on two layers**, with the original GPIO pitch and row spacing. It now has **829 tracks, 104 vias and one B.Cu ground zone**. It is an unfinished candidate.

Nineteen front-copper ground segments join J2.13 to the BOOT-button ground, C8 to the C20/C22 ground group, and R10 to the main regulator ground. No vias or component moves were added. GND falls from 12 to **nine groups**, with **49 of 64 ground pads** in the main group. The C8/C20/C22 group still needs a main-ground connection.

The USB correction replaces 14 tracks with 17 across both D+ connector branches and the common D− output branch. This removes the prior 135-degree protection-pad turn. A single-branch correction was rejected because it increased skew; the coordinated version preserves the existing complete source-assessed length/skew, width, minimum-gap, topology, escape and branch limits. Source assessment is not USB electrical qualification.

Open the [project](native/rp2350-pico.kicad_pro), [PCB](native/rp2350-pico.kicad_pcb) or [schematic](native/rp2350-pico.kicad_sch). All six sources are exact native copies. Their library tables retain approved absolute Windows paths.

![Native front view](previews/board-top.png)

[Top SVG](previews/board-top.svg) · [Assembly PNG](previews/board-assembly.png) · [Assembly SVG](previews/board-assembly.svg) · [Bottom PNG](previews/native-bottom.png) · [Bottom SVG](previews/native-bottom.svg) · [Header pinout](../pinout-60mm.md)

## Current verification

| Check | Result |
| --- | --- |
| Configured ERC | Zero unexcluded findings; four ignored categories remain explicit. |
| Configured DRC | **FAIL:** 24 unconnected errors, 11 dangling-track warnings and two dangling-via warnings. |
| Clearance/courtyard/parity | No such findings reported by this configured run. |
| Functional nets | 53 connected; 14 disconnected, including GND. |
| Ground groups | Nine; largest group 49 physical pads. |
| Trace turns | 631 measured, zero violations; eight unresolved junctions remain. |
| GPIO service strips | Complete source audit clear on both faces, with 40 exact own-pad leads. |
| Ground geometry | Saved/native geometry verified and equivalent; 13 stored regions. |
| Overall acceptance | **False**; 8 failed rows and 424 unknown rows remain. |

See the [final collection](evidence/final-collection.json), [native endpoint report](evidence/final-endpoint.json), [plane assessment](evidence/final-plane-assessment.json), and [reviewed USB proposal](evidence/reviewed-usb-balanced-turn-v5.json). The source proposals retain their original pre-authoring status; the separate native receipts establish subsequent application and persistence.

DRC exclusions remain 'missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch' and 'footprint_type_mismatch'. ERC exclusions remain 'single_global_label', 'four_way_junction', 'simulation_model_issue' and 'footprint_filter'. Reported clearances and numerical via checks do not establish electrical or fabrication acceptance.

The last automated visual QA was at 826 tracks and retained eight warnings and six informational findings. The USB changes preserve every footprint, text item, outline and mechanical feature. All three final native views were separately inspected; functional labels remain unfinished.

## Placement and plane work remaining

Both line-side USB resistor pads still exceed their declared 2 mm MCU-distance bound. [The existing placement rectangles are infeasible](evidence/usb-placement-feasibility.json). [The courtyard lower bound](evidence/usb-placement-feasibility-courtyard.json) further shows that widening those rectangles alone is insufficient for a north-side resistor at its current 90-degree orientation: the minimum vertical distance is 2.10 mm. Orientation and launch routing require an explicit placement-intent revision; no bound was loosened here.

Host25 now passes a real native refill/save/readback and geometry assessment, both on unchanged 60-11 and this final source. Geometry equivalence does not establish one electrically connected plane, global drill-clipped continuity, thermal widths, impedance, physical performance or fabrication authorization. The full failed/unknown rows remain in the assessment.

## Saved checkpoint

PCB SHA-256: '505551e53c6c7fc6bff88848153ae7db75fa4aed45744dbffe9affcb5f44c8db'.
Checkpoint: '0283f35a0a4b24b3a830257ce5f47482798651ab075d090b233805af1151d532'.

[Normal close](evidence/final-close-proof.json) preserves all six sources and confirms no remaining project lease, editor lock or unsafe marker. SDK shutdown confirms an idle workspace. Earlier snapshots and failed studies remain preserved.
