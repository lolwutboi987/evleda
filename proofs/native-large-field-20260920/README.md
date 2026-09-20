# Preserving fields on the routed RP2350 board

The final 124-field cleanup was rejected because the field planner retained a
500,000-byte ceiling while the saved PCB had reached **616,071 bytes**. Routing
and persistence already admitted a bounded 1 MiB source. The rejection happened
before mutation, reported no governed effect and left recoveryRequired=false.
All completed routes remained saved.

The field planner now uses that same **1 MiB live-source ceiling** for both its
input and planned output. Field identity, literal text, exact native units,
presentation restrictions, source preservation and native save/readback checks
remain unchanged. An edit that would grow the planned source past the ceiling
is rejected before staging, including the final item of an atomic batch.

## Verification

- The actual rejected board is retained as a
  [616 KB regression fixture](../../tests/fixtures/fresh-project/native-large-field-source.kicad_pcb)
  with [provenance](../../tests/fixtures/fresh-project/native-large-field-source.provenance.json).
  Tests verify a real field edit without changes to other source, UTF-8 byte
  accounting, malformed input, exact-boundary no-op behavior and output growth
  in a final batch item.
- The focused field test file passed **40 tests**. The isolated host42 run
  separately passed **421 tests in eight files**, source/UI type checking,
  backend compilation and native-helper packaging. These counts overlap and
  are not added together; no full-suite pass is claimed.
- After the pure rejection, the project [closed normally](normal-close.json)
  with all six source files unchanged, then [resumed under host42](same-project-resume.json)
  using the same opaque project ID and unchanged authenticated bundle/profile.
- The [actual public field operation](native-fields-saved.json) then saved all
  **124 requested field updates** and returned
  `saved-and-native-footprint-fields-verified`. The driver also confirmed that
  all 1,099 tracks and 118 vias still matched the complete reviewed geometry.

The [original rejection](rejected-before-mutation.json) remains preserved.
Neither the older frozen hosts nor the managed PCB/rules/checkpoint were patched
directly. The same normally closed project was resumed; no saved-source recovery
or replacement board was needed for this failure.

The default EvlEDA entry was then [repointed from host41 to host42](client-host42-installation.json),
preserving its DOC16 profile, skill, workspace, timeouts, edit policy and all
unrelated configuration. A [fresh actual Codex client](client-host42-discovery.json)
discovered the same 17 tools and exited normally. No new task or native project
was created by that probe; current-conversation activation is not claimed.

This qualifies the field operation on the real routed board. Label application,
fresh fills, final board assessment and final normal close remain separate work.
The [verification summary](verification-summary.json) records the evidence hashes
and source identity after the successful native save.
