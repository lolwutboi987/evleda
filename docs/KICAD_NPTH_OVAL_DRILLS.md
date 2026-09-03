# KiCad NPTH and oval-drill contract

This document defines the exact KiCad file-boundary semantics implemented by
`backend.kicad_io`. It is intentionally narrower than everything KiCad can
represent: every accepted construct is losslessly bound to integer geometry,
and unsupported geometry fails closed.

The primary grammar reference is KiCad's official
[S-expression format](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/index.html#_footprint_pad).
KiCad defines `np_thru_hole` as a pad type and defines drill syntax as
`(drill [oval] DIAMETER [WIDTH] [(offset X Y)])`. KiCad's serializer source
also emits the `oval` token from its oblong drill-shape state:
[pcb_io_kicad_sexpr.cpp](https://gitlab.com/kicad/code/kicad/-/blob/master/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp).

## Public IR fields

Every `Pad` exposes these exact drill facts:

- `kind`: `PadKind.SMD`, `PadKind.THROUGH_HOLE`, or `PadKind.NPTH`.
- `drill_x_nm` and `drill_y_nm`: authoritative local drill dimensions in
  integer nanometres. Both are zero for SMD, equal for a circle, and distinct
  for an oval slot.
- `drill_shape`: derived `None`, `PadDrillShape.CIRCLE`, or
  `PadDrillShape.OVAL`.
- `drill_rotation_udeg`: the drill angle in the footprint-local coordinate
  system. KiCad has no independent drill-angle token. An oval drill therefore
  inherits the pad's `at` angle modulo 180 degrees; a circle is canonical zero.
- `plated`: true only for `PadKind.THROUGH_HOLE`.

`rotation_udeg`, `drill_x_nm`, `drill_y_nm`, and `kind` are dataclass fields in
the normalized IR, so the normalized SHA-256 distinguishes drill orientation,
geometry, and plating. The shape and plating convenience properties are pure
derivations and cannot disagree with those fields.

## Accepted invariants

SMD pads have zero drill dimensions. Plated through-hole pads require positive
X/Y drills and a strictly positive copper annulus on both axes. Their layer list
is ordered `("*.Cu",)` or `("*.Cu", "*.Mask")`; the mask wildcard is optional
because an explicitly suppressed mask opening is representable.

NPTH pads require all of the following:

- empty pad number;
- no `net` child, including no nominal net-zero child;
- no `pinfunction` or `pintype` child;
- exact ordered layers `("*.Cu", "*.Mask")`;
- positive X/Y drill dimensions;
- pad size exactly equal to the drill envelope, expressing no copper annulus;
- `circle` pad shape for equal drill axes and `oval` for distinct axes.

Reversed wildcard order, missing NPTH mask wildcard, duplicate layers, a netted
NPTH, or a plated pad whose drill touches either copper-envelope axis is
rejected.

Circular drill syntax has exactly one scalar diameter. Oval drill syntax must
include the `oval` atom and exactly two distinct dimensions. This rejects the
ambiguous forms `(drill X Y)`, `(drill oval X)`, and `(drill oval X X)` rather
than normalizing syntax that could conceal an upstream generation error.

## Orientation and unsupported geometry

KiCad rotates an oval drill with its pad because the documented drill grammar
does not contain an independent angle. The file codec accepts and round-trips
that pad angle exactly in integer microdegrees. A nested drill `rotation`,
`rotate`, or `angle` construct is rejected explicitly.

Drill offsets are valid in broader KiCad syntax but are outside this product's
concentric pad/hole model. Any `(offset X Y)` child is rejected explicitly,
including a zero-valued offset; silently discarding it would make two distinct
source files share one modeled geometry.

At the canonical graph bridge, absolute slot orientation is
`(footprint.rotation_udeg + pad.rotation_udeg) % 180_000_000`. The current
deterministic staging path accepts only cardinal 0/90-degree slots and returns
the release-blocking mapping code
`non-cardinal-drill-rotation-unsupported` for an arbitrary slot angle.

## Canonical mapping

A plated through-hole becomes both:

1. a `FootprintPad` carrying exact X/Y drill dimensions and absolute drill
   rotation; and
2. a plated `FootprintHole` bound to that pad ID with identical geometry.

An NPTH becomes only an unplated `FootprintHole`. It carries the exact drill
dimensions and absolute rotation, has `pad_id=None`, and never fabricates a
component pin or net membership. Multiple empty-number locating holes in one
footprint therefore remain distinct physical holes without triggering the
electrical compound-pad-number rule.

KiCad also permits more than one physical pad to use one electrical pad number.
The bridge preserves every UUID as a separate `FootprintPad`, resolves all of
them through the one catalog pin, and requires every member of that repeated
number to make the same net claim. Net membership is a set, so repeated lands do
not invent duplicate schematic pins.

Exact coincident physical pads with distinct pad numbers represent one shared
copper land. When their full local geometry and net claims agree, the bridge
assigns every member a deterministic
`kicad-shared-land-<source-identity-digest>` group ID. A mixed-net coincident
group fails with `shared-land-net-mismatch`; a repeated pad number with mixed
nets fails with `repeated-pad-net-mismatch`. This preserves shared-land atomicity
without guessing from merely adjacent or similar geometry.

## Regression fixture

`tests/kicad_io/fixtures/usb_c_npth_slots.kicad_pcb` models a USB Type-C
receptacle with two 0.65 mm circular locating holes, two repeated-number plated
0.6 by 1.4 mm shell slots at 90 degrees, and one coincident two-contact shared
land. Tests prove deterministic export/reparse,
plated-versus-NPTH and dimension-sensitive IR hashes, exact canonical mapping,
and fail-closed handling of electrical claims, annulus errors, booleans,
subclasses, layer ordering, offsets, and unsupported rotation syntax.
