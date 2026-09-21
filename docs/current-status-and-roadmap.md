# Current status and roadmap

Updated 21 September 2026. The active product is the **chat-driven KiCad toolbox**.
The separate application/UI remains preserved and deferred. The RP2350 native
layout is available; **engineering acceptance remains incomplete**.

## Current delivery

| Item | Verified state and evidence |
| --- | --- |
| Native RP2350 project | [Open R2](../designs/rp2350-pico/native-r2-spacing/README.md): 22 × 60 mm, four layers, 62 electrical parts, four mounting bores, 1,098 tracks and 118 vias. Native project, schematic, libraries, previews, pinout and candidate BOM are included. |
| Placement correction | The new checker found C12–R7's 0.02 mm gap against the required 0.10 mm. R7 and a nearby GND via move slightly, producing 0.12 mm without changing signal tracks or clearance requirements. All 62 placement rows pass. |
| Routing and GPIO access | All 67 nets connect. 886 measured straight/45° turns have zero violations; both GPIO service strips remain clear with 42 own-pad inward leads. Configured native ERC/DRC and strict portable parity are clean; retained reports list exclusions. |
| Managed workflow | Native save, normal close and fresh read-only reopening are verified. Continue project **0474c726-1b0c-492b-b376-9c6a06ee9d72**. Parent and older failed allocations remain preserved. Read-only placement checks pass without inventing fresh-fill authority. |
| Installed client | [Host60 / DOC17 / v4 profile](destination-client-installation.md), with 19 tools verified in a fresh actual Codex client. The host is on D:, which must remain mounted. Already-connected desktop activation is unestablished. |
| Full assessment | **225 pass, 349 unknown, 0 fail; accepted=false.** All 62 placements, 19 geometric reference rows and nominal paths from 64 physical GND pads pass. Unknown rows include unfinished checker integration and material electrical requirements. |
| Software verification | [160 affected tests](../proofs/placement-spacing-20260921/verification.json), full source/UI typechecks and frozen backend compilation pass. The recorded GitHub portable job passes; native-dependent CI fails for an unavailable pinned KiCad runtime. No full-suite or all-green CI claim. |

The [placement proof](../proofs/placement-spacing-20260921/README.md) retains the failed original gap,
review proposal, current native result, read-only reopen and client installation.
The [supply-route review](../designs/rp2350-pico/power-path-review-20260921/README.md)
retains external-VSYS drop and ADC voltage-margin concerns.

## Remaining work

1. Integrate remaining schematic/library/PCB/trace checks against their original
   requirements. Complete physical-width, current, thermal and interface evaluation.
2. Resolve the complete USB attach/startup circuit and workload sequence, preserving
   USB power, external VSYS and the EN header. Existing part screens are not a
   coordinated startup solution.
3. Address native route-inventory latency: this board requires 39 sequential
   pages, each repeating complete validation. Preserve source and native freshness
   while reducing repeated work; the current frozen host remains qualified as run.
4. Complete the remaining prompt-driven/client demonstration and final original-
   requirement review. Tool discovery and scripted native proofs have distinct scopes.

Published work is on [codex/rp2350-pico](https://github.com/lolwutboi987/evleda/tree/codex/rp2350-pico).
Main retains the earlier application. Firmware, ordering, physical qualification,
manufacturing release and a separate UI remain outside this scope.

Earlier entries below retain their own dated claims and do not supersede this state.

<details>
<summary>Historical status entries and earlier evidence — superseded snapshots</summary>


The [host54 native qualification](../proofs/plane-exterior-bores-20260920/README.md) verifies the primary ground plane's connected planar interior after drill subtraction, including exact exterior classification of all four mounting holes. The separate validation copy completed fresh refill/save, full report retrieval and normal close with all six board sources unchanged. The installed [host57 regional-network update](../proofs/plane-region-network-20260921/README.md) additionally verifies the geometric connections through intact via annuli and the declared supplemental island policy; a fresh actual Codex client sees 19 tools. Current managed board **7e129f34-8a45-454c-b8dd-cf06b770ba74** remained closed. Full assessment is **143 pass, 431 unknown, 0 fail; accepted=false**; USB startup, full contact continuity and electrical review remain open.

Earlier installed result: [host53 bore-shape and report qualification](../proofs/plane-bore-shapes-20260920/README.md) handles all 171 bores, including 4 connector slots, on the unchanged RP2350 board. Both public refills/saves and normal close preserve all six sources. Large reports return every finding through an immutable public resource. The full assessment is **143 pass, 431 unknown, 0 fail; accepted=false**. A fresh actual Codex app-server verifies19 initial tools. The prior host52 response-size failure is retained separately; USB startup and broader electrical review remain open.

Operational note, 20 September 2026: a [runtime-latency experiment](../proofs/runtime-verification-latency-20260920/README.md) improved the isolated verification benchmark but failed native startup qualification, so it was reverted and never installed. Host50/DOC17 remains current. Managed RP2350 work now uses **17b88ed0-adea-4634-a468-8d417dc16c97**, recreated through the existing public revision operation with all six native files byte-identical to the published candidate and normal close verified. The failed allocation and lease remain preserved; board geometry, requirements and electrical-review status are unchanged.

Current native delivery, 20 September 2026: [explicit terminal-launch revision](../proofs/terminal-launch-policy-20260920/README.md) qualifies both local debug-header approaches and their continuously referenced bodies while preserving routing, placement, canonical RP2350 rules and the original project. The new candidate completed native save/close and fresh read-only reopening. All 67 nets connect; configured checks are clean. Full assessment remains **incomplete: 143 pass, 431 unknown, 0 fail**. Host50/DOC17 and the updated skill are installed, with 19 tools verified in a fresh actual Codex client. USB startup and broader electrical qualification remain open; earlier reports below retain their original intent and checker scopes.

Current capability, 20 September 2026: [host49 terminal-launch study](../proofs/terminal-launch-study-20260920/README.md) adds a read-only prospective connector approach analysis to the existing reference tool. Actual public calls preserve both full-route failures while finding covered remainders outside 1.9 mm clock and 1.5 mm data approaches, at the unchanged margin. Both diagnostic resources were read/hash-verified and normal close preserved all six native sources. Host49/DOC17 and the updated skill are installed; a fresh actual Codex client discovers 18 tools. No design requirement or acceptance changed; the latest full native assessment below remains failed/incomplete.

Current installed result, 20 September 2026: [host48 native reference-gap qualification](../proofs/native-reference-gap-20260920/README.md) reports the two confirmed debug-header approach gaps on the unchanged RP2350 candidate. The full native assessment is **failed/incomplete: 141 pass, 429 unknown, 2 fail**. Both refills/saves and normal close preserve all six sources, all 67 nets remain connected, and configured DRC is clean. The installed host48/DOC17 entry is verified through a fresh actual Codex client with 18 tools. Historical reports below retain their original checker/source scopes.

Source follow-up, 20 September 2026: [reference-gap reporting](../proofs/reference-gap-reporting-20260920/README.md) now retains exact missing-copper witnesses when complete plane topology or anchoring is unknown, while keeping positive reference acceptance unproved. The saved regional candidate has two confirmed debug-header approach gaps across 21 checked segments. This scoped correction passes 110 focused tests and is separate from installed host47 and its preserved native assessment.

Current delivery, 20 September 2026: the [regional-policy RP2350 candidate](../designs/rp2350-pico/native-r1-regional/README.md) preserves the completed physical board and verifies a separate explicit supplemental-ground policy. All ten regions have qualified contacts and retained-area bounds; the full assessment remains **incomplete: 141 pass, 431 unknown, zero fail**. Native save, normal close and fresh read-only reopen are complete, with 67 connected nets and configured ERC/DRC clean. [Host47 qualification](../proofs/native-plane-policy-revision-20260920/README.md) records 320 passed/2 skipped focused tests and 18 tools in a fresh actual Codex client. USB startup, debug-header launches and other electrical review remain open. The original R1 and its failed single-component rule remain preserved. Earlier dated entries below describe their own source revisions.

Latest observation, 20 September 2026: [host46 native plane-region contacts](../proofs/native-plane-regions-20260920/README.md) verifies a positive-area, bore-clear via contact joining each of the ten supplemental In2 regions to the endpoint-anchored primary plane. It checks complete source/native geometry, direct native contacts and all 171 bore enclosures. Both public refills/saves and normal close preserve every source file. This observation deliberately leaves the original single-component failure and all other acceptance rows unchanged: **141 pass, 430 unknown, one fail**. Host46/DOC17 and the current skill are installed; fresh-client discovery verifies 17 tools.

Latest qualification, 20 September 2026: [host44 native pad policy](../proofs/native-pad-policy-20260920/README.md) verifies the main In1 plane's local thermal policy and intended connectivity on the byte-identical RP2350 R1 board. The eight GPIO ground pads are correctly outside each plane's boundary and use inward access tracks; their local zone-setting applicability is separate from connectivity. The fresh assessment has **141 pass, 430 unknown and one fail**, retaining In2's single-component mismatch and all other limits. Both refills/saves and normal close preserve all six sources. Host44/DOC17 and the updated skill are installed, with 17 tools verified in a fresh client. The prior assessments below remain historical.

Current delivery, 20 September 2026: [RP2350 native R1](../designs/rp2350-pico/native-r1/README.md) completes public-tool routing, labels, both saved fills, normal close and a fresh read-only reopen with all six source files unchanged. All 67 functional nets are connected; configured ERC/DRC and portable-copy schematic parity report zero findings. The candidate includes native files, custom libraries, previews, pinout, BOM and its complete assessment. **Engineering acceptance remains failed/incomplete: 141 pass, 429 unknown, two fail.** In2 supplemental-plane component policy, debug reference gaps and plane-contact/electrical qualification remain unresolved; the main In1 plane has one filled component. No bound rule was relaxed.

The [DOC17 qualification](../proofs/native-plane-receipt-doc17-20260920/README.md) records two actual complete native refill receipts above the old logical-node ceiling, mandatory native save/readback, preserved recovery history and 250 passed/2 skipped focused tests. Host43/DOC17 is installed in the existing workspace client; a fresh actual Codex client discovers 17 tools. Existing desktop connections are not claimed to have reloaded. Older milestones below retain their dated scopes.

## Historical milestones

Latest native/toolbox continuation, 20 September 2026: [host42 field-size qualification](../proofs/native-large-field-20260920/README.md) removes the stale 500 KB field-planner ceiling while retaining the shared 1 MiB input/output limit. All planned RP2350 routes saved, the project closed/resumed with unchanged sources, and 124 field updates then passed actual native save/readback. Labels and final fills/checks remain in progress. The default client now uses host42 with the same DOC16 profile and 17 tools verified in a fresh client.

Latest client delivery, 20 September 2026: [frozen host41/DOC16 installation](../proofs/client-doc16-20260920/README.md) preserves the existing stock catalog, adds the approved v4 RP2350 package and installs the current skill. Seven read-only preflight calls and a fresh actual Codex client verify 17 initial tools with zero native allocations. The already-running conversation has not demonstrated the updated vendor-part access; fresh-client verification is kept separate from desktop activation and board acceptance.

Latest native review, 20 September 2026: the [complete RP2350 four-layer candidate](../designs/rp2350-pico/four-layer-review-117/README.md) is available as portable native KiCad files with previews, a pinout, candidate BOM and engineering review. All 67 functional nets are connected in the native physical-pad check; configured ERC/DRC report zero findings. It has 1,099 tracks, 118 vias, 887 measured straight/45-degree turns without violations and clear GPIO service strips. This is an unmanaged review target. Public-tool adoption is still running; final managed save/checkpoint/close and acceptance are pending. Debug reference coverage, supplemental-plane component policy and physical impedance limitations remain explicit. The older milestones below retain their historical scopes.

Latest toolbox milestone, 19 September 2026: [native placement revision](../proofs/native-placement-revision-20260919/README.md) now preserves a fully authored V2 board while creating a separate project with changed placement constraints. The real 829-track RP2350 board passed creation, mandatory save/refill, native checks, normal close and read-only reopening with stored lineage. This enables the next coordinated USB/regulator placement change; it does not move components or complete routing.

Latest native milestone, 19 September 2026: [ground bridge revision 60-13](../designs/rp2350-pico/native-ground-bridge-60-13/README.md) is normally closed and read-only reopened with **831 tracks, 106 vias and one B.Cu ground zone**. A 0.6 mm front bridge and two vias join the C8/C20/C22 ground group to the main region: **eight groups, 52 of 64 ground pads in the main group**. Native unconnected errors fall from 24 to **23**, with the same 13 dangling-item warnings; 53 nets are connected and 14 remain disconnected. The source audit has 632 measured turns, zero violations and eight unresolved junctions. Both GPIO service strips are clear with 40 exact own-pad leads. Source hashes and native top/assembly views persist through read-only reopening. No component moves were applied; USB placement, remaining routing, labels and electrical/DFM review remain unfinished. Overall acceptance is false.

Earlier native milestone, 19 September 2026: [ground connections 60-11](../designs/rp2350-pico/native-ground-links-60-11/README.md)
is normally closed with **807 tracks, 104 vias and one ground zone**. Ten added
front segments join five ground groups, leaving **12 groups with 48 of 64 ground
pads in the largest group**. There are still 53 connected and 14 disconnected
nets. DRC reports 27 unconnected errors and 13 dangling-item warnings, with no
reported clearance violations. Placement and all existing routes/vias are
preserved. Header service regions are clear in the complete source audit.
The existing USB placement/turn and junction findings remain, and the board is
unfinished. The [spatial geometry checker](plane-geometry-spatial-filtering.md)
now verifies captured native/saved fill within the unchanged work bound;
live host25 qualification was separate and pending at that checkpoint.

Earlier native milestone, 19 September 2026: [ground plane 60-10](../designs/rp2350-pico/native-ground-plane-60-10/README.md)
is normally closed with **797 tracks, 104 vias and one B.Cu zone**. Existing
routes and footprints were preserved. Native DRC unconnected findings fell from
66 to 32, with 13 dangling-item warnings and no reported clearance violations.
There are still **53 connected and 14 disconnected nets**; GND has 17 physical-pad
groups, with 40 of 64 pads in the largest group. Primitive checks plus bounds of
all 2,344 stored fill vertices establish GPIO service-strip exclusion, while
full fill topology remains unverified. The USB placement/turn findings, ground
ties, remaining signals, labels and electrical/DFM work remain unfinished.
Host24 fixes the plane adapter's duplicated PAD envelope. A narrowly scoped,
tested recovery archived the earlier failure metadata without rewriting any
source or checkpoint before the successful new native session.

Earlier toolbox milestone, 19 September 2026: [lossless compact plane receipts](plane-receipt-compaction.md)
now pass native CREATE, UPDATE, mandatory save/readback and normal close with
host23/DOC14 on a separate three-component fixture. The first DOC13 live attempt
exposed a native OrderedDict case; its failed state is preserved. DOC14 corrects
that producer case while keeping the artifact/work limits and full host checks.
The successful fixture's reference-ribbon failure and unknown acceptance rows
remain explicit. This enables the next RP2350 plane trial; it does not establish
RP2350 fill, return paths or complete routing.

Earlier native milestone, 19 September 2026: the
[60-09 frozen-plan snapshot](../designs/rp2350-pico/native-route-plan-60-09/README.md)
is normally closed with **797 segments, 104 vias and no zones** through all 68
planned batches. Native endpoint checks report **53 connected and 14 disconnected
nets**. Both GPIO service strips remain clear with 39 exact own-pad leads.
Configured ERC has zero findings; DRC reports 66 unconnected errors and 55
dangling-item warnings, with no reported clearance/courtyard/parity findings.
The angle checker measures 598 turns with one USB protection-pad fork flag;
eight junctions remain unresolved. Both USB line-side resistor pads exceed the
declared 2 mm placement bound. No plane fill was attempted: repeated source/PAD
evidence is estimated to exceed the existing artifact limit and needs lossless
compaction. **Routing, plane fill, labels and design acceptance remain incomplete.**

Earlier native milestone, 19 September 2026: the
[60-08 signal-routing snapshot](../designs/rp2350-pico/native-signal-routing-60-08/README.md)
is normally closed with **630 segments, 96 vias and no zones** through batch 50.
Native endpoint checks confirm **35 of 67 nets connected**, with every eligible
physical member reachable on those nets; 32 remain disconnected. The six flash
nets, LED_A, RT_LX1/2, SWCLK_HDR and five additional GPIO nets are now connected.
Both GPIO service strips remain clear with 37 exact own-pad leads. Configured
ERC has zero findings. DRC reports 102 unconnected errors, 36 dangling vias and
19 dangling tracks, with no reported clearance/courtyard/parity findings and its
exclusions retained. Corrected source analysis checks 465 sequential turns
without violations; four branch junctions remain unresolved. All six sources
match the closed checkpoint. **Routing, ground fill, labels, return-path
verification and design acceptance remain incomplete.**

Earlier native milestone, 19 September 2026: the
[60-07 GPIO-routing snapshot](../designs/rp2350-pico/native-gpio-routing-60-07/README.md)
is normally closed with **512 segments, 87 vias and no zones** through batch 30.
The public native endpoint checker confirms **20 of 67 nets connected**, with
every eligible physical member reachable on those nets; 47 remain disconnected.
Both GPIO service strips are clear. Configured ERC has zero findings. DRC reports
119 unconnected errors, 35 dangling vias and 14 dangling tracks, with no reported
clearance/courtyard/parity findings and its exclusions retained. Corrected saved-source
analysis checks 376 sequential turns without violations; four branch junctions
remain unresolved, and the original frozen-host numerical false flags remain
recorded. All six sources match the closed checkpoint. **Full routing, ground
fill, return-path verification and design acceptance remain incomplete.**

Earlier native milestone, 19 September 2026: the
[60-06 power-routing snapshot](../designs/rp2350-pico/native-power-routing-60-06/README.md)
is normally closed with **319 segments, 58 vias and no zones** through routing
batch 10. Both GPIO service strips are clear. Native ERC has zero findings;
configured DRC reports 135 unconnected errors, 34 dangling vias and nine dangling
tracks, with no clearance findings. Its ignored categories remain explicit.
Four near-zero turn flags were proved exactly straight and corrected in the
working-source angle calculation; the frozen native report remains unchanged.
Four branched junctions still lack complete bend coverage. The fix preserves the
angle tolerance, passes the four reproductions and small-real-deviation tests,
and retains the unresolved junctions. Backend/UI typechecks and isolated backend
compilation pass. Of 65 selected tests, 64 pass; one unchanged workflow test is
blocked by its missing Rev-A PCB fixture. **Routing and board acceptance remain
incomplete**, including the EN connection and ground-plane verification.

Earlier native milestone, 19 September 2026: the
[60-05 ground-routing snapshot](../designs/rp2350-pico/native-ground-routing-60-05/README.md)
saved and read back **92 ground-track segments and 38 vias** under DOC12/host20,
including the exact batch that previously exceeded the native snapshot limit.
All 66 footprints, 281 physical pad members and 53 drills matched independent
placement verification. The two GPIO service strips are clear in the actual
saved-source audit. Native ERC has zero findings; configured DRC reports only
181 unconnected errors, 34 dangling vias and eight dangling tracks. Its five
ignored categories remain explicit. There are no zones yet. Forty-four measured
turns have no violations; one ground-via junction remains unresolved. All six
sources match the normally closed checkpoint. **Full routing, plane/reference
verification and board acceptance remain incomplete.**

Earlier routing development, 18 September 2026: a later 60 mm candidate saved
32 ground vias, but the next 92-track/six-via batch exceeded the complete native
PAD snapshot message bound. Automatic recovery verified the exact 32-via saved
preimage; normal close failed and the allocation remains retained for review.
The [DOC12 compact-envelope fix](rp2350-native-pad-envelope-fix.md) preserves every
observation and the existing limits, and passes offline, installed-producer and
compiled-host checks. The live failure boundary is now cleared by 60-05 above.

Earlier verified native milestone, 18 September 2026: **candidate 60-03 is saved
and normally closed as a native 22 × 60 mm, two-layer KiCad project**, retaining
the original 2.54 mm header pitch and 17.78 mm row spacing. Its
[native files, original previews and evidence](../designs/rp2350-pico/native-placement-60-03/README.md)
are published, with a separate [placement-intent map](../designs/rp2350-pico/placement-intent-60-03.md).
Independent pre-field verification matches all 66 footprints,
281 physical pad members and 53 drills, including 92 selected public native pad
rows. The guarded field/save chain links that placement to the final PCB;
post-close verification matches all six authored source files and the report.

**The PCB remains unrouted: zero tracks, vias and zones.** The subsequent
[live native validation collection](../designs/rp2350-pico/native-validation-60-03/README.md)
now completes all four checks under host19, with unchanged source fingerprints.
ERC reports zero findings. DRC remains **FAIL with 192 unconnected errors** and
no other violation rows; all 192 findings are retained, with an explicitly
partial eight-row inline sample. Five ignored DRC categories remain recorded.
Visual QA reports eight warnings and six informational rows, retained with
source-based triage. Successful collection does not approve the board. Routing,
return paths, functional labels and fabrication acceptance remain unfinished;
the intrinsic USB pad-to-NPTH source finding remains unwaived.

Earlier collection failures remain preserved. The fixes retain complete large
ERC/DRC evidence privately, keep the annotated source guards active without an
early 32,000-byte text conversion, and preserve only the two exact public KiCad
schema URLs in their `$schema` field. Other path/secret filters and report
validation predicates remain enforced. Rejected reports now retain bounded
private diagnostics. The native host19 result verifies the complete collection
path; the original placement snapshot records its earlier failed run unchanged.

Earlier native milestone, 18 September 2026: **the 22 × 51 mm V9 project
completed real public schematic-to-PCB sync, the reviewed 62-component placement
batch, mandatory native save/readback, and normal close under DOC11 host16 in
session26.** Project `d9435dc1-27b9-4fff-8af6-f6a2cfe897e8` now retains its connected
schematic and placed PCB. The [native files and original previews](../designs/rp2350-pico/native-placement-v9/README.md)
are published with their exact identities and limitations. Earlier sync failures remain preserved;
they no longer describe the latest verified native state.

The independent [placement/readback verification](../designs/rp2350-pico/native-placement-v9/evidence/verification-result-host16-02.json)
matches all **66 footprint poses, 281 physical pad members and 53 drills** to
the selected model, contract and complete pinned library definitions. Those
members include 265 numbered copper pads, 10 anonymous paste pads and 6 NPTH
holes; 4 of the NPTH holes are the separate board-only mounting features.
The actual host receipt verifies the 62 electrical placements and native save.
Public reads independently match 81 physical pad rows from U1, C10 and J1 by
UUID, geometry, layers and drills; the bounded aggregate read reports the full
inventory without exposing every row. Raw private native snapshots were not
independently replayed. All verification inputs remained unchanged.

The [normal-close response](../designs/rp2350-pico/native-placement-v9/evidence/normal-close-response.json)
reports the project closed. Separate [post-close disk verification](../designs/rp2350-pico/native-placement-v9/evidence/v9-normal-close-verification-01.json)
matches all 6 authored source files and the report to checkpoint
`7bd6cf8d71944e6adb132f2035b445e3dc5fc0693e37df69995953e73a45eb36`.
No lease, unsafe marker or editor-lock artifact remains under the project.
The 251,637-byte PCB retains SHA-256
`0f7df58b79c3169b689b4f4ec230791cb414db4b6f981d3aa695221ed1aff531`.

This is **native workflow and placement qualification, not accepted routing or
board acceptance**. The verified V9 PCB contains no tracks, vias or zones.
Its older proposed copper remains historical under the user's requirement to
keep GPIO header gaps clear for soldering and rework. Full routing, native DRC,
plane/reference continuity and fabrication acceptance remain unfinished.

The initial **22 × 60 mm candidate packet** was [prepared and compiled
READY](../designs/rp2350-pico/candidate-60/README.md), with
separate [draft](../designs/rp2350-pico/candidate-60/candidate-draft.json),
[target poses](../designs/rp2350-pico/candidate-60/target-poses.json)
and source-model/local-entry proposals. It retains the circuit and two-layer
construction but revises placement and mechanical geometry. That planning
snapshot is historical; native candidate 60-03 above supersedes its placement.
Routing is still incomplete.

A new source-only header-service audit checks the full copper envelope of tracks,
vias, non-header pads and stored fill against the two protected header strips.
Only exact pad-specific inward leads are exempt; shared GND does not exempt
unrelated copper. Unsupported geometry and unfilled zones remain unknown.
An actual saved-V9 replay exposed two supported-source gaps: the explicit
false duplicate-pad jumper flag and KiCad's roundrect radius materialization.
The corrected helper reproduces the pinned KiCad 10.0.3 rounding rule, checked
against a read-only native PAD oracle; odd and near-circle cases without
qualified geometry remain unknown. The unchanged unrouted V9 now returns clear
for this strip audit, with 40 actual header-pad UUIDs and zero unknowns. This does
not qualify routed copper or the new 60 mm placement. The final helper passed
152 relevant tests, source typechecking, isolated backend TypeScript compilation
and independent review. It is not yet a public tool or native clearance/return-
path acceptance.

## Earlier failure and recovery evidence

The earlier diagnostic run retained the missing SDK cause: **the native sync RPC
timed out**. Its default 30-second budget was separate from the outer client's
30-minute wait. The exact slow producer subphase is still unknown. An isolated
264-template render check took 0.406 seconds; it does not explain the live
timeout. The producer also performs synchronous IPC, ERC/connectivity checks and
native netlist export before writing footprints.

A reviewed host-only change gives just the fresh sync mutation RPC a fixed
120-second budget. Public arguments remain empty; all other RPC defaults,
startup, source/geometry guards, and uncertain-outcome recovery are unchanged.
111 relevant tests, source typechecking and independent review passed. This is a
bounded deadline adjustment, not proof that sync will complete or that a board
is correct. The timed-out run is archived under
`destination-verification/rp2350-native-sync-failure-04/`; exact-plan recovery
restored all eight normal-close file hashes and preserved the remaining captured
files/history. The frozen host build passes source/UI typechecks, backend
packaging and runtime checks. Session26 subsequently exercised the new budget
successfully for sync and placement, as recorded above.

Earlier native result, 18 September 2026: the separately frozen DOC11 host build
passes source/UI typechecks, backend packaging and complete runtime checks. The
preserved RP2350 project reopened under DOC11 and saved its outline. Real sync
then failed before a producer reply was retained; the sidecar session closed,
rollback failed and normal cleanup was not confirmed. The failed 6,896-byte PCB,
diagnostics and receipts are preserved. The owned orphan editor was stopped after
its process identity was checked. Seven non-PCB normal-close file hashes still
match. A reviewed retained-lock rollback subsequently restored the exact earlier
PCB and retired only the two proven orphan editor locks, terminal marker and
lease. Separate readback verified all eight normal-close hashes and preservation
of the other captured files/history. Normal native resume was still required
at that point.
No electrical footprint placement or copper was accepted from the failed run.

The host's generic SDK-error wrapper discarded the original cause. The reviewed
fix now retains it privately before teardown, with the same public message,
timeouts and quarantine behavior. Eight focused tests and source typechecking
pass. This repairs future diagnostics; it cannot recover the missing cause or
establish why the DOC11 sync failed. Complete DOC11 runtime verification also
passed after the failure. Evidence is retained outside the repository under
`destination-verification/integration-doc11-29/` and
`destination-verification/rp2350-native-sync-failure-03/`.

Repeated stock-library terminal-geometry parsing is now cached as immutable
derived data under exact source/policy identities, with a 64-entry/4 MiB bound.
All three guarded source reads and hash checks still run on every request. An
installed-library probe made six requests with two parses and eighteen full
reads; 201 targeted tests passed with five skips, and source typechecking passed.
This reduces parser work, not verification. It is not a diagnosis or cure of the
separate sync failure. Combining the reviewed source changes in a frozen host
was the next step at that point.

The new [placement study](../designs/rp2350-pico/placement-rework-study/README.md)
reconsiders the circuit groups before rerouting. Preferred study B moves the
external converter near USB/VSYS and gives the MCU's right-side launch area more
room. It introduces no pad, courtyard or service-band conflicts in the scoped
placement check. Four corner-hole conflicts and four existing USB pad-to-NPTH
source-clearance findings remain. Neither study is adopted, routed or natively
qualified; the previous V9 copper remains historical.

Latest user constraint: **keep unrelated copper out from between the external
GPIO-header pads on both sides, with clean inward connections and room for
soldering/rework. Keep two layers for now.** V9 contains between-pad vias and
ground copper and is therefore historical under the new intent. The specific
service margin and exit corridors are still being checked against the mounting
holes; minimum DRC clearance alone is not the requested durability objective.

The next real sync passed the mounting-feature precondition but exposed a
producer rotation defect: C10 and six other footprints had rotated roots with
unrotated absolute child-pad angles. All 66 footprints and 281 physical members
were present. The physical comparison correctly rejected the result. The failed
output is archived; a separately reviewed PCB-only rollback restored the older
checkpoint, with all eight prior close hashes matching. No native placement or
copper is accepted from that failed sync.

The new DOC11 producer overlay and host capability gate are independently
reviewed. The correction passed 20 isolated native rotation cases and 264
template cases; the host gate passed 47 selected tests. Legacy identity-only
producers can still serve unrelated operations but cannot perform sync under
the new host. The separate DOC11 runtime/profile now passes complete source
verification, installed descriptor capture and both production profile readers.
The integrated host build subsequently passed; the first real public
synchronization attempt failed as described above. Session26 later completed
the sync, placement, readback and close milestone.
Existing DOC10 and earlier evidence are preserved. The immutable overlay manifest
records its earlier source-only qualification; later runtime evidence is retained
under `destination-verification/doc11-runtime-publication-01/` outside the repository.

Earlier continuation, 18 September 2026: **the pre-sync board-feature guard had
been fixed in source; native qualification was then pending.** After successful
disk-full recovery and normal reopen, V9 saved its 22 x 51 mm outline. Sync then
rejected that valid outlined preimage before calling native electrical sync:
the old mounting-feature guard accepted only the exact prepared constructor.
The native session restored its exact outlined preimage, then entered terminal
review. Close retained the lease and unsafe marker; the owned native editor
exited and the client was subsequently stopped. The connected schematic is
unchanged. No electrical footprints, mounting features or placement were added.

The three-file fix admits only the canonical prepared board plus the exact
contract-sized native outline. It preserves outline UUID/style and all other
source forms, verifies checkpoint bytes before classifying a resumed pre-sync
board, and retains strict feature/library/UUID checks after materialization.
Two focused suites passed 52 tests; the final strengthened deletion regression,
source typecheck and independent review also passed. Frozen build13 (build12
plus exactly those three reviewed files) passed source/UI typechecks, build and
DOC9/DOC10 verification. A separate reviewed recovery archived the failed sync
state and rolled only its saved outline back to the older checkpoint PCB. All
eight prior close hashes match again; the exact terminal marker and lease were
retired after verification. That next run exposed the producer defect described
above; the pre-sync guard fix itself was exercised successfully.
Evidence is retained under
`destination-verification/rp2350-native-sync-failure-01/` outside the repository.

Earlier, a separate offline-router JDK extraction exhausted C: during a V9
outline operation. The previously empty PCB became zero bytes; the connected
schematic, project settings, rules, library tables, bundle and prior checkpoint
remained unchanged. A reviewed offline recovery archived the failed state and
restored only the exact checkpoint PCB. A separate readback confirmed all eight
last normal-close hashes and preservation of the other captured files.
The client could not retain its response or terminal record. The host exited,
but its PCB editor remained running. An earlier absence claim was incorrect:
mixed PowerShell table output was ambiguous. Fresh structured process inspection
identified the exact orphaned editor, which was then terminated after checking
its executable, project argument and creation time. This discarded the failed
outline's in-memory state; it was not a normal save or close. The offline utility
then archived and released the exact reviewed orphan locks, with the lease
last. The checkpoint, history, rules and schematic were not rewritten. The
outline was attempted again only after exact restoration and normal native
resume, not as a blind retry of an uncertain operation.
The failure observation is retained under
`destination-verification/rp2350-native-disk-full-01/` outside the repository.
The original observation and its explicit correction are both preserved there.
The intact [connected schematic and native preview](../designs/rp2350-pico/schematic-v9/README.md)
are also published separately as a stable schematic milestone.
See [the scoped recovery procedure](toolbox-offline-recovery.md) for its limits.

Before this failure, **the complete RP2350 schematic was confirmed through
public native readback and normal checkpoint/close.** V9
project `d9435dc1-27b9-4fff-8af6-f6a2cfe897e8` has 67 functional nets, 260
endpoints, two intended NCs, 62 physical components and six power flags matching
the bound circuit and checked presentation. Its PCB was the empty baseline;
PCB placement, routing and design acceptance are unfinished.

The connectivity call exceeded the client's ten-minute observation window.
The host continued, and its queued current-state check subsequently reported no
recovery requirement. Fresh public graph/symbol reads matched the contract;
normal workspace close then published a checkpoint and released the lease.
Eight source/bundle/checkpoint files are pinned in the retained close evidence,
with no project lease, unsafe marker or lock remaining at that close. The original
mutation response is unavailable; this milestone relies on the later observed
state and confirmed lifecycle, not an invented successful response.

The operator client now supports a bounded `--call-timeout-ms` override
(30000–1800000, default 600000). This changes observation time only; native
admission, source checks, recovery deadlines and no-retry behavior remain intact.

Earlier same-day attempts remain preserved. V7 project
`3666e11a-44e9-4387-b30d-6465aaca2d9a` saved and
verified 34 schematic symbol-pose updates and 73 field-position updates through
the public toolbox. Both operations preserved the native netlist; their final
unwired source matches the independently checked presentation exactly.

Connectivity authoring then stopped on the first power flag's generic
center-distance proximity warning. The host restored the exact pre-edit source
(`66c853e18c48c1b83077a8f3bedb02da0572e3c2737715301d2ea5b7d321fd99`).
Finalization did not publish a checkpoint or release the project lease; the
project remains quarantined for review. No retry or manual lease/marker cleanup
was performed. Its PCB still has no outline, footprints or copper.

A subsequent V8 attempt in project `d14efc74-96ef-4e9c-bd29-2dd83de34e2e`
passed that reply qualification and authored the schematic source. The public
mutation-status schema then rejected the new advisory field before mandatory
save/readback. That authored source is preserved as diagnostic evidence; this
second project also retained its lease without a successful checkpoint. The
strict public-schema integration is being corrected with wrapper-level tests.
Neither failed project is a healthy seed or an accepted native board.

Independent native checks of the preserved V8 artifact match 67 functional nets,
260 endpoints, two intended NCs, all six flags and 62 physical components. Its
255 wires, 246 labels, pin geometry and rendered glyphs match the checked plan;
configured ERC reports zero violations. These are artifact facts and do not
replace the missing managed save, checkpoint or lease release.

The separate complete schematic diagnostic has 246 labels, six power flags,
255 wires, 67 functional nets/260 endpoints and two intentional NCs. Native
glyph, field, worksheet and configured ERC checks pass; the unchanged ignored
ERC categories remain recorded in the diagnostic. This is preflight evidence,
not a successful managed connectivity operation. See the
[released schematic plan](../designs/rp2350-pico/schematic-layout.md).

The reviewed PCB proposal has 858 trace segments and 101 vias, with 55
non-ground nets connected in its source model and 11 routes still open. Native
placement, routing, filled-ground and complete-board DRC remain pending. The V9 draft
declares a 22 × 51 mm board, 143 total via reservations, mixed-layer GND access
and the same 0.55/0.20 mm vias with 0.50 mm hole spacing; these declarations are
not authored copper or design acceptance. Current work is on
`codex/rp2350-pico`; GitHub's `main` still contains the older application.

Earlier same-day continuation: **all 62 RP2350 component instances are
saved in a normally closed native schematic; connectivity and PCB layout remain
unfinished.** The PCB is still its empty baseline. RP2350 work is maintained on
`codex/rp2350-pico`. This source snapshot adds corrected schematic geometry and
label layout, preserving footprint batches, scoped runtime migration and
unwired schematic revisions with bounded board-dimension/mechanical-pose changes.

Independent KiCad exports exposed incorrect quarter-turn pin transforms in the
old host/runtime and incorrect vertical global-label framing. Corrected source
and a separate DOC10 runtime now agree with the native geometry fixtures.
DOC10 profile `-01` failed native-profile admission because its relocated
launcher retained the old argument hash; preserved `-02` corrects that derived
hash and passes both real profile readers. The new DOC10 project now completes
native import, save, checkpoint and normal close, with the exact 62-symbol
schematic retained and all ten pinned source artifacts unchanged. Public reopen
also preserves all seven target source/bundle artifacts, observes the corrected
pins and completes normal close. The existing DOC9 project and first failed,
unallocated import are preserved; no old native acceptance evidence is transferred.

The separate native 21-to-22 mm seed target
`6af3e9dd-2be7-41f7-8e00-ac06cde791c6` now completes creation/open and normal
close on build03/session15. Its [creation snapshot](../../destination-verification/rp2350-native-22-seed-02/REPORT.md)
and [post-close verification](../../destination-verification/rp2350-native-22-seed-02/post-close-verification.json)
retain all seven project/bundle files unchanged, with no lease, unsafe markers
or locks after close. The exact 62-symbol unwired schematic remains; the PCB has
no outline, footprints or copper. Reopen of this 22 mm target remains unproven.

The closed 22 × 51 mm candidate declares 137 via reservations, four mounting
features and 0.55/0.20 mm vias with a 0.15 mm minimum annular ring. Native
hole-to-hole spacing is 0.50 mm; copper-to-hole clearance is separately 0.25 mm.
These are bound policies, not authored PCB geometry or electrical acceptance.
[Explicit mixed-layer plane access](toolbox-plane-access-layers.md) has software
coverage; qualification on the actual board remains pending. The physical
proposal retains straight/45-degree copper, actual pad/paste geometry, local
supply bypasses and explicit return paths. Partial routing screens and targeted
native rule controls do not establish complete-board DRC or acceptance.

The snapshots below retain their historical scope.

Latest continuation, 17 September 2026: **the reviewed baseline is published to
`codex/destination-resume`; RP2350 circuit and toolbox progress is on `codex/rp2350-pico`.**
The 62-part RP2350 candidate now compiles and has U1/J2 observed through public
native schematic reads, with normal checkpoint/close. The independent
[whole-placement screen](rp2350-placement-verification.md) clears the corrected
USB/mounting geometry and qualifies reference-field cleanup. It is separate from
the unfinished MCP project, whose PCB has no components or copper yet.
[Candidate status](../designs/rp2350-pico/candidate-readiness.md) separates
these results from the older connector fixtures below. Via-clearance DRC has
[targeted native qualification](via-clearance-qualification.md).
Subsequent joint routing found a QSPI escape obstruction and corrected the USBLC6
model to retain six native signal nets across its manufacturer-described internal
transfers. The earlier four-net 38-segment USB native diagnostic remains preserved;
it has zero USB unconnected items but is superseded as the final circuit model.
Placement and power/return routing are being revised together before allocating
another full native candidate. The complete RP2350 board remains unfinished.
DOC9 passes native USB-C field placement; attempt05 now passes import, complete
physical PAD observation and preserving movement. Its checkpoint failed on a
stock footprint drawing layer; the reader fix passes offline, while the failed
session remains retained and successful native finalization is still unverified.
Read [RP2350 progress](rp2350-progress.md) for the current result and next step.
The detailed snapshots below retain their historical scope.

Evidence snapshot: **DOC7 profile02 and the exact updated PCB skill are installed; native10 completed V2 regulator authoring, strict public DRC/parity checks, normal close and fresh read-only reopen.** The installed command passed four read-only preflight calls, and a fresh actual CLI process discovered all 15 initial tools with exit 0. Activation of the new profile in the running desktop remains unverified; earlier DOC6 desktop discovery is historical. Native10 remains unaccepted: 9 passed/38 unknown/0 failed edit-session rows, then 47 unknown rows without a new fill witness on read-only reopen. Start with the checked-in [WSON regulator proof](../examples/wson-regulator-toolbox-proof/README.md) and [installation record](destination-client-installation.md). Earlier failed runs and the historical failed full suite remain unchanged.

## The short answer

**Native10 now completes V2 external-power authoring, NC-correct import, six preserving placements, routing, strict public DRC/parity zero and normal close.** Its [saved candidate](../../destination-ic-design-10/authored-source-01/manifest.json) has nineteen physical primitives/seventeen logical terminals, eighteen tracks, six vias and one B.Cu GND zone; all three functional nets are connected. Generic validation and ten measured straight/45-degree junctions have no findings in their reported scope, and native top/assembly views were readable. Scoped thermal/clearance checks are verified and all ten bores are inventoried. The public plane result remains **incomplete: 9 passed, 38 unknown, 0 failed; accepted=false**. Two connector bore/cached-hole relationships, actual physical widths/contact continuity, ignored ERC checks and other mandatory rows remain unresolved.

The [initial post-close observation](../../destination-ic-design-10/post-close-observation.json) and [06:09:20 UTC read-only post-close observation](../../destination-ic-design-10/post-readonly-close-observation.json) confirm both normal closes with six sources unchanged and no lease, unsafe marker, locks or native processes; both operator clients exited 0. Fresh read-only reopen preserved the bundle, repeated all three connected functional nets and the exact top PNG. Its plane result correctly has **47 unknown rows, accepted=false**, without a new current-session fill witness; it does not inherit the edit-session passes. The V2 reader correction has separate [95-test lifecycle](../../destination-verification/native-nc-compatibility-01/reader-nc-lifecycle-recheck-20260916-02.json), [46-test final netclass](../../destination-verification/native-nc-compatibility-01/reader-nc-partial-inventory-20260916-03.json), [actual09 offline replay](../../destination-verification/native-nc-compatibility-01/native09-semantic-reader-offline-03.json), full [typecheck03](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-03.log) and [build03](../../destination-verification/native-nc-compatibility-01/integrated-build-03.log) evidence. Named-NC netclass/checkpoint support is V2 only; V1 readers remain fail-closed. [Attempt08's route/cleanup failure](../../destination-ic-design-08/assessment.md) and [attempt09's reader/close failure](../../destination-ic-design-09/assessment.md) remain preserved. [DOC7 profile02 and the exact updated skill are now installed](destination-client-installation.md), with 15-tool preflight/fresh-CLI verification. Activation of the new profile in the running desktop remains unverified. See [current native scope](toolbox-external-power.md#native-attempt10-and-remaining-limits).

**The completed DOC8 attempt07 authored and reopened a routed native candidate; its strict plane assessment remains failed.** [Attempt07's assessment](../../destination-ic-design-07/assessment.md) records six footprints, nineteen physical pad primitives, eighteen tracks, six vias and one B.Cu GND zone after six successful preserving placements. All three declared nets and every eligible physical member are reachable. Generic configured ERC/DRC, unconnected and courtyard counts were zero; the later strict native check found an NC schematic-parity conflict, so those zeros do not establish complete ERC/DRC cleanliness. Ten measured straight/45-degree junctions have no violations or unresolved findings; four ERC and five DRC categories remain ignored. A fresh 37-tool read-only session repeated inventory/endpoints and the exact top PNG. [Attempt05's metadata loss](../../destination-ic-design-05/assessment.md), [attempt06's ordering-only failure](../../destination-ic-design-06/assessment.md), and the corrected planner's [72/72 file roundtrips](../../footprint-placement-order-qualification-20260916/run-02/manifest.json) remain distinct evidence.

The first attempt07 public plane assessment failed on two stale Windows dependency paths. A [separate exact dependency repin](../../destination-verification/plane-system-dependency-repin-20260916/README.md) qualified the production reader without changing its runtime closure or validator. After reopening the same project and reapplying/saving GROUND, public assessment returned **8 passed, 3 failed and 36 unknown rows**. Strict parity finds one U1 pad 5 `net_conflict`; preserved stock exposed-pad heatsink/`zone_connect 2` fields trigger unsupported source/thermal handling and incomplete drill inventory. Ordinary copper violations and unconnected items remain zero. All three sessions closed normally with exit 0, six source files unchanged and no retained lease or unsafe marker. `accepted` and `fabricationAuthorized` remain false. At that historical attempt07 boundary, DOC8 migration was deferred and DOC6 remained installed. The current installation is DOC7 profile02, as recorded above. The [external-power guide](toolbox-external-power.md#routed-native-candidate-and-remaining-limits) retains the failed rows, ignored categories and remaining limits.

Historical DOC6 catalog qualification: **The toolbox now searches approved stock libraries and carries a source-bound RC fixture through native authoring, placement, previews, normal close and same-connection resume.** [Catalog native02](toolbox-stock-catalog.md#passing-native02-lifecycle) passed 33 calls, preserving six project sources and six selected library records. Its seven-pad C1/R1/J1 board intentionally has no tracks, vias or zones; all three PCB nets remain disconnected. The global catalog profile02 and updated skill are installed, and the installed CLI sees 15 tools; the running desktop now exposes the initial tools, while native attachment and tool-refresh verification remain separate. J1's retained `DIVIDER_IO` assembly value extends outside the outline, so this is not a polished or electrically approved board.

**The toolbox now authors a native differential-pair fixture, checks its complete saved geometry, calculates a conditional section impedance and reopens the checkpoint read-only.** [Native attempt04](destination-interface-qualification.md#native-attempt04-authored-pair-and-read-only-reopen) passed 46 scripted public operations: 0.4 mm traces, 0.3 mm central gap, zero etch-length skew and a 13.7 mm paired section calculated at 89.54317399767152 Ω against a synthetic 90 ± 10 Ω target. Overall impedance and board/interface acceptance remain unassessed or false because physical reference, finite-thickness, bends/launches and other requirements are still open. Desktop activation and fully autonomous prompt-driven design are separate milestones.

The [native project](../../destination-interface-native-04/output/project/interface-pair-software-fixture.kicad_pro), [top preview](../../destination-interface-native-04/evidence/fresh-top.png) and [assembly preview](../../destination-interface-native-04/evidence/fresh-assembly.png) are available. Both sessions closed/checkpointed normally; the six saved project sources and bound requirements persisted. The [corrected independent audit](../../destination-interface-native-04/evidence/audit.corrected.md) passes all 68 required checks while preserving the initial timestamp-sensitive SVG audit and every earlier failed native attempt.

The [stock-catalog evidence](toolbox-stock-catalog.md) preserves public03 discovery/ready compilation, scoped software passes and the earlier native01 create failure with its unconfirmed bridge/host cleanup and retained lease. Native02 uses the separately pinned bounded connection policy. Approval of 222 symbol/155 footprint namespaces does not qualify their contents; discovered RP2350 symbols remain uninspected candidates, and representative QFN/native engineering coverage remains open.

**DOC6 native authoring now preserves all three full footprint IDs, with eight tracks/one via, all-net endpoint reachability and zero strict DRC/parity findings.** Scoped clearance and thermal policy are verified; ERC remains unsupported with four ignored checks. Fresh05 still failed its old minimum-area assertion because the actual result was unknown, then finalized normally with a checkpoint. The separate eight-operation read-only reopen passed without inventing a fresh fill witness. See [the retained results](destination-plane-acceptance.md#doc6-routed-authoring05-and-separate-read-only-qualification).

**The toolbox now supports a destination-verified V2 workspace flow: discover and clarify a plane draft in chat, create by ready ID, author/synchronize/place it, close it, and resume it on the same connection or in a new read-only process.** The new 29-operation and 11-operation native reports establish that lifecycle; earlier 1.04/1.22-second source-machine connection timings remain separate historical evidence.

The destination workspace board is **intentionally unrouted: three placed components, seven physical/logical terminals, and zero tracks, vias or zones**. All three nets correctly report disconnected. It proves workspace lifecycle, saved-state inspection and previews; the transferred eight-track/one-via COMPLETE-ALL-NETS board remains separate. The saved-stackup reader continues to report missing construction rather than inventing dielectric values.

The analytical four-model transmission-line calculator remains usable. The public saved-reference tool has exercised three native copied-board cases: **SIG_CLEAR covered, SIG_VOID uncovered, SIG_TANGENT boundary_uncertain**, through linked InMemoryTransport, not STDIO or app installation. Isolated native attempt3 separately proved clear-cache/refill/capture controls. The latest DOC5 proof combines source-bound plane mutation/refill/save/reopen with public native endpoint reachability; **intended-plane contact, thermal, island, reference eligibility, HF, pair and board-impedance acceptance remain open**.

The next gates are the installed client's native attachment/tool-refresh behavior, reference-plane/pair/stackup engineering binding, representative QFN native coverage, and GitHub handoff. The requested RP2350 Pico-like, Orpheus-inspired board remains **after the reviewed baseline push**. No overall ETA, completion percentage, manufacturing claim, or Astra head-to-head superiority claim is made.

**The direct V2 plane workflow has a passing [COMPLETE-ALL-NETS demonstration](../../proof/EvlEDA-toolbox-plane-complete-20260909-01/final-assessment.json) on DOC5/profile07.** It authored/synchronized three components, routed eight tracks and one via, and verified VIN, GND and VOUT physical-pad reachability before and after read-only reopen. Configured ERC/DRC and measured turn checks were clean. The earlier three-track proof deliberately left VOUT unrouted; that historical limitation no longer describes the latest fixture. This remains a small tool demonstration, not general PCB or manufacturing approval.

The historical [full software verification03](D:/EvlEDA-verification-plane-apply-20260909-03/report.md) passed **4,425 tests / 52 skipped / zero failed**, before final public endpoint wiring. The [first destination full suite](../../destination-verification/full-suite-01.json) remains **failed: 4,356 passed / 68 failed / 53 skipped**, plus two unhandled deadline errors. Later focused repairs and the 92-test MCP run passed separately; source/UI typechecks and full build passed. No clean current full-suite result is claimed. See [destination verification](destination-verification.md) for the retained failures and exact scopes.

## What the toolbox provides now

| Surface | Implemented/tested boundary | Remaining limitation |
| --- | --- | --- |
| Guidance-only MCP | The mcp:toolbox entrypoint serves status, topics, complete paginated rule records, complete guides and 17 guide resources from the verified corpus. | It does not open KiCad, select a project or enable editing. |
| Packaged workflow skill | The exact current [repository skill](../skills/evleda-pcb/SKILL.md) is installed with DOC7 profile02; **1,773 guidance records / 17 dossiers** remain available. | Installation is an explicit host action. Guidance records are not 1,773 executable or completed checks. |
| Native MCP | The separate mcp:toolbox:native entrypoint binds explicit host profile/project authority, copied or fresh preparation, native CAD operations and guarded resume/finish. | Real stdio operation is tested; deployment in the user's chosen chat application is still a separate gate. Host configuration—not a model tool call—enables editing. |
| In-chat workspace mode | Native10 exercises V2 authoring, named-NC import, six placements, eighteen tracks/six vias/one plane, strict public parity, normal close and fresh read-only reopen over real STDIO, preserving six sources. | The older three-component workspace fixture was intentionally unrouted; it is historical evidence. One native project is active per connection. New DOC7 desktop activation/tool refresh remains unverified; V1 named-NC lifecycle is unsupported. |
| Direct V2 plane family | Native10 on DOC7/profile02 verifies source-bound authoring, saved copper, all three functional nets, strict public DRC/parity zero, complete ten-bore inventory and read-only reopen. Earlier DOC5 eight-track/one-via and source-equivalent CREATE/UPDATE proofs retain their scopes. | Edit assessment is incomplete at 9 passed/38 unknown/0 failed; read-only assessment has 47 unknown rows without fresh fill. Bore/cached-hole relationships, physical widths/contact continuity, ignored ERC coverage and whole acceptance remain unresolved. |
| Native endpoint connectivity | `evleda_check_endpoint_connectivity` queries each physical terminal member from the bound saved V2 project; the complete proof observes VOUT disconnected before routing, then all nets connected in fresh and resumed sessions. | A compact public report and immutable private diagnostic preserve evidence separately. Reachability does not establish intended-plane contact, fill freshness, absence of cross-net shorts, thermal behavior or HF suitability. |
| V2 plane evidence | Native10 records verified scoped thermal/clearance checks, all nineteen pad features and ten bores. Its public report contains 9 passed/38 unknown/0 failed rows; the separate read-only report contains 47 unknown rows. Historical DOC6 routed05 and its failed assertions remain preserved. | Two GND connector bore/cached-hole relationships leave topology/area/contact questions unresolved. Actual copper/thermal widths are unmeasured, four ERC categories remain ignored, and `accepted`/`fabricationAuthorized` remain false. No clean current full-suite claim. |
| Literal PCB text | Three fresh11 VIN/VOUT/GND front-silkscreen insertions passed mandatory native save/readback and exact source-preservation checks. | This is a bounded literal-text operation, not arbitrary PCB source editing or automatic full-text-clearance/layout approval. |
| Native visual feedback | Final fresh11 real-stdio top/assembly PNGs and native SVG resource bytes matched their returned identities. The board remained unchanged during collection. | Images are source-bound engineering snapshots, not an aggregate acceptance result. Remaining presentation defects are visible rather than cropped away. |
| Analytical line calculation | Four uniform transmission-line models, analyze/synthesize, explicit units/material inputs, retained warnings and pinned helper identity; six real public-MCP calls passed. | Not a field solver, fabricator stackup, board extraction/checker, differential-pair router or manufactured impedance qualification. |
| Declared V2 interfaces | Native attempt04 passes authored pair creation, saved-source assessment, normal checkpoint/close and read-only reopen. The 46-operation fixture preserves six sources and bound requirements; the supported central interval meets its synthetic numerical target. | Scripted public InMemory MCP with a real native STDIO sidecar; desktop activation and autonomous prompt-driven design remain separate. Whole-route model/reference/physical limits keep overall impedance unassessed and board/interface acceptance false. |
| Saved single-microstrip route | `evleda_check_microstrip_route` derives saved width/length and adjacent construction for an explicit target. The real saved-file wrapper/native helper now verifies within/outside-target outcomes and zero-dispatch mask refusals on a software fixture; prior MCP/typecheck/build evidence stays separate. | Materials remain caller-asserted. Reference freshness/coverage, physical DC, finite-width contacts and accuracy remain separate; CAD-authored-board/full native-host qualification and complete interface acceptance are pending. |
| Saved physical stackup | The bound saved-board reader retains ordered layers/sublayers, explicit and missing material/thickness/permittivity/loss fields, unknown forms, source identity and observation limits. | General thickness is not dielectric height; copper-layer presence is not a reference plane. Native missing-stackup output is truthful, and impedance validation is not performed. |
| Saved reference-copper coverage | The public tool completed native copied-host cases: SIG_CLEAR covered, SIG_VOID uncovered, SIG_TANGENT boundary_uncertain, with verified raw-resource hashes. | Linked InMemoryTransport—not STDIO/app setup. The standalone saved-geometry result is not fill freshness, DC/HF/reference/margin or impedance approval; the separate DOC5 authoring proof does not convert it into electrical acceptance. |
| Checks and recovery | Native ERC/DRC, board summary, visual QA, practice coverage, serialized mutation/save/readback and explicit native finish/checkpoint. | Individual findings and missing inputs remain authoritative. The toolbox does not invent a global manufacture-ready verdict. |

The older Flux application, UI, CLI runner and infrastructure are **deferred for the active path, not deleted**. Proven native/session/library/source/rule components are reused without initializing the older application/provider lifecycle. Private source/snapshot/commit plumbing and arbitrary rebinding are not exposed to model requests.

## Latest plane-tool behavior

[Proof02](../../destination-plane-acceptance-02/evidence-plane-acceptance-01/result.json) passed its 49-operation driver while the actual plane assessment remained failed. Route edits and read-only reopening removed current fill authority; reapply/save restored assessment capability without hiding the three footprint parity warnings or uncovered VIN reference. The original native-graph plane-net pass remains historical; current code requires global drill-clipped terminal continuity before that row can pass.

The [DOC6 repair and proof03 record](destination-plane-acceptance.md#doc6-offline-qualification-and-preserved-startup-history) separate 12 offline sync tests from proof03's failed startup and probe04's later bridge-revalidation failure, both before public authoring. Common outline/via/trace numerical checks and the source-bound ERC row/public coverage are now wired and software-tested. Unexcluded ERC violations fail; default ignored checks or other incomplete coverage leave the row unknown, without silently changing policy. No new native ERC run is claimed. Protocol 4 now supports explicit absent cover for both single and coupled microstrip. Protocol 2/3 retain their original supported inputs; none establishes board impedance qualification.

The [runtime scheduler comparison](../../destination-verification/runtime-scheduler-benchmark-01/result.json) observed **18.56 seconds → 15.38 seconds** for factory-plus-current verification on the same DOC6 identity and unchanged checks/30-second bound. Old-first/new-second ordering leaves a warm-cache confound; source-code hashes were recorded only afterward. [Startup05](../../destination-startup-doc6-05/result.json) reached ordinary native status/catalog at 11:51:19 UTC with 40 public tools, then failed blank-project checkpointing with `Live PCB differs from saved source`. The five tracked sources other than the project file, including the 371-byte PCB, were unchanged; only the project file normalized during closure. No editor/Python process remained, but no complete lifecycle, checkpoint or native DOC6 writer pass follows. [Native blank-board observations](../../destination-blank-open-observation-01/result.json) led to the repair now qualified by [proof07](../../destination-startup-doc6-07/result.json) and its [52-check audit](../../destination-verification/blank-lifecycle-07-audit.json). All seven observed sources, including the native history file, stay unchanged from startup return through close/reopen; all six checkpoint sources match. Initial Save had already normalized the project file and created that exact history snapshot before the first comparison. The PCB seed remains 1,814 bytes. Resumed sessions do not repeat the initial Save, and no serializer, checkpoint or DRU policy was waived. The subsequent [routed05/read-only evidence](destination-plane-acceptance.md#doc6-routed-authoring05-and-separate-read-only-qualification) now qualifies saved full-ID authoring; its fresh driver remains failed on an obsolete area expectation, and broader acceptance remains incomplete.

The completed [same-board fresh reassessment](../../destination-verification/doc6-plane-reassessment-01/result.json) retains all four bores and **9 passed / 1 failed / 27 unknown rows**: VIN's known pad bore fails reference coverage; GND topology/area and physical contact limits remain unknown. Its driver later failed raw footprint equality. A [separate 10-geometry/58-evidence audit](../../destination-verification/doc6-plane-reassessment-01/audit.json) proves exactly seven R1 `-90 → 270` angle spellings changed, with all other PCB bytes and track/via data unchanged. Cleanup and the current six-file checkpoint are confirmed; no after-assessment snapshot was captured, so no measured across-close equality or rewritten driver pass is claimed. No reroute or new board was used.

## Destination V2 workspace milestone

The [29-operation native report](../../destination-verification/workspace-v2-05/workspace-proof-33a3a1cc-b2ae-4b86-b1e3-3747953df78f/report.json) verifies V2 discovery/clarification, ready-ID create and retry, three-symbol authoring, seven-terminal sync, outline/placement, disconnected endpoint inspection, close/checkpoint and same-connection resume. The [11-operation fresh-process read-only report](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/report.json) resumes the persisted ID, reads endpoints/stackup, captures native PNG/SVG previews and closes cleanly. Their SHA-256 identities are **15e5051048166d5ebf76a06c2dd77d4685e66655efaa266bdc7ff1f52012c8c4** and **b13e0495886c97f29bd23d34223ebabd6af8316c408d227144fa637c8afb46e7**.

The [native project](../../destination-workspace-v2-05/projects/4b225d42-538a-4b84-b332-4fc3a61d0e4d/output/project/workspace-plane-divider.kicad_pro) retains all six authored source identities across both reports and disk. Three closes completed without a remaining successful-project lease, lock or editor. The [top](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/restart-top.png) and [assembly](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/restart-assembly.png) previews were visually inspected. **Zero tracks/vias/zones and disconnected nets are intentional here**; neither clean lifecycle nor visual transport is circuit acceptance.

[Destination setup](destination-setup.md) records the Windows AppData initialization repair and short pinned DOC5 working runtime. Ownership, hash checks, warning checks and production deadlines remain enforced. All four failed native attempts and their retained state remain distinct in [destination verification](destination-verification.md#open-verification-issues); the successful fifth run does not rewrite them.

## New workspace onboarding and restart evidence

The [workspace mode](toolbox.md#in-chat-workspace-mode) no longer requires per-board paths, draft filenames or prompts in the startup command. The host supplies one approved profile/pin and disjoint workspace. The model submits the complete structured draft, name and original request over MCP; unresolved or unsupported requirements are returned before project allocation. A ready submission receives an opaque identity, and creation rechecks it. Retries return the existing allocation rather than creating duplicates.

Workspace discovery now exposes both `routed-v1` and `plane-v2` through `evleda_design_schema`. Its optional `family` defaults to `routed-v1`; the result returns the selected `family`, `supportedFamilies`, complete schema, model guide and example. A `plane-v2` request describes the bounded rectangular ground-plane family. `evleda_submit_design` dispatches by the draft's exact schema version, and ready V2 IDs follow the normal create/retry/resume lifecycle with the authenticated V2 bundle and six-file rules. **32 workspace and V1/V2 model-guide tests plus source TypeScript checking passed**, with clean independent source review. The destination native reports below now verify V2 workspace execution; the older source-machine reports retain their original scope.

- [Idle proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-bf795c02-f9bb-4db9-aae6-405e5b3ca058/report.json): 1.04-second connection, schema and approved-library inspection, missing-width clarification and ready submission, **no KiCad/editor and no project allocation**. That timing is idle connection, not native project creation time.
- [Native workspace proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-0b63406c-16a6-4cc9-96bf-0236c2660d25/report.json): create, creation retry, refreshed CAD discovery, three symbols, connectivity, field placement, PCB sync, pad/stackup reads, close/checkpoint/detach, then resume and close on the same connection. Exactly one allocation remains: **57d18615-fb17-4871-a71b-5e37acd9a413** under D:/EvlEDA-workspace-onboarding-20260909-01/projects.
- [New-server restart proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-2feed16c-f0f2-4fd0-9fca-27309121dd0e/report.json): 1.22-second connection, list the persisted ID, resume without another draft, read pads/stackup and close. Owned project lease files and the PCB editor were absent afterward.

These results establish onboarding and authored resume, **not a new routed board or complete-board acceptance**. Native11's older routed/labeled proof is not silently attributed to this project. Listing a project is also not checkpoint validation: resume retains source/bundle/native checks, and uncertain allocations remain subject to host review.

Historical DOC6 client evidence: The SDK and real-stdio tests rediscovered tools after attachment/detachment; the desktop still needs its own test. The [global catalog profile02 and updated skill are installed](destination-client-installation.md), and Codex CLI app-server discovers 15 tools from that real entry. Desktop activation remains unverified. [Client setup](toolbox-client-setup.md) remains separate from the disabled [workspace example](../examples/toolbox-workspace.config.toml). Guidance, calculator access and immutable historical preview resources remain independent of the current CAD binding; stale callbacks must not switch to another project.

## Latest direct-native V2 complete-all-nets milestone

The included [final assessment](../../proof/EvlEDA-toolbox-plane-complete-20260909-01/final-assessment.json) and [public-tool result](../../proof/EvlEDA-toolbox-plane-complete-20260909-01/evidence-plane-complete-01/result.json) supersede the partial-routing status below. Public MCP calls used linked InMemoryTransport with a real DOC5 native sidecar over STDIO. After author/sync, placement, VIN/GND routing and plane application, the endpoint tool reported VOUT disconnected. Routing VOUT and reapplying the plane produced **eight tracks / one via** and connected VIN/GND/VOUT, with every eligible physical member reachable. Fresh and read-only resumed phases both returned configured **ERC 0 / DRC 0 / unconnected 0 / courtyard issues 0**, no measured turn violations or unresolved turn findings, and normal finish/checkpoint without recovery.

All six authored sources stayed unchanged through reopen. The final PCB is **19,201 bytes**, SHA-256 **062804a7545278eef20b38cf09eb79c96d39f38f7dbab7d0452840aa225bce9e**. The result is **997,778 bytes**, SHA-256 **923217ce4b3deb1cefc94534ad731a7e2fe6d5c79510728c6fbdd516a48dac91**. Source/result/PCB and eight preview hashes were checked after transfer; the original native execution occurred on the source computer. The recorded visual review found R2's reference clear of the ground route. Top previews omit B.Cu and do not show the bottom plane fill.

The public [endpoint tool](toolbox.md#saved-native-endpoint-connectivity) accepts an empty request. The host binds saved/live source, marker, scope, library and individual PAD observations, refusing pending or uncertain mutations. Its report uses `evleda.toolbox-endpoint-connectivity.v1`, with assessment schema `evleda.fresh-plane-connectivity.v1`; raw native request envelopes and paths remain in an immutable host-private diagnostic. No verification-plan row is promoted by this report.

The V2 practice analyzer remains profile-free (`analysis` and `reviewedProfileIdentity` are null); general width/via/profile checks remain unverified. The route writer separately enforces bound numerical geometry. Endpoint reachability and configured native checks do not establish intended-plane contact, fill freshness, single-plane-component/island policy, thermal applicability/spokes, absence of cross-net shorts, HF/impedance behavior, ampacity or manufacturing approval. Workspace V2 discovery and the destination native lifecycle are verified on a separate intentionally unrouted fixture.

### Historical V2 author/sync milestone

[The completed assessment](D:/EvlEDA-toolbox-plane-authoring-20260909/evidence-final/summary.json) records actual public-MCP schematic authoring, field repair, physical synchronization, save, normal close, then read-only resume of the **same authenticated V2 bundle** and normal close. All seven physical/logical terminals remained exact, including J1:3:GND and R2:2:GND. No ground endpoint was dropped because the PCB contract uses plane topology.

The plane FreshProject uses **V3 marker/checkpoint** semantics and tracks the canonical bundle-owned **.kicad_dru as a sixth file**. The existing five-file LED/routed formats remain unchanged. Netclass preparation keeps exact assignments and configuration; Open, source guards, checkpoints, close and resume enforce the owned rule identity. Resume also binds the current normalized host guidance-selection policy and rejects a changed policy before opening KiCad; it accepts no replacement draft/prompt.

The first driver retained a failed obsolete **padCount assertion after actual successful sync and clean finish**. That diagnostic and executed script remain intact. A separate assessment plus resume-only proof verifies the existing saved result—there was no new fresh-authoring rerun to hide the failure. The later driver correction passed **32 offline actual-payload/negative cases and focused script typechecking**; [its README](D:/EvlEDA-toolbox-plane-authoring-20260909/README.md) explicitly records that the corrected whole driver was not rerun natively. Owned processes/locks/recovery markers were absent after completion; older retained IPC allocations were unchanged.

Native read-only DRC parsed the canonical thermal DRU without a setup/parse error but reported **two layout violations (overlap/absent outline) and four unconnected items**. No zone exists in this fixture. Parsing rules for deterministic zone selection, minimum resolved spokes, gap and spoke width is not proof of applicability, override precedence, actual spokes, DC continuity or thermal/board acceptance. The saved checkpoint remains **needs_review**.

That earlier proof exposed copper authoring as unavailable. Current source instead reports session-specific **copperAuthoring.incrementalRoutes** and **copperAuthoring.contractPlane** booleans alongside advertised tools. These describe supported edit capabilities, not successful native operations or acceptance. Older runtimes may support routes without plane APPLY; arbitrary raw copper edits and V1 topology substitution are not authorized. Workspace V2 create/author/close/resume and read-only restart are now verified natively on the destination, using a separate intentionally unrouted fixture.

[The earlier stage](D:/EvlEDA-plane-runtime-stage-20260909/README.md) and its 23 offline tests remain historical. [DOC4](../sidecars/doc4-runtime.md) is now published as a new immutable runtime, with the stage03 omitted-number/paste-aperture correction covered by **28 tests**. The host incremental-route/APPLY/source/epoch/save/recovery implementation has **196 focused tests and 41 scoped review cases**, not native approval. Minimum spokes remains an external DRU/resolved-spoke requirement rather than an invented Zone field.

### Historical partial DOC5 plane-APPLY/save/reopen milestone

[Native proof03](D:/EvlEDA-toolbox-plane-apply-20260909-03/evidence-plane-apply-01/result.json) and its [final assessment](D:/EvlEDA-toolbox-plane-apply-20260909-03/final-assessment.json) record **a full pass within the partial-fixture scope**. Transport was actual public linked InMemory MCP with the actual native sidecar over STDIO, not a chosen-app installation or a model-driven PCB design.

- Authored/synchronized the V2 project, placed three footprints and created **three tracks / one via**: straight VIN and GND access with a **45-degree bend**.
- Created the contract plane, validated the source/copper/refill epoch and performed mandatory native save/readback; applied the same plane again and saved again. The update's saved bytes were actually identical. This verifies same-plane update handling, not arbitrary changed-geometry updates or permission to omit a save.
- Finished with native close and a published checkpoint; reopened the same authenticated bundle read-only, checked **all six owned source files plus zone/routes**, then finished cleanly again.
- Saved PCB: **18,458 bytes**, SHA-256 **0ed02745a5c1c47f3e8e94518d4a8e25c9a99dd35c35e1ee98dd934bba62c749**. Reopen preserved the saved identities. Both phases reported recoveryRequired = false; owned editors/locks and unsafe markers were absent, and six older IPC allocations were unchanged.

**VOUT was deliberately left unrouted.** No DC, thermal/minimum-spoke, island, high-frequency or whole-board acceptance was performed. Checkpoint publication means a recoverable saved candidate, not an accepted circuit. Raw stage-artifact hashes and canonical receipt identities remain distinct in the assessment.

[DOC5](../sidecars/doc5-runtime.md) and [profile07](C:/Users/pc/Downloads/EvlEDA-Handoff-2026-09-03/toolbox-native-doc5-transactions-profile-20260909-07.json) are published/frozen. DOC5 preserves the native Commit handle across begin/push/drop; host diagnostics retain primary failures separately from recovery failures. Profile07 is **5,333 bytes**, SHA-256 **f3707e553a860b1a4ec54ca4b82fa3a7bc9329b9a33afc0cabde5ea3e6127e93**.

The host-only [native-unit adapter](../src/harness/fresh-route-native-units.ts) explicitly materializes integer nanometres and sends values that the actual KiPy coordinate conversion returns exactly. Its [actual-KiPy integration test](../tests/integration/kicad-route-native-units.test.ts) exercised **4,107 values**. This fixed the second proof's one-nanometre truncation without relaxing source tolerances, patching runtime units or changing the driver coordinates to avoid the defect.

The [V2 endpoint connectivity module](../src/harness/fresh-plane-connectivity.ts) was still unwired at this partial-proof milestone; its nine focused / 33 combined earlier tests were included in verification03. It is now connected to the public tool and the complete demonstration above, with current host-collected native evidence. The later wiring is outside verification03's full-suite scope.

### Preserved failed native attempts01 and02

[Profile06](C:/Users/pc/Downloads/EvlEDA-Handoff-2026-09-03/toolbox-native-doc4-plane-profile-20260909-06.json) is 5,333 bytes, SHA-256 **b6b7a59b7867b6c23742896e6d1aeccad1b2e4d74580b2167a734e00ccf9ee73**. DOC4 packaging/verification and its private bounded receipt transport are documented in [the runtime note](../sidecars/doc4-runtime.md). Packaging and software checks do not qualify live APPLY.

The [native01 result](D:/EvlEDA-toolbox-plane-apply-20260909/evidence-plane-apply-01/result.json) remains a failure at **operation018, first VIN fresh_replace_route_items**, after setup/author/sync/outline/three placements/pad inspection. [The operation record](D:/EvlEDA-toolbox-plane-apply-20260909/evidence-plane-apply-01/operation-018.json) retains the terminal session/rollback error. The raw first add-versus-push error was lost, so its exact initiating suboperation is not reconstructed. A Commit-handle incompatibility was separately confirmed and later repaired in DOC5; proof03 does not rewrite the original failure.

**No plane APPLY occurred.** Later [exact read-only inspection](D:/EvlEDA-toolbox-plane-apply-20260909/readonly-recovery-assessment-exact.json) found matching saved/live source semantics with zero tracks/vias; no zone was created. The [final recovery](D:/EvlEDA-toolbox-plane-apply-20260909/normal-close-recovery.json) normal-closed the exact owned editor without save/revert/discard/kill. The saved PCB stayed **12,317 bytes**, SHA-256 **056c39113de6d08365ad105b45e3a6feb6f913135d5e8cf8a28db08b6d9fa39e**. Orphan allocation **e-nn7oDm is retained**, not released. This is safe closure of a failed attempt, not a native plane creation, update, persistence or reopen pass.

[Native02](D:/EvlEDA-toolbox-plane-apply-20260909-02/evidence-plane-apply-01/result.json) then failed an exact GND route comparison because native coordinate conversion truncated by one nanometre; no plane was created and resume did not start. Its [guarded revert/close recovery](D:/EvlEDA-toolbox-plane-apply-20260909-02/guarded-revert-close-recovery.json) restored the exact preimage and normally closed the exact owned editor. This authorized recovery and the unchanged older allocations remain separate from native03's successful clean finishes.

## Earlier native11 routed/labeled evidence

The [final real-stdio report](D:/EvlEDA-toolbox-fresh-smoke-20260909-11/stdio-proof-8489c53f-9955-4bfb-809b-4f3792d5c5be/report.json) records a completed read-only fresh resume with:

- Host-bound calculator access using an explicitly unrelated synthetic cross-section.
- Top and assembly native PNG previews and hash-checked SVG resource reads.
- Source-bound practice analysis and configured native **ERC 0 / DRC 0 / unconnected 0**.
- Explicit finish with **nativeSessionClosed = true, checkpointPublished = true, recoveryRequired = false**.
- Exact PCB identity before and after: **14,137 bytes**, SHA-256 **9030abe5a7c18dfd7553a31653341b21b6d37517e22992e71d7136ccd7bfe7ca**.

The calculator example is explicitly **not the divider's stackup or impedance evidence**. Its success proves access to the analytical tool, not a controlled-impedance PCB.

The board's earlier phases created/authored the project, closed and resumed it, placed/routed the divider, and wrote the labels. Fresh11 uses a corrected new-project table with the required mask, paste and presentation layers. The final read-only run does not pretend to repeat those mutations.

### Why the first fresh11 test report failed

[Independent text-preservation audit](D:/EvlEDA-toolbox-text-final-audit-20260909/findings.md) recovered the exact pre-operation PCB in memory from local history and matched its independently recorded hash: **c41c7a9a19cbaec04d1a2eaba7f48fa18b247eaa2a63b87891515a37172e4d80**, 13,511 bytes. No reconstructed board was installed as authority.

The saved result contains exactly three distinct text items:

- VIN at (5, 6.1) mm.
- VOUT at (5, 8.8) mm.
- GND at (5, 11.4) mm.

All have the reviewed front-silkscreen presentation. The raw parsed-JSON differences outside text were equivalent resistor-pad angle spellings, -90 versus 270, and their corresponding retained raw strings. Removing exactly the three added text spans makes the **already-reviewed whole-source comparator** match the exact preimage. Production preservation checks were not weakened.

All three text calls succeeded. The initial script's cleanup already had a clean checkpoint and no recovery requirement; its failure was the script's excessive raw-JSON equality assertion. Keep that failed report, the exact audit, and the later completed read-only run as distinct evidence.

### What the images actually show

[Received top image](D:/EvlEDA-toolbox-fresh-smoke-20260909-11/stdio-proof-8489c53f-9955-4bfb-809b-4f3792d5c5be/received-top.png) and [received assembly image](D:/EvlEDA-toolbox-fresh-smoke-20260909-11/stdio-proof-8489c53f-9955-4bfb-809b-4f3792d5c5be/received-assembly.png) were inspected.

VIN/VOUT/GND are visible beside the connector, the upper square pad identifies pin 1, and the routed jogs are 45 degrees. The assembly DIVIDER_IO value still extends beyond the left outline and footprint graphics remain cramped. The complete native page viewport now shows this defect **unclipped**; transport/framing success is not presentation approval. Schematic compactness remains unchanged from the earlier spacious layout.

Native page autoscaling and bounded raster density resolved the preview pixel-limit problem. Its earlier failure remains preserved, and the final renderer has a dedicated follow-up regression. Orthogonal schematic wires are conventional and are not violations of the user's 45-degree **PCB trace** requirement.

## New stackup observation and reference-coverage foundations

The [saved-stackup reader](toolbox.md#saved-physical-stackup-observation) observes the bound saved PCB with current-document and before/after source checks. It retains ordered copper/technical layers, dielectric sublayers, explicit material/thickness/permittivity/loss data, absent values and unsupported fields. Adjacent copper separation is summed only from explicit intervening dielectric thicknesses; heterogeneous materials are not averaged and reference nets are not selected automatically.

The workspace native case reported physical stackup **missing** despite an explicit **1.6 mm general board thickness**. It did not turn that general thickness into a signal-reference dielectric height or invent permittivity. The source-bound result states **impedanceValidation: not_performed**. Fifteen focused reader tests, MCP coverage and this native empty-stackup case are evidence of truthful observation, not fabricator confirmation or solved board impedance.

The [isolated reference-coverage prototype](D:/EvlEDA-reference-coverage-prototype-20260909/README.md) passed [18 fixed-fixture checks](D:/EvlEDA-reference-coverage-prototype-20260909/results.json) using KiCad-pinned **Clipper2 1.3.0** and prior native Unfracture oracle data. Synthetic route-width/margin ribbons were compared against captured native fill; tests distinguish holes, fracture-encoding bridges, disconnected-island gaps, duplicate/winding behavior and centerline-only false assurance.

That isolated prototype is not itself production integration or a DC/HF solver. The later public saved-source tool below adds real host wiring; native fill freshness, connectivity eligibility and electrical/profile applicability remain separate. A DC path around a hole may fail local coverage, while coverage over an isolated island does not establish a usable return path.

### Latest reference-coverage integration update

[Saved reference-copper coverage](toolbox.md#saved-reference-copper-coverage) is now exposed as optional **evleda_check_reference_coverage** through the existing host profile/startup path. It selects saved segments and fill geometry from the bound source, returns exact helper certificates and compact per-route findings, and retains large raw diagnostics as immutable hash-bound resources. Missing/unsupported input and uncertain boundaries are not truncated into a pass. This read-only tool does **not** refill, establish fill freshness or DC connectivity, approve the reference plane/margin, solve layer adjacency, or grant HF/impedance approval.

Reported focused verification is **not additive**: 77/77 reference cases with the real helper; 132 profile/startup cases; the V2 plane foundation's 50 tests and 189 combined regressions with scoped independent approval; and 157 refill-preservation cases. After the 77-case run, the public margin range was corrected to the plane contract's full **0–50 mm**, followed by a new boundary case and **44/44 wrapper/MCP rerun**. None of these totals replaces the historical full-suite count.

[Profile05](C:/Users/pc/Downloads/EvlEDA-Handoff-2026-09-03/toolbox-native-doc3-coverage-profile-20260909-05.json), 5,333 bytes, SHA-256 **74ec2d3688909f271f84d3cfbc4cc9e13e9cf660184be0d059f170b9ee4e98e0**, first passed read-only parsing and was subsequently used by the copied-native public-MCP proof below. The rejected noncanonical-path profile04 diagnostic is preserved.

Native overlay attempt2 exposed an asynchronous refill race: the native call queued work and returned immediately, and Ping was not a completion barrier. The recorded difference was the disappearance of the fill flag, not changed polygon geometry. The diagnostic copy was safely reverted and its exact owned editor closed after the matched dialog Cancel; the original source stayed unchanged. Allocation **e-CUPRBH remains retained** because its original release capability was lost—do not describe it as released or claim production refill success.

**Isolated native attempt3 completed both controls and normal owned cleanup.** The [assessment](D:/EvlEDA-plane-capture-validation-20260909/attempt-3-assessment.json) and [capture notes](D:/EvlEDA-plane-capture-validation-20260909/README.md) record fixed native unfill, verification that every expected zone is unfilled with empty caches, immediate fill, and busy-gated filled/nonempty verification before save/capture. Individual PAD query counts were positive **[2,2]** (each finds both endpoints) and negative **[1,1]** (each finds only itself). Original PCB hashes remained unchanged; attempt3's editor/supervisor/locks were absent afterward, while older allocations were untouched.

This is an **isolated capture prototype**, not a DOC4 installation or production native-plane acceptance. The deterministic controls used strict whole-source equality; changed-fill admission and general electrical validity are not established by that proof. Attempt2 remains failed and its retained e-CUPRBH allocation is not retroactively released.

The separate [native copied-host/public-MCP smoke](D:/EvlEDA-reference-toolbox-native-20260909/native-run/reference-coverage-smoke.json) and [post-assessment](D:/EvlEDA-reference-toolbox-native-20260909/post-assessment.json) are now complete. Through linked **InMemoryTransport**, the public tool classified SIG_CLEAR as covered, SIG_VOID as uncovered with an exact witness, and SIG_TANGENT as boundary_uncertain, retaining the same explicit **0.1 mm margin beyond the trace edge** in all three cases. Every raw diagnostic-resource hash was verified. This is not a STDIO or app-install test, and that fixture margin is not a universal electrical rule.

The copied synthetic fixture remained **5,834 bytes**, SHA-256 **8fe91e84a57b48c424d7fdb7edb354bc5efb08884183dec45dc462319a22e368**, through graceful close. The original source remained **b80cd79dcb08380c0ee504b085a97da5af8963db1f6f210e37d17c04a70ac809**; no new owned editor, locks or IPC allocation remained. Existing saved fill was retained, not freshly refilled in this public-tool test. Its deliberately unconnected SIG tracks do not form a qualified circuit or establish DC/HF/impedance correctness. [The repeatable script](../scripts/smoke-toolbox-reference-coverage.ts) executed at SHA-256 **5fa4359f658609651d280ac818b333d54b75a6ddf6a4b64b32be93906ff8dd9d**.

## Analytical calculator: useful now, scoped honestly

The [toolbox calculator section](toolbox.md#transmission-line-calculation) and [source package](../third_party/kicad-transline-core/README.md) describe four models: **microstrip, coupled microstrip, stripline and coupled stripline**. The optional kicadTransmissionLine section of the existing host profile pins the helper path, SHA-256 and byte count. It does not let a tool call choose an executable or board path; calculator availability is reported separately and does not require CAD edit access.

The source package retains pinned KiCad 10.0.3 code, original licenses/bytes and two explicit reviewed coupled-stripline corrections: finite-thickness centering and homogeneous-dielectric scaling. This is an analytical core with documented deviations, not a new field solver or a blanket validation of every formula.

The [six-call public-MCP proof](D:/EvlEDA-transmission-line-core-v3-20260909/mcp-proof.json) completed four analyses and two coupled syntheses. The [independent numerical matrix](D:/EvlEDA-transmission-line-independent-20260909/corrected-v3-results.json) preserves the review and negative inverse-roundtrip cases; it is not represented as wholly passing or as physical manufacturing evidence.

Operational limits remain explicit:

- Dimensions/material values and frequency are supplied with defined units; the tool does not invent the actual board construction.
- Coupled public targets are differential impedance. Quasistatic native coupled-microstrip differential output is distinct from twice the frequency-dependent odd-mode value; they are not interchangeable.
- Synthesis reanalyzes the candidate geometry and reports its residual. A converged result is not a unique inverse or a physical-accuracy guarantee; rounded manufacturable geometry needs a new analysis.
- Native delay/model approximations and finite-thickness/applicability limits remain visible. The coupled-stripline branch boundary at spacing/thickness = 5 can produce discontinuities or different inverse geometries.
- Results explicitly say **boardVerificationPerformed: false**. No saved-board width/gap/skew, real return copper, interface termination, or fabricator tolerance was verified.

The V2 compiler now admits the bounded explicitly declared interface family; unsupported topologies, construction or multilayer requests remain outside its envelope. The read-only saved-interface tool does not authorize requirement changes or complete physical interface acceptance.

The implemented [saved-route microstrip check](toolbox.md#saved-route-single-microstrip-assessment) now connects actual saved single-route geometry and adjacent stackup declarations to an explicit numerical target. It is read-only, requires caller-supplied construction metadata, and keeps physical reference/DC/accuracy and interface acceptance unverified. The [final public MCP report](../../destination-verification/saved-microstrip-public-final-01.json) passed 26 cases; [source/UI typecheck](../../destination-verification/doc6-product-typecheck-03.log) and [DOC6 build](../../destination-verification/doc6-product-build-03.log) also passed. The separate [saved-file/native-calculator qualification](../../destination-verification/saved-microstrip-native-01/results.json) now passes on a software fixture: the same **50 ± 5 Ω** target gives **48.14322877429875 Ω at 0.4 mm** (within) and **30.673743200273197 Ω at 0.8 mm** (outside). Missing and positive mask cases remain unassessed with zero dispatches. Source/pin checks and the independent [38-file artifact audit](../../destination-verification/saved-microstrip-native-01/artifact-manifest.json) passed, with no calculator process remaining. This uses asserted material metadata; it does not qualify a CAD-authored board or full MCP/native-host workflow. Board/interface acceptance stays false, and no full-suite pass is implied.

The [protocol-4 helper report](../../working-helpers/transline-core-uncovered-coupled-v1-msvc-20260910/qualification/results.corrected.json) records 553 invocations and 4,267 successful assertions, including 240 valid uncovered-matrix cases and 120 expected exact-air failures. All 15 upstream files remain unchanged. The [739-test focused interface suite](../../destination-verification/interface-product-01.json), [source/UI typecheck](../../destination-verification/interface-product-typecheck-01.log) and [full build](../../destination-verification/interface-product-build-01.log) retain their separate scopes, as do the later 115-runtime, 227-planner and 27-driver checks. None is a summed or clean full-suite claim. The later [native attempt04](destination-interface-qualification.md#native-attempt04-authored-pair-and-read-only-reopen) now passes authoring, source assessment and read-only reopen; earlier native failures remain preserved.

## Current software evidence and preserved verification history

The complete-board handoff records separate endpoint wiring/driver tests and the source-machine native demonstration; its historical full-suite run predates that wiring. Destination checks include 77 endpoint tests and 32 workspace/V1/V2-guide tests, then separate focused path/generation and startup-diagnostic repairs. The [92-test MCP integration run](../../destination-verification/mcp-integration-final.json) passed with zero failures or skips; source/UI typechecks and full build passed. The [first destination full run](../../destination-verification/full-suite-01.json) remains **4,356 passed / 68 failed / 53 skipped**, with two unhandled deadline errors. Focused counts are not combined into a full-suite pass. Details and the four failed native attempts remain in [destination verification](destination-verification.md).

[Historical pre-endpoint plane-APPLY verification03](D:/EvlEDA-verification-plane-apply-20260909-03/report.md) passed the full unfiltered four-worker suite: **4,425 passed / 52 skipped / zero failed** (4,477 tests), **207 files passed / 2 skipped**, in **274.58 seconds**. Source/UI typecheck, package prechecks, exact DOC5 verification and full build passed. All **1,550 Git-visible protected input files** retained identical content/recorded identity through the final snapshot at **2026-09-10T03:07:06.813Z**; these subsequent documentation edits are outside that interval. DOC5 verification reproduced **8,467 files / 1,159 directories / 150,420,817 bytes**. The command was composed prechecks plus pnpm exec vitest run --maxWorkers=4, not literal pnpm test; package defaults stayed unchanged. The approved pinned console geometry helper was enabled, with no editor/model/proof driver launched by the verifier.

[Pre-quantization plane-APPLY verification02](D:/EvlEDA-verification-plane-apply-20260909-02/report.md) had separately passed **4,404 tests / 52 skipped / zero failed**, types and build. It predates the final host-unit fix and is not the current-source total.

[Plane-APPLY verification01](D:/EvlEDA-verification-plane-apply-20260909-01/report.md) remains **not green: 4,342 passed / 19 failed / 52 skipped**, 201 files passed/one failed/two skipped (204 total), in **264.39 seconds**. Source/UI typecheck, normal prechecks, additional exact DOC4 verification and full build passed. Captured source/test/package/profile inventory had zero observed drift; DOC4 verification reproduced **8,467 files / 1,159 directories / 150,412,946 bytes**.

All 19 verification01 failures were in physical-evidence-release tests: fixed September 3 sessions became older than the unchanged production seven-day submission window when UTC crossed into September 10. The later [test-only clock repair](D:/EvlEDA-physical-clock-fixture-20260910-013946978/fixture-delta.json) uses the existing instance-clock seam, preserves explicit expiry overrides and assertions, and changes no global clock, production policy or fixture timestamps. Its **24/24 targeted cases and source TypeScript check passed**. That targeted result, green pre-quantization02 and final03 are separate records; none relabels or adds tests to failed01.

[Plane-authoring verification01](D:/EvlEDA-verification-plane-authoring-20260909-01/report.md) passed source/UI typecheck, normal prechecks and the full unfiltered four-worker suite: **4,114 passed / 52 skipped / zero failed**, **193 files passed / 2 skipped**, in **257.07 seconds**. Its full build then failed with **TS4058 declaration emit**; that original result is not rewritten.

[Post-fix verification02](D:/EvlEDA-verification-plane-authoring-20260909-02/report.md) verified the sole source change as type-only, passed source/UI typecheck, **24 targeted preparation/checkpoint tests**, and the full package build. The affected runtime JavaScript was byte-identical before/after, and src/tests had zero drift during this verification. **02 is targeted follow-up plus a build, not a second full-suite run; do not add 24 to 4,114.** The previous runtime-test evidence and exact type-only/unchanged-JavaScript evidence remain distinct.

[Historical reference verification02](D:/EvlEDA-verification-reference-20260909-02/report.md) passed **3,977 tests / 52 skipped / zero failed**, with **183 files passed / 2 skipped**, in **249.12 seconds**. Typecheck/prechecks/build passed and src/tests had zero drift. It predates the new plane-authoring work; the package's one-worker default remains unchanged.

For that historical reference-verification pair, the only 01→02 source/test difference was **tests/unit/cli-providers.test.ts**; production code was identical. The [cleanup diagnosis and repair](D:/EvlEDA-provider-test-cleanup-20260909/README.md) records verified teardown before directory removal, retaining and strengthening the failure/poisoning assertions. That test-only cleanup change is distinct from the later plane-authoring type-only declaration fix. Documentation, skills and smoke scripts are outside the src/tests inventory.

[Historical workspace verification](D:/EvlEDA-verification-workspace-20260909-01/report.md), preceding the new reference-coverage changes, records:

- Unfiltered four-worker run: **3,759 passed / 52 skipped / zero failed**, with **175 test files passed / 2 skipped**, in **256.56 seconds**.
- Source/UI typecheck, the normal source/corpus/runtime prechecks, and full package build passed.
- Compiled-source inventories before tests, after tests and after build were identical: **zero source-hash delta**. Documentation/example/smoke-script work was outside that compiled-source inventory.

The four-worker setting was an explicit command override; **package.json's default one-worker script is unchanged**. No filters, new skips or real-CAD opt-ins were introduced. This test timing is an observation, not a full-project ETA or model-performance comparison. The non-failing retained UI chunk-size warning remains documented.

The [earlier 3,692-test verification](D:/EvlEDA-verification-current-20260909-1310/report.md), separate 35-test renderer follow-up and their snapshot qualification remain historical evidence. They are not added to the new count or relabeled as one run. Software verification is also separate from the real native onboarding reports above.

The [preserved reference verification01](D:/EvlEDA-verification-reference-20260909-01/report.md) remains its original **non-green** result: **3,976 passed / 1 failed / 52 skipped** across 185 files (182 passed / 1 failed / 2 skipped), in **274.21 seconds**. Typecheck/prechecks/build passed and src/tests had zero drift in that run. The real reference helper was enabled, not a KiCad editor. Verification02 is separate evidence, not a relabeling of 01.

Verification01's sole failure was Windows **EBUSY directory cleanup** in the CLI-provider resistant-descendant test. Its diagnosis, original log and earlier reproductions are preserved. The test-only repair and completed verification02 now close that software-verification blocker; neither changes the failed historical result or converts native prototypes into production electrical acceptance. The historical 3,759-test pass remains separate.

The earlier [verified source archive](D:/Codex-Recovery/evleda-checkpoints/toolbox-calculators-source-20260909-01/README.md) was captured at **20:12:12 UTC**: **630 files / 88 directories**, 38,218,064 file bytes and **39,484,416 archive bytes**. [Capture manifest](D:/Codex-Recovery/evleda-checkpoints/toolbox-calculators-source-20260909-01/capture-manifest.json) and [verification result](D:/Codex-Recovery/evleda-checkpoints/toolbox-calculators-source-20260909-01/verification.json) record payload/directory checks. The [tar archive](D:/Codex-Recovery/evleda-checkpoints/toolbox-calculators-source-20260909-01.tar) includes the final renderer code but predates these later roadmap/documentation edits.

That is an older snapshot. Verified [reference source](D:/Codex-Recovery/evleda-checkpoints/reference-coverage-source-20260909-01/README.md) and [reference evidence](D:/Codex-Recovery/evleda-checkpoints/reference-coverage-evidence-20260909-01/README.md) archives remain intact. The later [plane-authoring source archive](D:/Codex-Recovery/evleda-checkpoints/plane-authoring-source-20260909-01/README.md) preserves 693 files/94 directories in 40,502,272 bytes; its [evidence archive](D:/Codex-Recovery/evleda-checkpoints/plane-authoring-evidence-20260909-01/README.md) preserves 318 files/184 directories in 7,116,800 bytes. These precede the plane-APPLY failures, DOC5/host-unit repairs and successful proof03. The current transfer separately contains the newer source snapshot and complete-all-nets proof described in [HANDOFF.md](../../HANDOFF.md); verified transfer is not GitHub publication.

## Current roadmap

The native lifecycle, label/image/calculator milestone, workspace submit/create/close/resume/restart flows and direct V2 complete-all-nets demonstration are established **within their respective fixture scopes**. The historical divider workspace board is unrouted; DOC7 regulator native10 now extends the V2 workspace path through NC-correct routing, strict public parity checking and normal close. Fresh read-only reopen now passes with unchanged sources; its current-session plane assessment remains incomplete without a fresh fill witness. Electrical/manufacturing suitability is separate. Remaining work is not expressed as a percentage or a firm ETA.

| Gate | Current state | Required next evidence |
| --- | --- | --- |
| Direct native CAD lifecycle | DOC7 native10 completes V2 authoring, preserving placement, routing, public strict checks, normal close and fresh read-only reopen with exact sources and matching top PNG. Older labeled-board evidence remains separate. | Expand representative use only with actual saved-source/native evidence. No arbitrary-board guarantee. |
| Direct V2 plane family | Native10 validates scoped thermal/clearance facts and all ten bores, with edit report 9 passed/38 unknown/0 failed and read-only report 47 unknown without current fill. | Resolve the two connector bore/cached-hole relationships, drill-clipped terminal continuity, physical widths and remaining rows without promoting native graph facts into whole acceptance. |
| In-chat workspace onboarding | Earlier V2 ready-ID/create/retry and intentionally unrouted fixtures are historical; native10 now adds routed NC-correct authoring and fresh read-only lifecycle proof. | Verify the newly installed DOC7 profile's running-desktop activation/tool refresh and broader project workflows; keep V1 named-NC unsupported scope explicit. |
| Analytical transmission-line tool | Four-model tool exists; real MCP analyses/syntheses and reviewed corrections are documented. | Actual stackup/fabricator inputs, pair authoring, board extraction, width/gap/skew/return-path/termination checks and applicability-bound evidence. |
| Client/application setup | [DOC7 catalog profile02 and exact updated skill installed](destination-client-installation.md); four read-only preflight calls and a fresh actual CLI process expose 15 initial tools, with zero workspace allocations. | Running-desktop activation of this new profile and attach/detach refresh remain unverified. Earlier DOC6 desktop discovery is historical. Namespace discovery is not broader part qualification. |
| Plane/pair/stackup engineering | Native attempt04 now passes declared-interface authoring, source-bound pair assessment and read-only reopen, with a nominal central-interval target result. | Resolve physical reference/termination/material, bends/launches and model-applicability gaps, and extend the chat-driven workflow. No automatic board/interface acceptance. |
| QFN, stacked pins and realistic capacity | DOC7 native10 preserves its named NC pad, paste apertures and all nineteen physical primitives through placement/routing/normal close; strict parity is clean and the ten-bore inventory is complete. | Resolve remaining bore/contact/width questions after successful read-only reopen and broaden thermal-array, stacked-pin and capacity cases; the regulator does not qualify the requested MCU board. |
| Save and GitHub handoff | The transferred source and latest complete-board proof are hash-verified; older archives remain historical. Code remains local. | Confirm destination/visibility/authorship/authentication, publish the reviewed source when authorized, and verify the remote commit. |
| RP2350 demonstration | Not started; follows the requested baseline push. | Design the selected Pico-like/Orpheus-inspired project with its actual required electrical, library, stackup and interface capabilities. |

The product remains tools and guidance that a model can use from chat. The old UI, Flux application, provider runner and infrastructure are **deferred, not deleted**. Reuse proven native/library/source components without requiring the whole older application to mediate every direct operation.

## Engineering limitations that remain

- **Planes and return paths:** [The current plane-tool report](destination-plane-acceptance.md) distinguishes native graph reachability, stored-fill geometry, bore-subtracted area and global physical terminal continuity. Exact bore/ribbon overlap fails, tangency remains unknown, and covered geometry does not close the full reference row while terminal continuity is unresolved. Keep actual copper/thermal width and all remaining mandatory rows explicit.
- **Pairs, impedance matching and stackup:** Native attempt04 now demonstrates authored pair geometry, source assessment and read-only reopen. Physical materials/resistances, fresh reference and terminal continuity, bends/launches and the `S >> 2*T` finite-thickness assumption remain unqualified; a nominal interval target pass is not full interface acceptance. Older helper and failed native proofs retain their separate scopes.
- **Power integrity and EMI/EMC:** The research dossiers and available calculations are not an integrated PDN/SI/EMI compliance result. Bind device-specific decoupling, power/return paths, spectral/edge conditions and relevant models/measurements. ERC/DRC and bend geometry alone do not prove PI or EMC.
- **Ampacity and via suitability:** Bind current waveforms, copper construction, dimensions/tolerances, allowable drop/heating, environment, protection and bottlenecks. A checked geometric width or an impedance calculation is not thermal/fault qualification.
- **Physical pads, QFN and intentional no-connects:** DOC7 [native10](toolbox-external-power.md#native-attempt10-and-remaining-limits) retains nineteen physical primitives, including the named NC copper pad and two paste apertures, with complete ten-bore inventory and strict public parity zero. Read-only reopen passed; the remaining bore/contact/width questions are still open. Broader thermal-array and stacked-pin behavior needs representative evidence. Earlier [QFN native evidence](D:/EvlEDA-qfn-pad-semantics-20260909/README.md) and these scoped cases do not qualify the complete requested MCU circuit.
- **Stacks, capacity and local organization:** Preserve every pin, source-proven stack membership and bounded planning. [Earlier capacity planning](D:/EvlEDA-schematic-capacity-plan-20260909/plan.md) is context, not a measured universal capacity guarantee. Improve local readable structure without dropping checks or replacing electrical evidence with convenient labels.
- **Visual/usability finish:** Connector signal labels are now demonstrated. Assembly text beyond the outline, crowded footprint graphics and oversized schematic layout remain visible quality targets.
- **Deployment and portability:** Real-stdio workspace create/list/close/resume and server restart are tested. The [global client entry is installed](destination-client-installation.md); verify desktop activation and dynamic tool refresh, native-operation timeouts and failure behavior. The disabled example and CLI catalog result do not establish desktop readiness.

The corpus remains **1,773 guidance records / 17 detailed dossiers**, not 1,773 executable checks. Native source, measurements, calculations, research and independent review establish different things; none should be silently substituted for another.

## Preserved history, not rewritten failures

- Native08 remains the successful direct lifecycle fixture. [Its report](D:/EvlEDA-toolbox-fresh-smoke-20260909-08/resume-layout-proof-57c53ba8-1bea-4b72-9f97-6f6262620fe2.json) is separate from newer text/calculator/preview features.
- Native09's first phases passed, but its text phase failed because expected board text was absent despite the native command's success response. Exact rollback/recovery evidence and the unsafe marker remain preserved; this was not a successful label proof.
- Fresh11's original stdio report failed only its raw-JSON angle comparison after three successful text writes and clean checkpoint/closure. The exact-preimage audit establishes why; the report itself stays a failure.
- Earlier preview warnings, viewport/pixel-limit failures, numerical inverse cases, and unsuccessful preimage searches remain retained alongside the successful later evidence.
- Historical application [attempt 14](D:/EvlEDA-live-proof-v8-attempt14-20260909-015249281/evidence/terminal-result-summary.json) passed 43 v1 checks but failed independent annotation review. [Attempt 15](D:/EvlEDA-live-proof-v8-attempt15-20260909-043024233/evidence/terminal-result-summary.json) passed 44 v2 checks and scoped ink coverage. These are not automatically the direct toolbox's completion verdict.
- Earlier [V2 recovery](D:/Codex-Recovery/evleda-checkpoints/source-v2-local-20260909-050015346/README.md) and [closed15/visual supplement](D:/Codex-Recovery/evleda-checkpoints/closed-attempt15-visual-supplement-20260909-053237914/README.md) retain their original source/test/proof boundaries.

The direct validation tool collects native findings and source/practice coverage. It does not manufacture an umbrella passed or manufacture-ready label from transport success or the older application's check count.

## GitHub, RP2350 order, and comparison claims

The user-selected destination is [lolwutboi987/evleda](https://github.com/lolwutboi987/evleda/tree/codex/destination-resume). The reviewed baseline was pushed and its remote commit verified as `8fa120343111107763433c7204bdbdbc240fc609` on `codex/destination-resume`. The existing Python `main` has separate history and was preserved. See the [publication receipt](../../destination-verification/reviewed-baseline-20260916-01/publication.json); the old no-remote/no-push observations are historical.

The requested [RP2350 Pico-like, Orpheus-informed board](../designs/rp2350-pico/README.md) has started after that verified push, on `codex/rp2350-pico`. Primary-reference review, selected-library inspection and concrete USB-C/native-pad capability work are underway. The native board is not yet authored or accepted.

No head-to-head benchmark against direct Astra computer use has been run. The demonstrated direct MCP operations and the older Astra-driven workflow do not establish superior speed, fewer corrections or better board quality. Any future comparison needs equal requirements/resources and independent saved-result checks. There is no arbitrary percentage or firm overall ETA.

## Scope and final completion

The goal remains a useful reusable prompt-to-PCB engineering toolset with readable/editable artifacts, required electrical/layout evidence and the requested demonstrations. A small native fixture, a calculator result, or a server that starts does not satisfy the whole goal.

Separate UI work and expanded infrastructure are deferred, not removed. Firmware development, ordering, manufacturing-process/release campaigns and physical qualification remain outside the current campaign. Applicable design-for-manufacture constraints and truthful handoff limitations remain in scope.

## Exact evidence anchors

- [Destination V2 workspace lifecycle](../../destination-verification/workspace-v2-05/workspace-proof-33a3a1cc-b2ae-4b86-b1e3-3747953df78f/report.json): **15e5051048166d5ebf76a06c2dd77d4685e66655efaa266bdc7ff1f52012c8c4**, 29 operations; intentionally unrouted.
- [Destination fresh-process read-only restart](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/report.json): **b13e0495886c97f29bd23d34223ebabd6af8316c408d227144fa637c8afb46e7**, 11 operations; six sources unchanged and native previews captured.

- [Transferred complete-all-nets assessment](../../proof/EvlEDA-toolbox-plane-complete-20260909-01/final-assessment.json) and [result](../../proof/EvlEDA-toolbox-plane-complete-20260909-01/evidence-plane-complete-01/result.json): result SHA-256 **923217ce4b3deb1cefc94534ad731a7e2fe6d5c79510728c6fbdd516a48dac91**, 997,778 bytes; eight tracks/one via, all-net endpoint reachability, configured ERC/DRC, six-file reopen and normal close. No intended-plane/thermal/island/HF/ampacity or manufacturing approval.
- Transferred complete-all-nets PCB: **062804a7545278eef20b38cf09eb79c96d39f38f7dbab7d0452840aa225bce9e**, 19,201 bytes. The newer DOC8 regulator's sources are recorded separately in its [attempt07 manifest](../../destination-ic-design-07/authored-source-01/manifest.json).

- [Passing native plane APPLY/save/reopen proof03](D:/EvlEDA-toolbox-plane-apply-20260909-03/evidence-plane-apply-01/result.json): **78e7ae79512d24627789ff20485c7a481032eba1471519616f51a5bbdb8fa93a**; partial routing, no DC/thermal/island/HF/full-board acceptance.
- [Historical pre-endpoint green software verification03](D:/EvlEDA-verification-plane-apply-20260909-03/report.md): **ebfd4ef87ab322dbe9ca4bac5a6b56d3607359275e0ee4dbb8fc74cf37e26e58**; 4,425 passed / 52 skipped / zero failed.
- [Failed native02 coordinate conversion](D:/EvlEDA-toolbox-plane-apply-20260909-02/evidence-plane-apply-01/result.json): **78a85d1d8df2d3fd5071a487e7ebcec0f8515cab627ec7de9eb35b2443e0edc7**.
- [Native02 guarded revert/close recovery](D:/EvlEDA-toolbox-plane-apply-20260909-02/guarded-revert-close-recovery.json): **5d53c270a1bf60cb4c7292ad9ca76f6c72285911b2ae886b33e583fcaa625fd5**.

- [Plane-APPLY failed native result](D:/EvlEDA-toolbox-plane-apply-20260909/evidence-plane-apply-01/result.json): **3d08907c4132747a33ca70b70ba422373671f7ebc601c720fdecdcd380f81453**; failed first VIN route, before APPLY.
- [Exact-handle normal-close recovery](D:/EvlEDA-toolbox-plane-apply-20260909/normal-close-recovery.json): **7e05eee627e82f92adc92f0e92afd33413d027bb4fb55133b47b0b02cb0d6afc**; e-nn7oDm retained.
- [Non-green plane-APPLY verification01](D:/EvlEDA-verification-plane-apply-20260909-01/report.md): **8b51ad73a54f2dd4a3a94bcd3eb8d8a35666e7a841bbaf68f2d65131378edaa2**.
- [Separate 24-case test-clock repair](D:/EvlEDA-physical-clock-fixture-20260910-013946978/fixture-delta.json): **18bc59b12cc779c5fa81fd55d16c178042b4285235d52fc6e00fd988be808c15**; targeted follow-up, not a full suite.
- [V2 plane-family native assessment](D:/EvlEDA-toolbox-plane-authoring-20260909/evidence-final/summary.json): **93e1a609fa0e2de1c466c69c29032dd21e167ea018bfe52cced3ec1684e6bb2b**; author/sync/resume and native DRU parsing, not plane copper or board/thermal acceptance.
- [Plane-authoring full tests plus original declaration-build failure](D:/EvlEDA-verification-plane-authoring-20260909-01/report.md): **2ba136d6fb8b4eeddfcf931debc092f555ba405166371b1056d7c2eb10535b1f**.
- [Type-only post-fix targeted/typecheck/build verification](D:/EvlEDA-verification-plane-authoring-20260909-02/report.md): **589941615a9c01c9396fb94981da2563a2623d015b355e5ac232f94b6006bd4b**; not a new full suite.
- [Workspace native create/author/sync/close/resume proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-0b63406c-16a6-4cc9-96bf-0236c2660d25/report.json): **3cc14522678b1cfa1fe382c8b28935427ad6fd962afa3249c40a8b682aaf91b3**. This project is not routed.
- [New-server workspace resume proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-2feed16c-f0f2-4fd0-9fca-27309121dd0e/report.json): **7aca44fe2f4a0c33e7c926503d68ee2f72a406ab82d6c71e6cde3617edf4b9c9**.
- [Idle no-allocation clarification proof](D:/EvlEDA-workspace-onboarding-proof-20260909/workspace-proof-bf795c02-f9bb-4db9-aae6-405e5b3ca058/report.json): **85834b852309c5aadf1fbc17f5cbf98b70d149ffde7e9deb3590ccf3e57f308b**.
- [Historical 3,759-test workspace verification](D:/EvlEDA-verification-workspace-20260909-01/report.md): **b93d3401f9c572a34f4441128f4344fb4c9478c12a560d48fe21c0733dd01677**; separate from the later failed reference-coverage run.
- [Historical green reference verification02](D:/EvlEDA-verification-reference-20260909-02/report.md): **7ffd632b1419e2cf3b54cba07db184bdf867cbab8ef06bc026bfa3639eb723bc**.
- [Preserved reference verification01, one failure](D:/EvlEDA-verification-reference-20260909-01/report.md): **9da42f3222fd305ec5eb4c98a762e3d49af77ce9517f68636e9950547e66e69f**.
- [Isolated native attempt3 capture assessment](D:/EvlEDA-plane-capture-validation-20260909/attempt-3-assessment.json): **10e64ba731f305412658f14ace910d2f8ac4b25e3fca7f0e368f429a7e05a4bc**; no production/native-plane or impedance acceptance claim.
- [Isolated reference-coverage results](D:/EvlEDA-reference-coverage-prototype-20260909/results.json): **ff1a7574f8ede9c5ab831b21db2559e317a4991608f9afc5e3b8596bc3e8026e**; synthetic route fixtures, no production integration.
- [Final native11 stdio report](D:/EvlEDA-toolbox-fresh-smoke-20260909-11/stdio-proof-8489c53f-9955-4bfb-809b-4f3792d5c5be/report.json), completed 2026-09-09 13:11:49 Pacific: **3d2ca099e48648882a2c99e14bb5a9ca5b3e946644a43c71fcdd735bcc7b9bfb**.
- [Fresh11 text audit](D:/EvlEDA-toolbox-text-final-audit-20260909/findings.md): **d1b296437ce276d508b78c008a4ec541837aa9b93ec03c3a58f3754148ccf721**.
- Final labeled PCB: **9030abe5a7c18dfd7553a31653341b21b6d37517e22992e71d7136ccd7bfe7ca**, 14,137 bytes; unchanged during the final read-only check.
- [Six-call calculator MCP proof](D:/EvlEDA-transmission-line-core-v3-20260909/mcp-proof.json): **fe50b0a3c550a73ea43fc5f5ecf1ef657d071f2ab373064003804942916a5257**.
- [Historical toolbox verification, 3,692-test run](D:/EvlEDA-verification-current-20260909-1310/report.md): **78fe771b17165ad2fff90f9c8f1ccdf9c5a26b62fa4f950f7d6a1882738a652a**.
- [20:12 UTC source archive](D:/Codex-Recovery/evleda-checkpoints/toolbox-calculators-source-20260909-01.tar): **f7740a7fa40b94e222cf78e92a836a7df4d872ecb28052fa184179d527235aff**. These later roadmap edits are outside that capture.

Absolute C:/ and D:/ links identify historical source-machine evidence and may be unavailable on this destination. The latest proof links resolve within the transfer package; none is proof of publication. Source/documentation links are repository-relative.

</details>
