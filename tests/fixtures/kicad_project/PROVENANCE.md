# KiCad 10 fixture provenance

These fixtures are maintained exchange-contract inputs. They were **not** opened or
saved by KiCad on this development host, and passing them never constitutes KiCad
execution evidence.

Their structure was checked on 2026-08-29 against these official KiCad 10.0.4
sources:

- [`PROJECT_FILE` implementation](https://gitlab.com/kicad/code/kicad/-/blob/10.0.4/common/project/project_file.cpp):
  `projectFileSchemaVersion = 3`, `sheets`, `boards`, and the exact registration
  key `schematic.top_level_sheets`.
- [Native `issue22873.kicad_pro`](https://gitlab.com/kicad/code/kicad/-/blob/10.0.4/qa/data/eeschema/issue22873/issue22873.kicad_pro):
  schema-3 `meta`, one `[uuid, "Root"]` sheet record, and a top-level sheet object
  with `uuid`, `name`, and `filename` under `schematic.top_level_sheets`.
- [Native `issue24217.kicad_sch`](https://gitlab.com/kicad/code/kicad/-/blob/10.0.4/qa/data/eeschema/issue24217/issue24217.kicad_sch):
  version `20260306`, generator version `10.0`, root UUID/paper/library layout,
  embedded unit/body symbol definitions, placed-symbol fields and pin UUID maps,
  root sheet instances, and embedded-font declarations.
- [Official schematic format](https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/):
  wire, junction, label, global-label, no-connect, symbol, and sheet-instance
  grammar.

`supported_project.*` is a deliberately small, format-faithful single-sheet
project assembled from those native structures so every modeled relationship is
auditable. `unsupported_settings.kicad_pro` adds realistic net-class dimensions
to prove that project design rules are retained and release-blocking rather than
silently ignored. The PCB member is the existing strict KiCad-10 board fixture in
`tests/fixtures/kicad/supported_board.kicad_pcb`.
