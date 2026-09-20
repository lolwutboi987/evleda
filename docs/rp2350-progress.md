# RP2350 continuation: 20 September 2026

Latest: [native host44 reassessment](../proofs/native-pad-policy-20260920/README.md)
verifies In1 local thermal policy and intended connectivity, correctly treating
the eight GPIO ground pads outside each plane as local-contact-inapplicable.
Independent connectivity/DRC remain good; all six source files are unchanged
through both refills, saves and normal close. Overall acceptance remains false
with 141 passed, 430 unknown and one failed row. Host44/DOC17 and the updated
skill are installed and fresh-client discovery verifies 17 tools. The follow-up
entry below describes the earlier software-only stage.

The [focused R1 follow-up](../designs/rp2350-pico/native-r1-followup-review/README.md)
finds a native ground-attachment witness in every supplemental In2 region and
exact nominal coverage for the two SWDIO_MCU ribbons previously reported as
uncertain by the coarse helper. The board is unchanged. The single-region
contract failure, header launch coverage and indirect contact evaluation remain
open. A separately tested source correction admits standard oval/mechanical
shield pads without weakening contact or override checks; installed host43 and
the historical native acceptance report are unchanged.

Current: [native R1](../designs/rp2350-pico/native-r1/README.md) has completed managed authoring, both saved fills, normal close and fresh read-only reopening. All six sources stayed unchanged, all 67 functional nets remain connected, and configured native ERC/DRC are clean. Portable files, previews, pinout, BOM and the complete source-bound engineering report are included. The supplemental In2 pour policy and debug reference findings remain open; overall acceptance is false. Host43/DOC17 and its fresh 17-tool client are qualified separately from electrical acceptance.

## Earlier review target, before managed completion

The [four-layer routed review candidate](../designs/rp2350-pico/four-layer-review-117/README.md)
contains the complete 22 x 60 mm layout: 1,099 tracks, 118 vias and all 67
functional nets connected in native pad reachability. Configured ERC/DRC have
zero findings. Portable project/library files, native previews, pinout, BOM and
the scoped engineering report are included. The GPIO soldering strips are clear
and all 887 measured sequential turns satisfy the straight/45-degree policy.

This archive is an unmanaged native review target. Its public-tool adoption,
final managed checks and normal close remain in progress. The debug-reference,
supplemental-plane and physical-impedance findings remain explicit; native DRC
does not turn them into engineering acceptance. The historical notes below
describe earlier checkpoints and are preserved.

## Historical continuation: 17 September 2026

The reviewed toolbox baseline is published at commit
[`8fa1203`](https://github.com/lolwutboi987/evleda/tree/codex/destination-resume)
on `codex/destination-resume`. Main remains the earlier Python implementation.
RP2350 progress is maintained on `codex/rp2350-pico`; it is not a finished native board.

The [current compiled candidate](../designs/rp2350-pico/candidate-readiness.md)
resolves the earlier draft's engineering inputs and binds the v4 library package,
62 electrical parts and four board-only mounting bores. Actual MCP submission,
native startup and normal checkpoint/close passed. U1 and J2 are now observed in
the public native schematic; PCB synchronization and copper authoring remain
unfinished. The [placement diagnostic](rp2350-placement-verification.md) records
the corrected USB escapes and mounting pattern, exact native rules, and a
field-only cleanup that removes all 238 silkscreen warnings. New bounded tools
support repeated schematic labels, precise graphic/glyph obstacles and atomic
PCB field presentation edits. Their scoped software and isolated native results
do not establish a completed public-tool RP2350 workflow.

Joint route planning now supersedes that placement-only milestone. The
[USBLC6 model correction](research/rp2350-pico/usb-feedthrough-model.md) retains
all six device pins on six signal nets, producing 67 board nets. It compiles with
the approved package, and its proposed USB copper reaches all 14 signal anchors.
Power-pin escape widths and flash/decoupling placement are being revised together;
the candidate06 submission created no native project. The [candidate status](../designs/rp2350-pico/candidate-readiness.md)
distinguishes the new source proposal from the preserved candidate05 MCP project.

The following unresolved-draft and connector records are historical inputs.
The [circuit inventory](../designs/rp2350-pico/circuit-inputs.md) and
[unresolved V2 draft](../designs/rp2350-pico/design-draft-notes.md) preserve 62
components, 65 nets and 262 logical pins, including two deliberate SBU no-connects.
Schema and exact inventory checks pass, but compilation needs clarification of
electrical operating bounds, construction, placement and routing constraints.
The [passive selection](../designs/rp2350-pico/component-selection.md) covers 49
references. The [v2 library package](../resources/pcb-libraries/rp2350-pico/v2/README.md)
adds self-contained flash/protection symbols and a flash footprint. Its resolver,
hash and isolated native-export checks do not establish assembly acceptance.

## Native connector attempt04

Update from [attempt05](../../destination-usb-c-native-05/assessment.json): the
NPTH guard is corrected and real native import, complete PAD observation, both
preserving translations, pad readback and top/assembly previews now pass. The
24-feature inventory includes two locating holes and four oval shield stakes.
Checkpoint preparation then rejected the stock footprint's undeclared legacy
`Dwgs.User` drawing layer. Native processes are gone and all six sources are
unchanged, but checkpoint/lease finalization failed and the unsafe state remains.
This is a successful authoring/physical-feature test, not a complete lifecycle.
The fixture's assembly value also extends outside its board; it is not a final
placement example. The bounded drawing-layer reader fix now passes against this
exact source through full semantic verification and checkpoint preparation in
an isolated copy: 100 tests passed and one optional native test was skipped.
The checkpoint publication callback was not invoked; the failed native session
and its lease/unsafe marker remain untouched. A successful native close after
this fix remains unverified.

DOC9 passed actual USB-C schematic field placement: two fields moved, electrical
source content was preserved, and saved native connectivity verification passed.
Both functional fixture nets and eight intentional NC terminals were retained.
This is a nonfunctional mechanical fixture, not the RP2350 USB circuit.

PCB import then failed at `saved-contract-pad-positions`: an older host guard
allowed only paste apertures as unnumbered features. The private diagnostic
retained imported native source: J1 has 22 features, 17 logical pads, four oval
shield stakes and two 0.65 mm NPTH locating holes; J2 adds two plated pads.
Full live native PAD observation and preserving placement were not reached.

The host reported exact disk/live PCB rollback; independent saved-byte comparison
confirms the empty preimage. Finalization failed; lease and unsafe marker remain.
No native editor was observed after close; the operator client then ended with
SIGINT/exit 1. This is not a successful checkpoint lifecycle. See the retained
[assessment](../../destination-usb-c-native-04/assessment.json).

## Verification and next step

An isolated snapshot including the drawing-layer and via-category guards passed
backend/UI typechecks and the package build with DOC9
runtime verification. Installed `dist` stayed untouched because existing Codex
connections use it. Receipts are outside Git under
`destination-verification/rp2350-toolbox-integration-04`.
Failure diagnostics separately passed 200 tests across four files. These are
scoped results, not a new passing full-suite claim.

The remaining connector concern is checkpoint handling of the retained technical
drawing layer. The custom
package, complete USB channel and derived power assertions still need integrated
native qualification. New software support for a declared external input through
one forward Schottky path was developed after this build and was not exercised
by attempt04; it does not qualify diode drop, power combinations or current.

Historical full-suite failures and failed native projects remain preserved.
Manufacturing release, ordering, firmware and physical qualification are outside
this milestone.

The subsequent user-requested [via-clearance verification](via-clearance-qualification.md)
now includes real negative/control DRC cases and a stricter disabled-check guard.
The [placement plan](../designs/rp2350-pico/placement-intent.md) ties functional
groups and orientation to the actual pin map; it remains a proposal needing
native placement and clearance checks.
