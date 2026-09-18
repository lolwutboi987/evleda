# Full-board V2 routing capacity

The RP2350 source proposal exceeded the former 96-item whole-board route limit
before GPIO routing began. The fixed limit applied to reads and post-save checks,
so larger drafts could compile but could not be carried through the actual
authoring workflow. A separate 32-via plane-access limit also prevented the
planned local returns for 40 surface-mount ground-bearing component groups.

V2 now supports a bounded complete inventory of **1,024 tracks and 256 vias**.
Projected additions are checked before native mutation. Every retained item stays
in private selection, mutation and saved-state verification; excess items are
rejected rather than truncated. V1 keeps its former 96-item limit, and each
mutation retains its 128-track, 32-via and 128-deletion limits.

Large public route reads use 32-item pages under the unchanged 32,000-character
result limit. The full-selection identity remains separate from the page identity.
Sequential continuations must match the current source and exact next offset.
Small existing replies remain unchanged. The skill and live tool description
explain the page protocol and recovery after a lost response.

Only V2 plane-access `maxVias` expands to 0–64, including nullable drafts. Trace
routes and V1 retain their 32-via limits. Per-net maxima must still sum to no more
than the declared global budget; numerical via dimensions, annular ring, layers,
edges, clearances and routing geometry keep their independent checks. The initial
candidate07 request incorrectly combined an 85-via reservation sum with a global
64 limit and was rejected. That failed input is preserved. Its corrected global
budget is 85; it is not an instruction to place 85 vias.

Verification includes the 48/64/65 plane-access boundaries, aggregate-budget and
legacy-byte regressions, a 107-to-108 item incremental save, all 1,280 items read
through pages, source drift and forged/replayed page rejection, off-page retained
geometry rejection, overflow rejection before Commit, 65 actual parsed via forms,
and unchanged V1/per-call limits. Source typechecking and independent reviews
passed. These software cases do not establish native routing of a 1,280-item board.

The complete source snapshot in `integration-doc9-build-10` contains 1,077 files;
backend/UI typechecks and the package build passed with DOC9 verification. Snapshot
source remained unchanged and installed `dist` was not rewritten. Local receipt:
`destination-verification/rp2350-toolbox-integration-11/checks-result.json`.

Candidate07 was created on an interim checked host, closed normally and reopened
on build10 with the identical authenticated contract/bundle. Public discovery now
advertises the paging schema. Actual RP2350 schematic authoring is in progress;
native PCB import, full routing, ground fill and acceptance remain unfinished.

Other resource limits remain explicit: 500,000-byte live-board persistence,
1 MiB plane-stage input, 2 MiB common-check source, and 512 physical pads for the
common checker. Enlarged item capacity does not override those bounds. The prior
failed full suite and all native failure records remain preserved.
