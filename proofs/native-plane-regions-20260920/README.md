# Native contacts joining the ten supplemental ground regions

The new read-only `planeRegionBridges` observation verifies a qualifying via
contact for **all ten In2 ground regions** in the saved RP2350 R1. Each contact
disc has a nominal radius of 87,499 nm and lies inside that region, inside the
primary In1 region and inside the same ordinary through-via's copper annulus.
All 171 conservatively enclosed pad/via bores were included in the exclusion
check. Matching native direct-via contacts on both zones are required.

This is stronger than sharing a ground-net name or sampling a point: each disc
has positive area with strict boundary and bore separation. It is still a scoped
stored/native geometry observation. It does not establish complete drill-clipped
continuity everywhere in a plane, minimum copper width, current capacity or
manufacturing tolerance.

## Qualified input and calculation

The owning assessor requires the authenticated bundle, current saved native fill,
exact source/rules, complete source/native inventories and qualified clearance
checks. The primary plane must have one attributed component with complete native
endpoint reachability and an eligible direct pad anchor. Both zones must retain
their matching filled geometry, net, layer and native non-island flags.

Candidate vias must appear in both native zones' direct-contact sets. Their
exact source grammar must describe normal F.Cu-to-B.Cu through vias, with no
blind, microvia, conditional flashing or uncharacterized padstack modifiers.
All physical pad drills and source via drills remain inventoried. Circle
enclosures conservatively include slots and offsets; additional unsupported
drilling/machining makes the observation unavailable.

The geometry helper uses integer coordinates and rational squared distances.
It chooses interior annulus points and bounds a complete disc by both plane
boundaries, the via's inner/outer copper limits and every bore enclosure.
Integer floor/ceiling operations and a 1 nm inward margin preserve strict
containment. No tolerance hides a touching boundary. Missing contacts or exhausted
work bounds yield unproven results, never a partial all-regions pass.

## Actual native result and unchanged policy

Host46/DOC17 resumed the existing project, refilled both planes through public
tools, completed mandatory save/readback, ran the new observation and closed
normally. All six source files stayed byte-identical to native R1, including
PCB SHA-256 `7b374f36237dd914d89cc6d676965a3dafe3ec11b47fb35c0d9bf6052ff56f57`.

The [ten contact records](region-bridges.json) identify each region, via UUID,
disc centre and radius. The calculation used 2,562,448 predicate operations
within its declared four-million-operation bound. Native DRC stays clean,
endpoint connectivity stays connected and In1's local thermal policy remains
verified. [Saved lifecycle](lifecycle.json) and [full assessment](assessment.json).

**The single-component policy still fails.** This observation does not change
the contract or promote any existing verification row. The assessment remains
141 passed, 430 unknown and one failed, with `accepted=false`. Any policy allowing
several grounded supplemental regions must be an explicit, separately reviewed
design revision; no such revision was created here. The primary reference-plane,
header-launch, area/continuity and electrical/startup requirements remain intact.

## Software and delivery

The frozen host passes 119 focused tests in five files, source/UI typechecks,
backend build and native-helper packaging. Cases include missing regional anchors,
reference-plane holes, foreign bores, tangency, incomplete/duplicate inventories,
extra machining, sub-nanometre source quantities, lost live-fill authority,
missing native contacts, native island flags and incomplete public projections.
[Software evidence](software-verification.json) and [test log](focused-tests.log)
retain the scope. The earlier [offline replay](offline-replay.json) is separate
from the subsequent actual native qualification.

The existing client now uses host46 with the same DOC17 profile and updated skill;
unrelated settings, workspace, edit policy and timeout are preserved. A fresh
actual Codex client discovers 17 tools. Cached desktop activation is not claimed.
[Client verification](client-verification.json).
