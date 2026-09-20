# RP2350 native R1 candidate

The 22 x 60 mm four-layer board is fully routed, saved, normally closed and
read-only reopened. All 67 functional nets are connected; configured native
ERC/DRC and schematic parity report zero findings. **Engineering acceptance is
still failed/incomplete**; see [the findings](engineering-review.md).

Open [the KiCad project](native/rp2350-pico-4layer.kicad_pro) with KiCad 10.0.3
and its standard libraries. Keep the included native/library directory beside
the project. This portable copy carries no managed-workspace authority.

- [Pinout](pinout.md) and [candidate BOM](bom-candidates.csv), with [BOM notes](bom-notes.md).
- [Top view](previews/top.png), [assembly view](previews/assembly.png) and [schematic](previews/schematic.svg).
- [Engineering review](engineering-review.md), [complete acceptance rows](verification/plane-acceptance.json), and [reopen evidence](verification/read-only-reopen.json).

The layout retains the original 2.54 mm GPIO pitch and 17.78 mm row spacing,
clear soldering/service strips and straight/45-degree trace turns. Remaining
work includes supplemental-plane component policy, debug reference gaps,
plane-contact evaluation and electrical/construction qualification. This is not
a manufacturing release. Historical review117 and failed attempts are preserved.
