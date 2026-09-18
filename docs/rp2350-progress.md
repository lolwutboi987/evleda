# RP2350 continuation: 17 September 2026

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
