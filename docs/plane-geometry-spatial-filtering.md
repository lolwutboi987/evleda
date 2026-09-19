# Exact spatial filtering for native plane geometry

The RP2350 ground pour contains 2,344 stored contour vertices. The original
checker compared each edge with every vertex while splitting fracture walks,
then compared all boundary edges. It exhausted the existing 4,000,000-operation
limit before validating this ordinary board-sized fill.

The checker now builds bounded spatial indexes for vertices and edges. Bounds
are exact integer-nanometre rectangles, and touching rectangles remain candidates.
Sorting, index visits, candidate tests and full geometric predicates are charged
to the same work budget. The original predicates still decide collinearity,
crossing, overlap, tangency, bridge cancellation, hole containment and region
equivalence. No geometry is simplified before those checks, omitted, rounded or
accepted on its bounding box alone.

The limits remain 8,192 aggregate source/native vertices and 4,000,000 operations.
A large simple contour now validates, while an adversarial overlapping-candidate
case still stops at the work limit. Existing malformed geometry cases continue
to reject.

Six focused suites passed **235 tests**, covering filled geometry, saved evidence,
plane acceptance, public wrappers and header service strips. Source/UI typechecks
and an isolated backend build passed. Compiled replay of the real 60-10 and
60-11 saved boards against their recorded native fill validates the geometry
in **919,404 operations**, with 13 copper regions and two stored contour holes.
Plated and other board-drill subtraction remains a separate question. Both source
and native inputs are preserved.

The compiled host25 build is separate from the native host24 used for
[60-11](../designs/rp2350-pico/native-ground-links-60-11/README.md). Live host25
qualification remains pending. Geometry equivalence does not grant fresh-fill
authority, prove drill-clipped continuity or approve the remaining routing,
return paths, electrical behavior or fabrication.
