# Native05 checkpoint parser regression

The three `native05-*` inputs are exact copies from the failed-close project
`destination-usb-c-native-05/workspace/projects/157f9ea8-ecbd-4b74-9160-5e526293454e`.
The original project was not resumed or changed. Import, 24-feature pad readback,
J1/J2 preserving moves and previews succeeded before checkpoint preparation
rejected the stock footprint's disabled `Dwgs.User` drawing layer.

| File | Original relative path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `native05-saved-post-move.kicad_pcb` | `output/project/usb-c-mechanical-probe.kicad_pcb` | 14440 | `24e3935b9e41cfb2df113bd5cfae3ae1884ec0e4f698011f16bd68f349bc1c9b` |
| `native05-draft.json` | `input/draft.json` | 4317 | `696a88f2ed3059766f3c39c0e36c256d1519fcbd6d4ec3b17723c7401d00a217` |
| `native05-sync.net` | `output/.evleda-mcp-output/pcb_sync.net` | 9857 | `0560d8cc3938bd77d819ad0588974453405c09180ca48f83031709c11a150990` |

Tests compile the unchanged draft with explicitly offline library records and
power-symbol fixtures, replay the saved native netlist, and run the real V2
semantic reader and shared checkpoint preparation in a newly created temporary
project. They do not run KiCad, publish a checkpoint, recover the failed project,
or provide new native PAD evidence.

Audited KiCad 10.0.3 source:

- [Layer IDs](https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/include/layer_ids.h): `Dwgs_User` is ordinal 17.
- [Default names](https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/common/lset.cpp): the canonical name is `Dwgs.User`.
- [S-expression parser](https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp): `init()` seeds canonical item-layer names before `parseLayers()` records enabled board layers.

Admission is limited to supported footprint graphics under board format
20260206. A present `Dwgs.User` declaration must be ordinal 17 with `user` type;
conflicting aliases at that ordinal are rejected. No generic layer-name, pad,
route, copper graphic, or rule-source policy is broadened.
