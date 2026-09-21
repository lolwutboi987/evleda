# Scoped V2 route feedback

**Host61 is installed and verified through the native read-only workflow.** Agents can now ask the existing
route reader for one exact net, without receiving every unrelated board route.
Use `fresh_get_route_items({ "net": "GND" })` when its schema advertises net.
The [tool schema](native-tool-schema.json) and [protocol guide](../../docs/toolbox-full-board-routing-capacity.md#read-one-net-without-returning-unrelated-routes)
describe scope, identities and page continuation.

## Actual RP2350 result

The unchanged R2 board contains **1,216 tracks/vias**. The reader returned all
**171 GND items (130 tracks and 41 vias) in one call**, taking
**48.8 seconds** as observed by the native driver. It explicitly omitted
1,045 other-net items. The [complete selected inventory](ground-feedback.json)
matches the saved source exactly, and all [returned pages](ground-pages.json)
retain their query and page identities. XTAL_OUT returned all 7
items in one reply. The original full-board first-page shape is preserved.

The prior full-board read took 35.28 minutes across 39 pages on the
pre-correction 1,217-item board. This illustrates the avoided round trips; it is
not a controlled same-source timing comparison or a speed guarantee. Complete
native/source/library validation still runs on each request.

The full-selection identity was independently reproduced from all 1,216 saved
items and the actual public metadata. Only the first unfiltered public page was
needed for that comparison; a second 39-page scan was not performed or claimed.
Native read-only resume, all scoped reads and normal close preserve every byte
of the six source files. [Native summary](native-summary.json) and
[delivery record](delivery.json) retain those scopes and identities.

## Preserved edit checks

Filtering changes public feedback, not the private complete inventory. Scope
records selected and omitted counts; filtered replies never claim complete-board
feedback. A separate query identity binds the selection and net, and continuations
reject changed queries, missing identities, skipped/replayed cursors and drift
even on an omitted net. The full selection identity remains the edit identity.

A scoped read restricts the next mutation to its selected net. A fresh read of
another net or the full board changes that scope. Existing whole-board capacity,
global via budgets, per-operation limits and exact retained-source checks remain.
No runtime integrity guard, numerical design rule or routing constraint changed.

[175 tests](verification.json) pass, covering full/V1 compatibility, scoped and
empty feedback, cursor/identity rejection, omitted-source drift, cross-net edit
rejection, global via budgets and a simulated native save that preserves every
omitted route. Public read-only MCP feedback is included. Source/UI typechecks
and frozen backend compilation pass; this is not a full-suite claim. Native
qualification in this run is read-only, not an additional physical edit trial.

A fresh actual Codex client sees 19 initial tools. Host61 and its updated skill
are installed, with the same DOC17/v4 profile. D: must remain mounted. Activation
of an already-connected desktop session is not established.

The [RP2350 R2 candidate](../../designs/rp2350-pico/native-r2-spacing/README.md)
and its engineering status are unchanged. USB startup, electrical suitability
and remaining assessment integration are still open. Query feedback establishes
no clearance, completed connectivity or electrical acceptance.
