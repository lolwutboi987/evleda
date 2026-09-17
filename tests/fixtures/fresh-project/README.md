# Captured fresh-project regression fixtures

These fixtures preserve the captured inputs used by four regression tests in
`tests/unit/harness-fresh-project.test.ts`. The original September 6, 2026 proof
runs remain local; the tests do not require those generated output directories.

| Fixture | Original source | Extracted input |
| --- | --- | --- |
| `captured-symbols.report.json` | `led-proof-2-20260906/pcb-agent-report.json` | The first `sch_get_symbols` operation whose `result.content` contains `footprint=`; its name and complete, unchanged content string. |
| `captured-stock-symbols.kicad_sch` | `led-proof-20260906/project/led-proof-20260906.kicad_sch` | The complete schematic, byte for byte, including CRLF line endings. |
| `angle-metadata-leak.report.json` | `led-proof-3-20260906/pcb-agent-report.json` | The unchanged summary; every operation's name and iteration, in order; and the complete, unchanged content string from the first `fresh_apply_contract_connectivity` operation. Retaining all operation metadata preserves the assertion that no connectivity mutation occurred in that iteration. |
| `blocked-wire-plan.report.json` | `led-proof-4-20260906/pcb-agent-report.json` | The final `fresh_apply_contract_connectivity` operation's name and complete, unchanged content string. |

Report envelopes omit unrelated run metadata and payloads. The serialized
`result.content` strings are copied exactly, without parsing and reserializing
their contents. All existing test assertions are retained.

SHA-256 digests of the original source files:

```text
812a97702b96e85365ebaec1a36b9c0ced40a9b073e1e3919035703009188eb6  led-proof-20260906/project/led-proof-20260906.kicad_sch
4dd0731a2bf363c937016f25add3db2b07777edf44753512b79ce528d24d580e  led-proof-2-20260906/pcb-agent-report.json
2c9bbe9b6b5e88fbaed80e029c94e757e689ec904983b9c3bad4be206d7bfaac  led-proof-3-20260906/pcb-agent-report.json
9d9dba17d41beb39771794fcc6270b50ab315c6bd9041b5d53fc11716d35db77  led-proof-4-20260906/pcb-agent-report.json
```

SHA-256 digests of the extracted UTF-8 `result.content` strings:

```text
f122009b4946fa5f5630059e73bf4608c475a48a8524473613ac5097c4983dd6  captured-symbols.report.json
937bd603e918cbd2d721eb3b1687bc94020086d9d632654f22001c3664b515d9  angle-metadata-leak.report.json
a10d6862fb5a8eb3e16d5add6c30dd75014c28fa0028f1b57362f62fa2977fdf  blocked-wire-plan.report.json
```

`.gitattributes` disables text conversion for this directory so Git preserves
the captured bytes across platforms.

`captured-usb-c-power-symbols.report.json` preserves the unchanged nested
`result.structuredContent.result.content` string from the native02 public
`sch_get_symbols` response recorded at `2026-09-17T07:15:14.165Z`. Its provenance
contains the original relative response path and SHA-256/byte identities for
both the original response file and extracted content. The declared four symbols
comprise two physical symbols and two flags separated by `Power symbols:`.

The corresponding `fresh-external-power-parser.test.ts` replay uses separately
identified synthetic source/graph facts to test formatting and field comparison.
Its rejection variants and combined post-flag bounding-box example are synthetic,
based on frozen DOC7 producer grammar; no post-flag native bounding-box capture
is claimed. This fixture does not establish native field-repair or PCB-import
success.
