# Local placement study — not applied

The native 22 × 60 mm, two-layer board is unchanged: **829 tracks, 104 vias, 24 unconnected DRC errors**. This is planning evidence, not a native board revision or manufacturing candidate. No native session was opened and no component was moved during this study.

## USB-only result

The analytical proposal rotates the two 0603 USB resistors horizontally and keeps both pads of each resistor within the existing 2 mm MCU distance bound. All four distances are 1.28–1.82 mm. The two complete connector-path copper skews are **0.942355 mm** and **0.865297 mm**, within the 1 mm bound. Source checks pass polarity mapping, topology, width, minimum opposite-polarity gap, length, skew, branch/escape budgets and signal-layer transitions. The aggregate coupled-gap row remains **not_assessed**. There are zero measured turn violations and seven unresolved junction findings in this deliberately incomplete analytical source.

The D+ body has an early 45-degree offset adding 0.787006 mm. The proposal retains the original USB connector-side routing. It passed the source clearance and reference-obstruction screen against the retained scene, but **omits 88 tracks and six vias** for the coordinated local reroute. Its missing power, ground and QSPI replacements prevent adoption. Fresh plane geometry, native DRC and electrical/impedance acceptance were not assessed.

## Combined placement result

The initial USB arrangement blocks the switch-node and input-capacitor exits. Later bounded studies reorient L1 so its switch pin faces the MCU, separate the analog filter parts, reserve an input-capacitor path, and move C14 to examine flash escape space. Some variants route the critical regulator connections, but none restores every removed connection. The latest variants also remove the old QSPI clock and SD0 paths analytically; neither route ordering completes that three-signal fanout together with C14. No such removal was applied to the native board.

Do not repeat these exact failed samples. Next work must solve the local flash fanout and capacitor/supply/ground returns together, then check power-route widths, loop area, via drills/paste/clearances, all USB channel limits and the complete retained scene before any native change. Narrow 3V3 necks in the later proposals remain unreviewed for current and thermal suitability. Grid search failure does not prove that the allowed placement region is impossible.

## Evidence

- [USB proposal](usb-only-proposal.json): eight hypothetical poses, replacement USB paths and scoped source screen.
- [Full USB source assessment](usb-only-source-assessment.json): exact analytical source identity, interface facts, native deletion IDs and practice findings.
- [Study summary](study-summary.json): unchanged managed-file hashes, compact metrics and failed combined attempts.
- [Local inventory](local-study-inventory.json): hashes and sizes of retained scripts, models and analytical copies in the transfer workspace. These local scripts depend on prior study artifacts and frozen host30; they are not packaged as standalone product functionality.

The authoritative native candidate remains project 914f7760-c4c2-4bb8-9b51-b481242878a5 described in [the qualified placement revision](../../../proofs/native-placement-revision-20260919/README.md). Its original rules, bundle and saved board were not changed or waived. Both full-height GPIO service strips remain protected on both copper faces.
