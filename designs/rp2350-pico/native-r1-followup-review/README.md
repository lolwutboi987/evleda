# R1 ground and debug findings: focused follow-up

The published native R1 PCB remains unchanged at SHA-256
`7b374f36237dd914d89cc6d676965a3dafe3ec11b47fb35c0d9bf6052ff56f57`.
This review narrows the earlier findings; it does not replace the recorded
failed/incomplete acceptance report or authorize fabrication.

## Supplemental ground regions

[The component map](in2-regions.png) shows In2 ground regions in different
colours, In2 signal tracks in dark blue and through-ground vias in red. The
dedicated In1 ground plane remains one stored component.

Every one of the ten In2 stored regions has at least one sampled pad/via copper
contact whose native connectivity reaches all named ground terminals. None is
marked as an island by the loaded native model. The full source-bound polygons,
contact sample coordinates and reachable terminal lists are in [regions.json](regions.json).
This supports ground attachment in the native model; point sampling is not a
complete drill-clipped continuity or high-frequency return-path certificate.

The existing contract still requires one connected planar region for each pour.
Its In2 failure therefore remains. The new evidence distinguishes that policy
mismatch from a claim that the ten regions are floating. No contract, plane,
clearance rule or source copper was changed to remove the failure.

## Debug reference geometry

The existing helper bounds a circular trace ribbon between a diamond and a
square. Its two SWDIO_MCU `boundary_uncertain` results do not prove missing
copper: the outer square intersects the RUN-via opening even when the circular
ribbon does not.

[The independent exact-distance review](exact-debug-distance.json) checks all
six original SWDIO_MCU segments against all 3,379 retained In1 boundary edges.
It uses integer/rational squared distances, strictly interior endpoints and the
original trace width plus 0.25 mm margin. All six Euclidean ribbons are strictly
inside the stored fill. The tightest excess beyond the requested margin is
**0.002317 mm**; the other formerly uncertain segment has 0.023397 mm excess.
These are nominal saved-geometry results, not manufacturing-tolerance or
electrical-performance qualifications. Opposite directed edges within each
fractured ring cancel; all other edges remain in the distance check.

The original route is retained. Three via/route proposals failed native
clearance checks; a fourth local jog passed DRC but did not resolve the coarse
helper uncertainty. None was adopted. The separate SWCLK_HDR/SWDIO_HDR uncovered
approaches to signal through-holes remain unresolved under the bound continuous
reference requirement. This review creates no implicit launch exception.

## USB shield-pad checker correction

The source thermal-policy checker now admits ordinary oval pads and the exact
`pad_prop_mechanical` fabrication marker. EvlEDA's physical-pad model already
supports oval copper and oblong drills. KiCad documents the oval shape, and its
library conventions require the mechanical marker for through-hole shield pads:
[pad format](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/#_footprint_pad),
[fabrication properties](https://klc.kicad.org/#f6-3-pad-requirements-for-smd-footprints).

The correction retains complete source/native shape validation, local thermal
and zone-connection restrictions, required native contact and all clearance
checks. Unknown, quoted, duplicated or nested properties are not admitted.
The new positive oval/slot cases and negative override cases pass with the
existing checks: **254 tests in three files**, source typecheck and backend
build. A stale connector fixture was corrected to explicitly declare its
original two copper layers; no production layer check was weakened.

This is source/software qualification. The installed host43 and native R1's
earlier assessment have not been replaced or retrospectively relabelled. The
eight indirect GPIO ground-pad contacts and full plane/reference acceptance
still need separate treatment. [Verification details](verification.json) retain
code/evidence hashes and diagnostic scripts. The published scripts resolve the
adjacent native-r1 snapshot and accept a fresh output path. Both were replayed:
the native component map and exact-distance report match the retained results.
Run the Python script with the qualified KiCad 10.0.3 Python runtime; the distance
script uses Node.js and the bundled read-only geometry. Neither saves a PCB.
