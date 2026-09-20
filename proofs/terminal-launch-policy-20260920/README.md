# Explicit native terminal-launch revision

The [current RP2350 candidate](../../designs/rp2350-pico/native-r1-launches/README.md)
separately declares the clock/data header transitions while retaining all
physical geometry, native numeric rules, body margins and terminal assignments.
The original regional candidate and its full-ribbon failures remain preserved.

The new public operation `evleda_revise_terminal_launches` requires an explicit
ready draft and a materialized source closed normally in the same connection.
It rejects mixed requirements and unsupported source geometry, creates a separate
allocation, and transfers no live fill or acceptance. The actual native sequence
completed creation, both refills/saves, assessment, previews and normal close.
A fresh read-only reopen repeated all-net/native checks and preserved six sources.

Both local launch rows are verified: source/native PTH geometry, explicit length
and return spacing, direct eligible ground anchors, foreign-bore separation and
native clearance checks. The body ribbons are covered at the original 0.25 mm
margin. The canonical RP2350 DRU and schematic remain byte-identical; board PNGs
are unchanged. The full assessment stays **incomplete: 143 pass, 431 unknown, 0 fail; accepted=false**.
Complete drilled-copper continuity, USB startup and other electrical review remain.

[Software verification](verification.json) records 274 focused tests in 12 files,
separately scoped guide/interface/workspace follow-ups, source typecheck and
backend compilation. Frozen host50 received fresh compilation/helper packaging
and source-pinned reuse of the completed checks. This is not a full-suite claim.
[Delivery](delivery.json) binds native lifecycle and portable source custody;
[client verification](client-verification.json) confirms host50/DOC17 and 19
tools in a fresh actual Codex client. Existing desktop connections are not claimed
to have reloaded. See [requirement semantics](../../docs/terminal-launch-requirements.md).
