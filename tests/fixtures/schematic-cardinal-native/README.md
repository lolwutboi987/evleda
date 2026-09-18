# Independent schematic cardinal oracle

Captured with actual KiCad CLI 10.0.3, executable SHA-256 recorded in `oracle.json`, on 2026-09-18. These are isolated qualification fixtures, not managed-board or manufacturing evidence.

The labelled schematic contains the installed stock `Device:R`, actual Q1 symbol `Transistor_FET:Q_NMOS_GSD` (value `DMG1012T`), and `Device:Crystal_GND24`, each at 0, 90, 180 and 270 degrees. Its labels form rotation-independent Cartesian spatial grids. Label names identify positions, **not predicted pin numbers**. Native XML netlisting establishes all 36 logical pin positions, including the four crystal 2/4 stacks. A separate native SVG of the unlabelled source establishes the direction of each full-length pin stroke. Rotated text groups are excluded from stroke interpretation; their complete original SVG remains preserved.

`capture.py` imports neither EvlEDA transforms nor DOC9. It refuses an existing output directory. The source symbol fragments retain stock geometry; whole installed-library source identities and fragment identities are recorded. Source schematics were unchanged by native export. The symbols originate from KiCad's stock symbol libraries and retain their applicable KiCad library licensing.

Symbol fragments: KiCad library contributors, [CC-BY-SA 4.0 with KiCad's electronic-design exception](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/master/LICENSE.md). Root names were qualified for embedding; symbol pin/graphic definitions were preserved. The earlier DMG1012T-library control capture remains separate in `destination-verification/schematic-cardinal-native-02`; this corpus is the fresh `schematic-cardinal-native-03` capture of the currently selected Q1 library symbol.

A subsequent `schematic-cardinal-native-04` run used `python -I -s -E -B -X utf8` and its own isolated KiCad configuration. Its `strict-recapture-comparison.json` records all isolation/no-bytecode flags and confirms identical cases, all 36 native observations, and byte-identical schematic/library inputs to this corpus. Use those Python flags for future capture invocations; neither capture script imports DOC9 or any runtime package.

The qualified schematic transform is library rotation followed by sheet Y inversion:

| Rotation | Sheet offset from placement | Pin angle |
| --- | --- | --- |
| 0 | `(x, -y)` | `a` |
| 90 | `(-y, -x)` | `(a + 90) mod 360` |
| 180 | `(-x, y)` | `(a + 180) mod 360` |
| 270 | `(y, x)` | `(a + 270) mod 360` |

The frozen DOC9 `get_pin_positions` computes the opposite quarter turns by rotating **after** sheet Y inversion. Its connectivity graph reuses that calculation. Those observations must reject against the corrected host until a new runtime is independently qualified; agreement between two source-derived helpers is not native proof. PCB transforms are outside this fixture and were not changed.
