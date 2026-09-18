# Protection transfers and larger native schematics

This continuation fixes two concrete problems found while planning the real
RP2350 board. It does not establish a completed or accepted RP2350 native project.

## Explicit protection-device transfers

The optional V2 `channel.feedThrough` models one manufacturer-cited two-line
protection device between distinct input and output copper nets. Source inspection
preserves its four passive IO terminals, ground and supply; matching names alone
cannot assert conduction. All six native signal graphs and all receiver contacts
remain represented. PCB etch length/skew includes three copper sections per
polarity. Package delay, skew and parasitics remain unassessed.

The route writer and saved common checks recognize an output fork only at the
exact declared, source/native-qualified SMD pad center. Ordinary bends,
intersections, overlaps and reversals retain their checks. Native integer pad
positions prevent floating-point tails from manufacturing a different location.
Legacy four-net bundle and assessment goldens remain unchanged when this optional
transfer is absent.

Explicit ordinary track widths now accept the same 0.05–20 mm syntactic range as
the existing contract. The exact bound net-class floor still controls each write;
all USB channel nets retain their separate 0.20 mm floor and declared intervals.
This resolves the inconsistency where an omitted width could use a declared
0.15 mm class but the same explicit width was rejected. It is not a fabrication
or current-capacity assertion.

## Complete planning text from a real KiCad render

The actual 62-part schematic produced a 1,181,482-byte SVG containing 21,080 XML
elements and 554 text groups. The old 20,000-element limit stopped planning. The
bounded limits are now 4 MiB and 64,000 elements; the 30,000-segment, 1,000-group,
depth-32 and two-million-comparison limits remain unchanged.

KiCad also emits cardinal-rotation wrappers around invisible text metadata,
followed by already-absolute stroked glyphs. The reader now recognizes only the
strict observed wrapper form and immediate matching glyph sibling, without
transforming glyph coordinates. The existing omission of nontext body graphics
also recognizes the observed even-odd fill rule in planning mode. Full-ink
analysis still reports unsupported arcs, filled paths and incomplete comparison
coverage; these limits are not converted into a whole-render pass.

The exact compressed native fixture and provenance are retained in
`tests/fixtures/fresh-project/rp2350-native-62-component-schematic.*`.
Planning coverage reaches all 554 groups. The subsequent complete schematic
layout still needs actual terminal-label and power-flag collision corrections.

## Verification scope

- Feed-through/fork/width integration: 154 final focused tests passed; source
  typecheck and independent review passed. An earlier 317-test run had one stale
  model-guide whitelist expectation; it was corrected and the affected tests
  rerun. This is not a new passing full-suite claim.
- SVG collector/planning bounds: 68 tests passed, with source typecheck and
  independent review. Strict malformed wrappers and over-limit inputs reject.
- Immutable `integration-doc9-build-08`: 1,070 captured files, backend/UI
  typechecks and full package build passed. Snapshot source remained unchanged;
  installed `dist` was not rewritten. Receipt:
  `destination-verification/rp2350-toolbox-integration-09/checks-result.json`.
- The actual approved RP2350 package compiles with 62 parts, 67 nets and four
  board features. Its separate proposed USB geometry reaches all 14 signal
  anchors. [The model record](research/rp2350-pico/usb-feedthrough-model.md)
  preserves the unassessed coupling/reference/impedance scope.

The failed historical suite and all earlier native projects remain preserved.
The current public-MCP RP2350 schematic still contains U1/J2 only; full schematic,
PCB authoring and native acceptance are unfinished.
