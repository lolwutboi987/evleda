# Native saved-board recovery, September 20

Two failed RP2350 sessions were recovered into separate allocations using the
operator workflow. Neither original project's sources, checkpoint, lease, or
unsafe marker was repaired in place. The original failures remain failures.

The first recovery imported the last verified native save after a second-plane
fill exceeded the former live-source size limit. It retained 831 tracks and 109
vias and applied the separately reviewed RUN via-budget reallocation. The new
target completed native open/save/readback, checkpoint, and close.

The second recovery followed an eleven-footprint placement save and a rejected
field batch. The existing USB-C value label was at y = -0.025 mm. The rejection
occurred before field edits, but the old MCP wrapper quarantined every dispatched
mutation error. Two fresh read-only native captures matched one another and the
saved board under the existing serialization comparison. All six saved source
files were preserved before closure and checked unchanged afterward.

The second target retained the same authenticated bundle, 831 tracks, 109 vias,
and the eleven saved placements. Its new native open/save/readback and normal
checkpoint/close succeeded. It has no transferred plane-fill freshness or design
acceptance. The corrected label batch and later routing are separate operations.

| Evidence | SHA-256 |
| --- | --- |
| First native recovery result | `78bdb2234b4ad6a70499c04ac0236f058d498f49fe0a7c3617136d5aac7efb41` |
| Second pinned recovery request | `eba2ed3732f3887499729f7045b1caa65c58e37c22fd030b1a7622b7aa416de5` |
| Second native recovery result | `f8ee9710879de62cf1dcb1e324a3507b0a3a0a8d2d37ee2cdb931dd217b26d75` |
| Second saved PCB, 478225 bytes | `f671e034944024eb47c645288cb1c263741ce6586dbdb9e6925998915adcc44c` |
| Matching live serialization, 452026 bytes | `d46f5b6155fbd3b6f91c5b47e7cd450f8c50c023e469c846afe395f778948c05` |
| Unchanged second source/target bundle | `46dccf0a2f1b50a370ab4feddce6b1b97afe5b8218fac11cdc0fe1add7439e47` |
| Frozen host41 release manifest record | `4d7e1cbc32ac6a01e8b8d897b2c0e54cedbdad519f9a27ebc59a413b4697009c` |

Full local records remain under `destination-verification/saved-plane-recovery-01`
and `destination-verification/field-preflight-recovery-01` in the transfer root.
These hashes identify retained records; this summary is not a portable replay of
the native environment.

Host41 passed source and UI typechecks, backend build/helper packaging, and 193
focused tests across eight files. Tests cover corrected edits after pure planner
rejection, rejection-receipt forgery/replay, retained quarantine after native
errors, source-preserving recovery, and placement/via-budget regressions. Earlier
capacity changes additionally passed the scoped host39/40 checks recorded in the
local build evidence. These overlapping counts are not a full-suite result.

The RP2350 board remains incomplete. The reviewed layout proposal still reports
six missing connections across RUN, GPIO22, GPIO24_VBUS_SENSE, and
GPIO29_VSYS_SENSE, along with dangling copper and isolated islands. Recovery and
software checks do not establish an electrically complete or manufactured board.
