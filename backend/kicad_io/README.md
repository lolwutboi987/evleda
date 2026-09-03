# KiCad 10 deterministic PCB exchange slice

This package is a file codec, not a KiCad runtime adapter. It parses and writes a
documented KiCad PCB S-expression subset, but it never starts `pcbnew`, invokes
`kicad-cli`, runs DRC, or claims that KiCad accepted a file. Every evidence object
therefore contains `kicad_execution = "not-run"`. A separately configured real
KiCad worker must attest runtime acceptance and native DRC.

## Supported semantic subset

- Root declarations: `version`, `generator`, and a required
  `generator_version` whose major version is 10.
- Layer table entries `(ordinal "name" kind ["user name"])`.
- Named nets. Local numeric net codes are converted to stable canonical net IDs;
  export assigns codes deterministically.
- A single closed, unbranched `Edge.Cuts` ring made from `gr_line` expressions.
- Footprints with layer, UUID, placement, Reference/Value properties, attributes,
  and `smd` or `thru_hole` pads.
- Circle, rectangle, oval, and round-rectangle pads with exact position, rotation,
  size, copper/mask/paste layers, pin metadata, canonical net ID, and drill. SMD
  drill is exactly zero; through-hole drill is required and positive.
- Copper `segment` geometry, through/blind/micro `via` geometry with the full
  copper-layer span, and named single-layer copper `zone` geometry.
- Zones retain UUID, canonical net ID/name, one layer, a normalized closed
  integer-nanometre boundary, pad clearance, minimum thickness, and hatch data.

All millimetre decimals must be exactly representable as integer nanometres and
all angles as integer microdegrees. Floats never enter the normalized IR.

## Explicitly opaque or unsupported

Presentation-only/library metadata is stored as canonical S-expressions in the
diagnostics manifest with disposition `preserved`, then re-emitted. Constructs
that can change electrical or fabrication meaning are disposition `unsupported`.
Strict import (the default) rejects them. Review-mode import retains them in the
manifest, but export still rejects unless `preserve_unsupported=True` is an
explicit call-site decision.

Examples of release-blocking constructs include curved/compound Edge.Cuts,
unmodeled pad copper/mask settings, multi-layer/rule-area zones, zone holes,
keepouts, generated fill polygons, and zone fill/thermal-spoke syntax. Zone holes
and thermal spokes are never flattened into the modeled outer boundary.

## Evidence chain

`import_board` binds source bytes, normalized supported IR, and the diagnostics
manifest with independent SHA-256 values. `export_board` binds that same IR and
manifest to the exact exported bytes. `round_trip` re-imports those bytes and
reports semantic and diagnostics parity separately. This proves codec parity,
not KiCad execution or native DRC.

## Canonical graph bridge

`to_design_graph` maps the exchange IR into the product-owned `DesignGraph` only
after a trusted `ComponentResolver` supplies exact component provenance: MPN,
datasheet digest, symbol, footprint identity, and pin-to-pad map. It maps board
outline, orthogonal front-side placements, pads and plated holes, nets, tracks,
through vias, and copper zones. Pad-local coordinates are converted to board
coordinates with integer-only quarter-turn transforms.

The bridge returns digest bindings plus structured `MappingGap` values. It
rejects geometry it cannot represent exactly, including non-orthogonal or
back-side transforms, oval drills, compound pad numbers, and blind/micro via
kinds. Source-retained mask/paste layers, assembly attributes, and the absence of
schematic-file parity stay explicit; `release_eligible` is false while any such
blocking gap remains. This prevents a PCB-only import from being presented as a
schematic-exact or fabrication-complete project.
