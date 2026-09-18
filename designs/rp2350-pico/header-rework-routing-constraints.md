# Header soldering and rework routing proposal — corrected

**The user requirement remains: no unrelated copper between external GPIO-header
pads on either board face, with clean inward connections. Keep two layers.**
The 0.50 mm service strips and centred horizontal exits below are our proposed
implementation, not dimensions or topology fixed by the user.

**Correction:** the previous statement that all 40 pads could have centred
inward connections was unproved and is withdrawn. The original audit checked
existing copper against strips; it did not check proposed exits against the
mounting bores and nearby component-pad clearances. Published V9 remains
historical and fails the new rework intent.

## Proposed service areas, not yet a feasible complete implementation

V9 retains J2/J3 centres at x=2.11/19.89 mm, 2.54 mm contact pitch, 17.78 mm row
spacing, 1.70 mm lands and 1.00 mm nominal plated holes. The proposed strips are:

| Row | X range, mm | Y range, mm | Faces |
|---|---:|---:|---|
| J2 | 0–3.46 | 0–51 | F.Cu and B.Cu |
| J3 | 18.54–22 | 0–51 | F.Cu and B.Cu |

The inner boundaries add 0.50 mm beyond each land's inner edge. Extending the
strips to the board edge prevents outboard bypass routing. This is a conservative
engineering choice, not a soldering-damage guarantee. It does not prevent pad
lifting, overheating or tool damage.

Retain the original header lands/barrels. Permit their own checked inward
connections; exclude unrelated tracks, ordinary via annuli and plane/pour copper,
including GND. GND pads need explicit inward spokes to interior ground rather
than fill between contacts. Keep all existing widths, clearances, drills and
45° rules. Solder mask is not an exception.

Centred normal leads are a preference, not mandatory user geometry. An offset
start inside its own land can be considered only with real full-width contact,
clean separation from neighboring contacts, a complete continuation and unchanged
board-edge/hole rules. None of the short offset starts below is adopted as a
complete route.

## Recheck of all 40 default exits

The JSON records each pad, actual net, retained lead width, proposed first-turn
point and per-face findings. Widths are at least the largest existing trace
touching that pad; unfed GND/power pads use the existing body floor. The checks
include actual NPTH/PTH bores, foreign component copper and the retained B-side
protected-reference geometry. Existing editable routing is not treated as proof
of a future complete connection.

| Centred first-turn attempt | Result |
|---|---|
| Blocked on both faces by mounting bores | J2.1, J2.20, J3.1, J3.20 |
| Additional F.Cu component-pad blockers | J2.7, J3.10, J3.12, J3.13, J3.14, J3.15, J3.16 |
| Hardware-clear short attempts | 29 on F.Cu; 36 on B.Cu |
| Still blocked under current net-layer policy | Four corners plus J3.10/RUN, whose current route is F-only |

The seven additional front blockers are R5.2, R12.1, R17.1, R15.1, Q1.3,
R13.2 and D1.1 respectively. A hardware-clear B lead is not a complete route or
permission to change an F-only contract. No declared B reference-ribbon collision
was found for these short attempts; ground continuity is still unqualified.

The four mounting bores are H1/H2 at (4.5/17.5,2.0), H3/H4 at (4.5/17.5,49.0),
radius 1.05 mm, with 0.25 mm hole-to-copper clearance. For J2.1, a 0.20 mm
centred lead ending at (3.56,1.37) is only 1.131592 mm from H1's centre. It needs
1.40 mm: bore radius + clearance + trace half-width. Its copper actually overlaps
the bore envelope by 0.018408 mm, before the required clearance is considered.
J2.20/J3.1 have the symmetric conflict. J3.20's retained 0.30 mm VBUS lead also
fails H2.

## Offsets do not yet solve the corners

Four explicit short offset starts, at y=0.80 or 50.20 mm inside their own pad
lands, clear the initial hardware screen without an edge-rule waiver. However,
their **continuations around the unchanged holes are not proved**. The VBUS
start has only 0.025834 mm of full-width embedding inside its circular land;
that numerical contact alone is not a robust rework qualification.

At a top mounting-hole centre, the copper passage between the board edge and
the hole is only:

2.00 − 1.05 − 0.25 − 0.50 = **0.20 mm**.

A 0.20 mm trace would have zero additional geometric reserve there, and the
retained 0.30 mm VBUS trace does not fit. Do not present this tight edge passage
as a repair, reduce width/clearance, or route through neighboring inter-pad gaps.
This local bound is not a proof that every conceivable fixed-hole topology fails.

## Explicit mechanical option for review only

A concrete alternative moves the top bores to y=2.75 and the bottom bores to
y=48.25, keeping x=4.5/17.5 and the 2.10 mm diameters. **It changes the mounting
pattern from 13×47 to 13×45.5 mm. No hole or header has been moved.**

With those hypothetical holes, the four recorded straight/45° corner lead
examples clear all actual component pads and bores. Their minimum copper-to-edge
gap is at least 0.82 mm; minimum copper-to-foreign-hole gap is at least
0.442102 mm, against the unchanged 0.50/0.25 mm rules. The proposed bores also
pass the scoped pad-copper and hole-spacing screen.

This is only an option: existing tracks/vias, fastener heads/washers, body access,
mechanical requirements, returns and complete nets remain unqualified. Changing
mounting locations, omitting holes or changing outline end clearance requires
an explicit mechanical decision; none is an implicit consequence of the new
routing preference. No header pitch, mounting pattern or floor is silently changed.

## Retained V9 impact inventory

The original conservative-strip audit remains useful as an impact inventory:
103 trace-segment conflicts (54 F / 49 B), nine ordinary vias and 23 sampled
inter-pad points containing stored GND fill. Of the trace findings, 74 use row
routing space and 29 are own-pad approaches needing reconsideration. These counts
are tied to that proposed implementation, not proof that it can be routed.

Direct examples include GPIO5's via (2.40,20.40) between J2.8/J2.9, and the
VBUS-sense GND via (19.55,25.50) between J3.11/J3.10. The JSON lists every
finding. The earlier zero count for other component pads physically *inside*
the strips did not account for clearance obstacles just beyond their boundaries.

Before further macro placement: resolve the corner/mechanical choice and the
front-pad blockers, reserve checked own-pad entries, then reroute global trunks,
ordinary vias and interior ground together. The existing fill already has
13 GND groups, 12 missing links and an undersized C6 island. Excluding row fill
also removes reference copper under the final lead; explicit header-ground
connections and return assessment remain necessary.

## Interface conclusion

Keeping 2.54 mm contact pitch and 17.78 mm row spacing is still the design
objective, **not a demonstrated all-40-exit solution**. The proposed interior
band is 15.08 mm wide, but width alone does not resolve the mounting-hole corner
conflicts. Enlarging only the board width while retaining header and hole
locations does not remove this local obstruction. Header spacing or hole changes
are consequential mechanical choices requiring explicit review.

The user prohibition and two-layer choice remain firm; the centred exits,
0.50 mm strips and any mechanical alternative remain proposed implementation
choices. Only these two notes were corrected. Canonical/source/native geometry
and published snapshots are unchanged.
