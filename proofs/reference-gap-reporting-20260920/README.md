# Preserve reference gaps when whole-plane continuity is unknown

The plane acceptance checker previously required complete drill topology,
island policy and intended-plane connectivity before computing stored-fill
coverage. That prevented an exact missing-copper witness from being reported
when an independent whole-plane requirement remained unknown.

The checker now evaluates geometric coverage when the declared configuration
and single stored component match current saved/native observations. An exact
outside witness remains a failed reference row. Covered geometry still stays
unknown when the independent continuity conditions are missing. A mismatched
native polygon still prevents calculation. The source-bound fill, native
inventory, helper pin and routing guards remain in force.

The regression tests cover uncovered, covered and uncertain geometry with
unknown global topology, missing endpoint anchoring, and native/source mismatch.
**110 tests in two files, the source typecheck and backend compilation passed.** This is scoped
software validation. The subsequent [host48 native qualification](../native-reference-gap-20260920/README.md)
now verifies the correction through public refill/save/assessment/normal close
and installs the new host. The historical host47 report remains preserved.

## Current board evidence

A separate read-only geometric check of the published regional candidate's
saved PCB examined all **21 SWCLK_HDR/SWDIO_HDR segments** with their unchanged
0.25 mm margin. The actual pinned helper reports one exact outside witness on
each net; the other 19 segments are covered. The full [clock](SWCLK_HDR-0.json)
and [data](SWDIO_HDR-0.json) reports retain source identity and geometry. This
is independent stored-fill evidence, not a reconstructed live fill receipt or
a replacement for the historical full assessment.

| Net | Segment | Outside witness, mm |
| --- | --- | --- |
| SWCLK_HDR | 9846559d-7902-47f5-bde0-ffd61715149c | (8.13475, 56.87475) |
| SWDIO_HDR | e4d99ee2-5327-402f-b657-e99a8a8c52af | (12.84, 56.5) |

The through-hole connector approaches require a reviewed launch model or a
physical design revision. No launch exception, margin reduction or circuit
change is introduced here. The native PCB remains at SHA-256
`5fd653d353838cdc4a2dfb36b856d18de65c55d3911aa57cbc9595bac812f05d`.

Run `node --import tsx replay.mjs <qualified-helper.exe> <new-output-directory>`
from this directory to repeat the stored-geometry checks. The script checks the
exact executable and PCB identities, derives all selected segments from the
PCB, and refuses to overwrite prior results. It never opens or saves KiCad.
