# Regional connections through intact via annuli

**Native-qualified and installed in host57 on D:.** Fresh refill/save, complete
assessment and normal close verified the geometric connection from all 10
supplemental regions to the primary ground plane. All 41 candidate via annuli
are strictly clear of the other 170 bore enclosures. The declared supplemental
island policy is verified; all six board sources remain byte-identical.

All 67 functional nets connect and configured DRC is clean. The complete
plane-policy row remains unknown, and full acceptance remains **143 pass,
431 unknown, 0 fail; accepted=false**. Full terminal contacts, physical widths,
current and thermal suitability, and USB startup remain open.

See [native summary](native-summary.json), [complete public report](public-report.json),
[assessment](native-assessment.json), [delivery](delivery.json),
[installation](installation.json) and [fresh client discovery](fresh-client.json).
The current managed board stayed closed; validation used the separate existing
copy. The build and client evidence are on D:, and user applications stayed open.
A fresh Codex client discovers 19 tools; existing desktop reload is unestablished.

The source checker now distinguishes a surviving local contact patch from a via
annulus whose entire outer disk is clear of every foreign bore enclosure. It
retains the original local observations, handles exact tangency conservatively,
and can choose a different intact via for the same region.

The separate geometric network fact requires current native contacts, verified
drill-subtracted interiors on both planes, the exact declared rectangular board
outline, and qualified via dimensions and edge containment. This can verify the
declared supplemental island-policy fact. Complete terminal contacts, physical
widths, current capacity, the full plane-policy row and manufacturing acceptance
remain separate. Explicit failures and unknowns are preserved.

The [historical-data replay](static-replay.json) finds intact witnesses for all
10 supplemental RP2350 regions using 41 common ground vias and all 171 bore
enclosures. It reproduces every prior local contact observation. This is a new
calculation on hash-verified host56 data, not a fresh native observation or fill
authority. The subsequent native result above separately qualifies this extension;
the replay is not relabeled as current native evidence. The board remains unchanged.

[198 local tests across four affected files](verification.json) pass, using D:
for temporary files. The reporting fixture now uses an explicitly relative path
so moving temporary storage across Windows drives does not turn that test input
into an absolute path. No runtime path guard was changed.

The [full source and UI typechecks, backend compilation and source-emit guard](https://github.com/lolwutboi987/evleda/actions/runs/35570334514/job/106240444784)
passed on GitHub for source commit `fb752a6b30c9b360cd1524667a32f7a32e45298a`.
The exact checked source hashes are retained in the verification record. This
avoids requiring the user to close active applications after local compiler
attempts exhausted bounded heaps.

After memory headroom improved, the frozen D: backend build also passed with a
2 GiB heap cap and a fresh measured headroom check. No user app was closed and
no Windows paging or memory setting was changed.

The overall workflow remains failed: the unchanged native-dependent job reports
that its runner lacks the separately installed pinned KiCad runtime. That gate
was not skipped, disabled or relabeled as passing. The new independent portable
job establishes type/build results only, not full-suite or native qualification.
