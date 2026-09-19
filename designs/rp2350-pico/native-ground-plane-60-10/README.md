# RP2350 candidate 60-10: first saved ground plane

This normally closed **22 × 60 mm, two-layer** candidate has **797 tracks,
104 vias and one B.Cu ground zone**. All existing routes, footprints and the
five non-PCB source files were preserved. **The board remains unfinished.**

Native DRC unconnected findings fell from 66 to **32**, with **13 dangling-item
warnings**. No clearance violations were reported. Endpoint checks still show
**53 connected nets and 14 disconnected nets**: GND remains split into **17
physical-pad groups**, with 40 of its 64 pads in the largest group.

Open the [project](native/rp2350-pico.kicad_pro), [PCB](native/rp2350-pico.kicad_pcb)
or [schematic](native/rp2350-pico.kicad_sch). All six native files are exact byte
copies. The library tables retain approved absolute Windows paths; this snapshot
does not install those libraries or recreate a managed EvlEDA allocation.

![Native bottom copper](previews/native-bottom.png)

[Top PNG](previews/board-top.png) · [Top SVG](previews/board-top.svg) ·
[Assembly PNG](previews/board-assembly.png) · [Assembly SVG](previews/board-assembly.svg) ·
[Bottom SVG](previews/native-bottom.svg) · [Header pinout](../pinout-60mm.md)

Top and assembly are native public-tool exports. Bottom is a separate read-only
KiCad CLI export, rasterized on white. All three views were inspected. The
original 2.54 mm GPIO pitch and 17.78 mm row spacing remain unchanged.

## Ground and GPIO service regions

The bound GND plane occupies x3.46–18.54 mm and y0.5–59.5 mm on B.Cu, with
0.15 mm clearance, 0.2 mm configured minimum width, solid pad connections and
the existing island policy. Those settings were not loosened.

The complete non-fill audit finds no service-strip violations in tracks, vias
or pads. Only 39 exact own-pad inward leads use strip permissions. All 2,344
stored straight fill vertices lie within the central band: x3.46–18.54 mm,
y0.5005–59.4995 mm. Their conservative enclosure establishes that the stored
fill does not extend into either full-height GPIO service strip. GND receives
no exception for unrelated copper.

The [original full audit](evidence/ground-plane-header-strip-audit.json) remains
**unknown** because polygon normalization exhausted its predicate-work bound.
The separate [bounds proof](evidence/ground-plane-header-bounds.json) establishes
service-strip exclusion without claiming polygon validity, fresh fill,
connectivity or clearance. It does not raise that work limit or relabel the
full audit as a pass.

The [ground groups](evidence/ground-components.json) identify the missing ties.
They include the four switch ground pads, several header grounds, filter-cap
groups and a USB-shield/header group. Component-internal conduction is not
inferred. Ground fill alone did not connect all these members.

Still disconnected: **3V3_EN, GND, GPIO16, GPIO17, GPIO18, GPIO22,
GPIO24_VBUS_SENSE, GPIO26, GPIO29_VSYS_SENSE, GPIO3, GPIO4, GPIO5, GPIO7 and RUN**.

## Current checks and limits

| Check | Result |
| --- | --- |
| Configured ERC | Zero findings. |
| Configured DRC | **FAIL:** 32 unconnected errors, 11 dangling-track warnings, two dangling-via warnings. |
| Clearance/courtyard/parity | No such findings reported by this configured run. |
| Sequential trace turns | 598 measured; the USB protection-pad 135-degree direction-change flag remains. |
| Junction coverage | Eight unresolved junctions remain. |
| USB placement | Both line-side series-resistor pads still exceed the declared 2 mm bound. |
| Visual QA | Eight warnings and six informational findings, unchanged from 60-09. |
| Design acceptance | **False.** Full ground/return paths, routing, labels and electrical/DFM work remain. |

The [native checks](evidence/native-checks.json) retain checker exclusions and
complete counts; the public DRC finding table returns eight of 45 rows. Ignored
DRC categories remain `missing_courtyard`, `track_not_centered_on_via`,
`tuning_profile_track_geometries`, `footprint_filters_mismatch`, and
`footprint_type_mismatch`.

The [plane/interface assessment](evidence/plane-response.json) preserves eight
failed rows and 424 unknown mandatory rows. Ground connectivity and policy fail;
full fill topology is unverified. Several USB-shield pad/contact forms remain
unsupported. Aggregate DRC findings also prevent numeric-rule and plane-clearance
acceptance; these row failures are not new reported copper-clearance violations.
USB topology/geometry/termination rows retain their series-resistor placement
failures, and impedance/return-path qualification is incomplete.

No turn-policy waiver or component move occurred. See the retained
[visual-QA triage](evidence/visual-qa-source-triage.json) and
[complete review](evidence/ground-plane-review-completed.json).

## Saved state and tooling

The host24 adapter uses the already-supported compact PAD envelope inside plane
validation. The earlier rejected attempt left all six files and its checkpoint
unchanged; the [reviewed offline recovery](../../../docs/unchanged-plane-session-recovery.md)
archived its exact metadata before releasing the unchanged checkpoint. The
new session then resumed, applied the plane, saved/read back, checked, rendered
and closed normally. The failed stage was never promoted into saved-fill authority.

- PCB: 452,769 bytes; SHA-256 `243038ff17433da64f76314af6591ee7edb43148a27df81aad3df7da8bfc9ab2`.
- Checkpoint: `c10d49af2f00a7c851702656d7b31e7e1b9d39f3cf1d6c4e713f60bd683b6b12`.
- Allocation: `b2e1adba-cf6c-4ccf-a51f-00f63320d6eb`.

All sources matched through checks, previews and [normal close](evidence/ground-plane-close-proof.json).
No lease, editor lock or unsafe marker remained. SDK shutdown confirmed an idle
workspace. The saved-fill observations belong to that closed session; a later
editing session must refill/save before relying on fresh plane acceptance facts.
