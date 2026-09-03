# Realistic pad and drill geometry contract

The native verifier uses board-input schema **2**, engine **2.0.0**, and report
schema **3**. The version change is intentional: schema 1 represented every pad
as a circle, so retaining its hashes after adding physical pad geometry would
have been misleading. Schema-2 input hashes use the
`pcb-board-graph-v2` domain and reports use `pcb-verification-report-v3`.

## Physical records

Electrical `Component.pins` remain logical symbol pins. Physical copper is a
separate `BoardGraph.pads` tuple of `PhysicalPad` records. Each record binds:

- a unique `pad_id`, component, and reviewed logical `pad_number`;
- an optional exact net (or the net derived from that logical pin);
- center, X/Y size, `circle|rect|oval|roundrect`, rotation, and copper layers;
- legacy drill minor dimension plus exact drill X/Y and rotation; and
- an optional `shared_land_group_id` for multiple logical pins implemented by
  one coincident land.

`BoardGraph.holes` contains plated pad-associated holes and unplated mechanical
holes. NPTH records intentionally have no net. They remain clearance obstacles
on every copper layer and are checked against the board edge.

Several physical pads may share a logical pad number, which covers repeated
connector shell stakes without inventing schematic pins. A shared-land group is
different: its members must use distinct logical pad numbers while describing
one identical component/net/center/shape/size/rotation/layer/drill geometry.
The verifier emits a fatal topology finding and blocks every shape-dependent
rule when a group is singleton, duplicated, mixed-net, or misaligned. Valid
groups contribute one copper obstacle while preserving all logical bindings.

## Exact geometry

For rotations at 0, 90, 180, or 270 degrees, the verifier decomposes copper into
an exact rational core and a circular Minkowski radius:

| Shape | Exact core | Radius |
|---|---|---:|
| circle | point | diameter / 2 |
| oval | major-axis segment | minor size / 2 |
| rectangle | axis-aligned rational box | 0 |
| circular/oval drill or NPTH | point/major-axis segment | minor drill / 2 |

Distances between points, segments, and boxes use integer/rational arithmetic.
The same primitives drive inter-net clearance, copper-to-zone clearance,
board-edge clearance, NPTH clearance, routed connectivity, and via attachment.
Odd-nanometre dimensions therefore retain exact half-nanometre boundaries; no
float or enclosing/minor-circle substitution occurs.

Centered plated drills use their board-oriented X/Y spans for deterministic
containment and minimum-annular-ring checks. Quadrant-oriented slots are exact
capsules. Plated holes must match their physical pad drill X/Y and normalized
rotation exactly. Duplicate pad and hole identifiers are fatal and also become
named geometry blockers.

## Fail-closed limitations

The current integer/rational kernel has no source-bound primitive for:

- arbitrary, non-quadrant pad or slot rotations; or
- roundrect corner radius, because the canonical `FootprintPad` currently
  carries only the shape name and no reviewed radius/ratio.

The adapter preserves all available fields but adds a stable named blocker.
The engine records that blocker in `RuleExecution.blocker_ids`, marks copper
clearance, board-edge, routing-connectivity, via-attachment, and pad-annular
rules `NOT_RUN`, and the required gates fail. It never assumes a 25% roundrect
radius or silently substitutes a circle. A future exact implementation must add
source-bound roundrect radius and an oriented deterministic kernel before these
cases can pass.

Locked metadata, unsupported schematic drawing primitives, and other unrelated
adapter losses remain explicit `unsupported_features` and continue to produce
mandatory fatal coverage findings.
