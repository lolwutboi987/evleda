# DOC10 schematic cardinal correction

Snapshot: 2026-09-18. Runtime `C:\EvlEDA-DOC10-20260918` has scoped geometry
qualification. Corrected profile `toolbox-native-doc10-rp2350-v4-02.json` passes
real profile admission. **Actual unwired DOC9→DOC10 import passed on build02.**
The source native08 and imported target retain 62 unwired symbols and an empty
PCB. Public workspace reopen, checked reads and normal close also pass.

## Corrected geometry

DOC9 rotated already Y-inverted library coordinates, reversing 90° and 270°
schematic placements. DOC10 rotates in library space before sheet Y inversion:

| Symbol rotation | Sheet offset |
| --- | --- |
| 0° | `(x, -y)` |
| 90° | `(-y, -x)` |
| 180° | `(-x, y)` |
| 270° | `(y, x)` |

The matching host inward pin angle is `(local angle + rotation) mod 360`.
`tools/schematic.py` supplies corrected pin/alias positions and graph consumers;
`models/visual_qa.py` supplies the shared visual transform used by field layout.
The runtime relocation also changes its Python home. PCB transforms are
unchanged. The [patch and qualification references](patches/doc10/README.md)
retain the precise file scope and predecessor identities.

Independent KiCad 10.0.3 XML netlists associate spatial probe labels with all 36
pins of stock R, actual Q1 (`Q_NMOS_GSD`, value `DMG1012T`) and `Crystal_GND24`
at all four rotations. A separate SVG supplies inward pin-stroke directions;
all four crystal 2/4 stacks survive. Registered DOC10 read-tool bodies, exact
aliases, pin-bearing graph groups and visual geometry agree with that oracle.
DOC9 is the negative control. Terminal-free probe labels are retained separately;
the qualification does not assert whole graph/net-count equality.

The [native corpus](../tests/fixtures/schematic-cardinal-native/README.md) records
source and executable identities. A strict isolated, no-bytecode recapture
reproduced its observations. A later isolated 62-symbol diagnostic matched all
262 pin identities and 248 terminal anchors; this extends pin-geometry evidence,
not readable final wiring or managed-board acceptance.

## Admission correction

The `-01` profile retained DOC9's path-derived Python launch-argument hash after
relocation. The first administrative import therefore failed real native
profile admission before workspace allocation; source artifacts stayed intact.
Its passing geometry evidence did not establish profile admission.

New profile `-02` corrects only that hash for the unchanged four isolation flags
and relocated launcher. Runtime/manifest bytes, argument count, bytecode policy,
libraries, KiCad and helper identities remain unchanged. Both real production
profile readers and complete runtime closure checks pass. The original `-01`
profile, receipts and failure evidence remain preserved.

Corrected receipt/report/admission identities are recorded in the transfer-root
`destination-verification/doc10-runtime-qualification-02/final-identities.json`.
The `-02` profile SHA-256 is
`a30a63aa6ada7ed57fc57c1ced9e3f7837b33e75f33c9daf1c42757a8cc9f400`.

## Import boundary

The [trusted host importer](../src/mcp/toolbox-runtime-source-import.ts) is an
administration capability, outside model-callable workspace tools. It verifies
the normal source close, exact unwired source/checkpoint/library custody, both
runtime closures and the narrow qualification before allocating a new target.
It preserves the source and records `nativeEvidenceTransferred: false`.

The target needs its own normal native open/save/checkpoint/close lifecycle and
fresh observations. Profile admission, registered-tool qualification, source
copying and isolated CLI geometry do not establish that lifecycle. Host label
planning also retains full native frame/stroke envelopes and the intended
incoming-port constraint; complete native label readability remains a separate
check. See [revisions, batch placement and native rules](../docs/toolbox-schematic-revisions-and-native-rules.md).

The build02 import driver exited 0 at 2026-09-18 09:14:28 UTC. Target
`3fa025b9-b9fe-4c74-9773-a6d8e15416b3` completed normal native save, checkpoint
and close. All ten pinned original source artifacts remained unchanged; seven target
artifacts matched custody. Leases, unsafe markers and locks were absent at
import completion. `nativeEvidenceTransferred` remains `false`.

Evidence: transfer-root `destination-verification/rp2350-doc10-import-02/`
contains `driver-exit.json` and `post-import-verification.json`; custody SHA-256
is `d84e1242b52da82f74a21b405a952cccfd2271dd97ccabdc444c730564461da8`.
This imports the exact 21 mm bundle. A subsequent same-profile 22 mm revision
completed native creation and normal close with seven source/bundle files
unchanged; its PCB still has no outline, footprints or copper. Evidence is in
`destination-verification/rp2350-native-22-seed-02/post-close-verification.json`.
Public resume through build03/session13 observed all 62 symbols, 248 unwired
groups and the corrected Q1 quarter-turn pin positions. Seven source/bundle
artifacts stayed byte-identical through the reads and normal public close;
the lease was released and the operator client exited normally. The separate
`public-reopen-read-verification.json` and `public-reopen-close-verification.json`
retain this evidence. Wiring, routing and board acceptance remain unfinished.
