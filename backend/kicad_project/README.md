# KiCad 10 deterministic project-bundle exchange slice

This package accepts caller-owned `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb`
bytes plus a closed tuple of typed `ProjectAuxiliaryFile` objects and a validated
project stem. It exposes no path, directory, shell, process, or arbitrary-file
API. Auxiliary files use bounded portable relative names; traversal, drives,
Windows device aliases, case-fold collisions, primary/manifest shadows, and
active `.kicad_prl` UI state are rejected. Limits cover primary files,
individual auxiliaries, auxiliary count/total, and the complete aggregate.

It is a codec, not KiCad. Every evidence type hard-requires
`kicad_execution = "not-run"` and `manufacturing_release_eligible = false`.
Constructors reject any other value. A separate pinned worker must prove KiCad
load/ERC/DRC before release.

## Modeled subset

- KiCad project schema 3 `meta`, `boards`, `sheets`, and exactly one
  `schematic.top_level_sheets` record. Filenames are stem-derived basenames.
- Known KiCad 10 schematic formats `20250114` and `20260306`, with a declared
  `generator_version` major of 10.
- One root sheet, embedded library definitions with explicit unit pins, placed
  symbols and exact pin UUID maps, integer-nanometre positions, and quarter-turn
  transforms without mirroring.
- Two-point wires, explicit multi-way junctions, local/global labels, and explicit
  no-connect markers.
- Exact connected components: same-name labels join disjoint geometry; conflicting
  labels, ambiguous crossings, mid-segment joins, and invalid junctions fail.
- Existing strict PCB IR, followed by exact schematic/PCB reference, value,
  footprint, pin/pad-number, named-net-population, and per-pin net comparison.
- Root-sheet local label `NAME` matches canonical KiCad PCB name `/NAME` (or the
  exact unqualified legacy fixture form) only when the parsed label is local;
  globals match `NAME` only. Literal slashes are preserved, and alias collisions
  or non-bijective raw/prefixed PCB populations fail closed.
- KiCad `unconnected-(...)` PCB nets compare as logical no-connect only when the
  exact native reference/pin-name/pad-number spelling is reconstructed for every
  owning pad, every pin has an explicit schematic NC marker, and the net owns no
  segment, via, or zone. Native `REF-PadN` short form is limited to empty or
  number-equal pin names. Unnumbered paste/mask-only aperture pads are retained
  but excluded from logical pin populations; unnumbered copper/net metadata is
  rejected.

The semantic hash excludes writer identity but binds project membership,
schematic electrical IR, PCB IR, project stem, and the exact auxiliary source
manifest. Independent hashes bind every source/export payload and every retained
expression/JSON field.

Hermetic projects can additionally carry exact version-7 `sym-lib-table` and
`fp-lib-table` files, a packed `FluxGenerated.kicad_sym`, and a closed
`FluxGenerated.pretty/*.kicad_mod` module set. Bounded parsers validate table
nickname/type/`${KIPRJMOD}` URI, symbol definition identities, module names,
module/file coverage, and case-insensitive uniqueness without consulting host
libraries. Footprint modules additionally expose source-ordered, fixed-point
`fp_line`, `fp_rect`, `fp_poly`, and `fp_text` presentation records on the
reviewed front fabrication/courtyard layers (plus the legacy v3 front-silkscreen
text subset). Portable `${KICAD10_3DMODEL_DIR}/...` STEP/WRL references retain
exact offset/scale/rotation vectors. Unknown primitives, unsafe paths, duplicate
fabrication/courtyard UUIDs or model paths, and malformed stroke/fill/transform
syntax fail closed; pads and their repeated physical-contact semantics remain
byte-preserved and unchanged.

## Unsupported without invention

Hierarchy, buses, bus entries, implicit power-symbol nets, mirror transforms,
inherited library symbols, legacy instance tables, rule areas, directives, and
unknown electrical constructs are diagnostics with disposition `unsupported`.
Project settings outside the membership manifest are also unsupported because
they can alter library resolution, ERC/DRC, annotation, simulation, plotting, or
fabrication behavior. Unsupported PCB constructs retain the existing PCB codec's
fail-closed classification.

Strict import/export rejects any such diagnostic. Review mode can retain and
re-emit it only with explicit caller opt-in; cross-artifact parity is then marked
not proven. Presentation and embedded-library source expressions are retained
with disposition `preserved` and digest-bound separately from modeled semantics.

## Public API

- `ProjectAuxiliaryFile(relative_name, media_type, payload)`
- `ProjectBundleInput(..., auxiliary_files=())`
- `ProjectBundleInput.all_files` for the complete deterministic typed source set
- `parse_hermetic_project_libraries(...)`
- `import_project_bundle(..., unsupported_policy=UnsupportedPolicy.REJECT)`
- `export_project_bundle(..., preserve_unsupported=False)`
- `round_trip_project_bundle(...)`
- `BundleLimits` for caller-selected smaller resource ceilings

The fixtures and their official KiCad source references are documented in
`tests/fixtures/kicad_project/PROVENANCE.md`. They are format-faithful test data,
not local KiCad execution evidence.
