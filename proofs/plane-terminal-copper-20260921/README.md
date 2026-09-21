# Geometric paths from physical terminals to the primary plane

**Native-qualified and installed in host58 on D:.** The public assessment
verifies a positive-width nominal copper path from each of the RP2350
candidate's **64 physical ground pads** to the primary ground region, after a
fresh native refill and mandatory save/readback. The original `plane-net:GND`
requirement now passes. The full result is **144 pass, 430 unknown, 0 fail;
accepted=false**.

The isolated project closed normally and all six native sources stayed exact;
the protected main board stayed closed and unchanged. All 67 functional nets
remain connected and configured DRC is clean. Host58 retains DOC17, the v4
profile and the existing skill. A fresh actual Codex client sees 19 initial
tools; existing desktop connections are not claimed to have reloaded.

See the [native summary](native-summary.json), [complete public report](public-report.json),
[assessment](native-assessment.json), [delivery](delivery.json),
[installation](installation.json) and [fresh client](fresh-client.json).

The reusable implementation is part of the existing plane assessment, rather
than a separate candidate calculator. When current authenticated source, fill,
native inventory, connectivity and clearance evidence agree, its
`terminalCopperConnectivity` observation can complete the original
`plane-net:<net>` row. It does not complete thermal, minimum-width, current,
interface or overall board acceptance.

## What is checked

The source adapter uses exact native pad positions and cardinal padstack
orientations, saved integer-nanometre tracks and vias, the complete drill
inventory, and the declared rectangular board. It retains every eligible
physical pad independently, including repeated shield pin numbers.

The geometric search joins strictly positive-area contact discs through:

- Convex rectangular, roundrect, circular or oval pad copper with strictly
  internal, mutually separated bores and strictly exterior remaining bores.
- Normal plated through-pad and via barrels with intact surrounding copper.
- Positive-width capsules contained in actual track copper, clear of every
  round or cardinal-slot bore and contained in the board outline.
- A primary plane interior already verified connected after drill subtraction.

The search uses conservative integer distance bounds and exact integer
intersection predicates. Tangency is not contact evidence. No zero-ohm or
component-internal bridge is invented. Pad extents clipped by a board edge,
unsupported pad geometry, missing barrel/layer facts and missing paths remain
unproven. The native all-pad cluster is a separate required check; it cannot
replace this geometric path.

Each returned path retains its physical pad UUID, contact-disc positions and
radii, and the pad/via/track/plane identities of its links. Public projection
checks inventory completeness, path continuity and claim consistency while
excluding arbitrary private metadata. Older reports without this optional
observation retain their existing public shape.

The search is bounded to 4,096 primitives, 4,096 bores, 16,384 candidate points,
8,192 plane vertices, 65,536 graph nodes, 131,072 links and four million charged
operations. Exceeding a bound produces no connectivity certificate. The target
is one qualified primary component; this does not silently combine disconnected
regions under a shared zone name.

## Verification and practical limits

[The final affected test run](verification.json) passed **235 tests with two
existing skips** across seven files. It includes cut traces, exact tangency and
one-nanometre separation, missing barrels, distinct copper layers, slotted pads,
rounded corners, split physical members, board-edge clipping, corrupt public
paths, missing fresh fill and preservation of explicit failures. Full source
and UI typechecks passed locally with a 2 GiB heap cap; user applications stayed
open. This is not a full-suite claim.

The frozen backend compiled successfully on D: with the same 2 GiB heap cap.
The [separate GitHub typecheck/backend job](https://github.com/lolwutboi987/evleda/actions/runs/35578478523/job/106265613265)
also passed on source commit `05f14b8b16c39e5b91beb56b5cfb8fcc8af456cf`.
[The complete CI workflow](github-verification.json) remains failed because
the unchanged native-dependent job lacks its separately provisioned pinned
KiCad runtime. That check was not skipped or relabeled as passing.

[The saved-data replay](static-replay.json) binds the unchanged PCB SHA-256
`1409f3775ebec294987b2b9fdcd984b8cf4ab7e8884700fa1c91250847ff62da`
and the exact historical diagnostic. It includes 64 pads, 41 ground vias,
131 ground tracks and all 171 board bores. All 64 paths are witnessed within
2,889,009 charged operations. The closed projection retains 161 contact discs
and 262 links used by those paths. The smallest retained disc radius is
1,506 nm. These radii are conservative contact witnesses; actual minimum
copper widths remain unmeasured. Geometric connectivity does not establish
ampacity or fabrication-tolerance suitability.

The proof describes nominal saved copper. It does not certify manufactured
plating, copper thickness, current distribution, voltage drop, temperature rise,
fault response or high-frequency return quality. USB startup and the other
candidate electrical-review items remain open. No component or route was moved.
