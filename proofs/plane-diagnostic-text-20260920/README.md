# Readable plane-topology limitations

The public report now explains a fixed topology limitation instead of hiding it
as private diagnostic detail. The single-component check's internal message
contains a slash between “source” and “native”, which the path filter correctly
treated conservatively. The formatter now translates only that complete known
message and its exact known-bore variants into plain text.

The general privacy filter is unchanged. Altered messages, path-bearing details,
raw KiCad syntax and unmatched bore prefixes still get redacted. Every finding,
bore, source identity and verdict is retained; no acceptance condition changed.

On the [historical native host54 assessment](../plane-exterior-bores-20260920/README.md),
the supplemental BACK_GND plane has 10 stored copper regions. Its topology
check requires one matching region. The new text exposes that limitation; it
does not call those regions disconnected or waive the separate regional policy.
The primary plane remains verified, and full acceptance remains false with
143 pass, 431 unknown and no failed verification rows.

[Replay evidence](replay.json) checks the original private artifact's hash and
assessment identity, then compares every field with the previous public report.
Only 343 occurrences of the same diagnostic explanation change. These are
repeated global and per-bore explanations, not 343 new defects. The
[reprojected report](reprojected-public-report.json) is a new rendering of that
historical observation, not fresh native evidence or renewed fill authority.

[54 tests across two complete reporting files](verification.json), source
typecheck and backend compilation pass. The compiled host55 projection matches
the source replay byte for byte. All other native-engine, sidecar, script and
build-input code matches qualified host54, so no duplicate native run was made.
The frozen host55 report update is installed, and a fresh actual Codex client
discovers 19 initial tools. The profile, skill, board and unrelated settings are
unchanged; existing desktop reload is not established.

See [delivery](delivery.json) and [client discovery](fresh-client.json).
USB startup, complete drilled-copper terminal contact continuity, current and
thermal suitability, and other electrical review remain open.
