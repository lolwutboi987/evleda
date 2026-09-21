# Native bore shapes and complete report delivery

The checker now inventories the RP2350's non-plated holes and cardinal oblong
drills instead of stopping before inventory completion. Slot-end reference
checks use exact capsule geometry. The complete large assessment is delivered
through a hash-bound public MCP resource with a compact status summary; no
findings are truncated and raw native evidence remains separate.

Native host53/DOC17 reopened managed project 17b88ed0-adea-4634-a468-8d417dc16c97, refilled/saved both
planes, retrieved and hash-verified the complete report, and closed normally.
All six sources remain byte-identical. All 67 functional nets connect and
configured DRC is clean. Full assessment: **143 pass, 431 unknown, 0 fail; accepted=false**.

- BACK_GND: inventory 171 bores, including 4 slots; topology unknown.
- GND_PLANE: inventory 171 bores, including 4 slots; topology unknown.

The installed entry now uses host53 with the unchanged DOC17/v4 profile and PCB
skill. A fresh actual Codex app-server discovers 19 initial tools without a task,
model turn or native allocation. An existing desktop connection is not claimed
to have reloaded.

[260 tests in 9 files](verification-resource.json), source typecheck and backend
compilation passed. See [native summary](native-summary.json),
[complete assessment](native-assessment.json), [delivery record](delivery.json)
and [geometry/resource behavior](../../docs/plane-bore-shapes.md).
The [exact public resource](public-report.json) is 1,088,925 bytes, SHA-256
`14e4d6a348bef81816b40d407642cbe99a4b69ba84e55b5ab3c954faf97093e8`.

The [first native attempt](first-native-attempt.json) remains a failed delivery:
host52 reached the old public size limit before artifact creation. It closed
normally with unchanged sources and was never installed. The correction was
qualified separately in host53; no historical result was rewritten.

USB startup/inrush, physical copper widths, complete terminal contact continuity
and other electrical requirements remain open. This changes the checker and
report delivery, not the circuit, routing or engineering acceptance.
