# Destination plane-evidence integration

The V2 plane tool now has an actual native **workflow demonstration with retained rejection findings**: proof02 completed 49 public operations while reporting three footprint namespace parity warnings and uncovered VIN reference copper. Its driver passed; its plane assessment did not. Later drill-aware checks keep physical terminal continuity unresolved. DOC6 implements the full-footprint-ID repair and passed offline qualification, but its default proof03 failed at startup with zero authoring operations; native DOC6 authoring qualification remains pending. Startup-only probe04 later failed at bridge revalidation. Startup05 subsequently reached connected status and a 40-tool catalog, but its blank-project checkpoint was refused; the overall lifecycle and native writer qualification remain incomplete.

## Product behavior

`evleda_check_plane_acceptance({})` uses the current V2 project, authenticated bundle, exact sources, physical endpoint queries and host-configured helpers. The model supplies no path, pad request, evidence record, coverage margin or selected subset of routes.

The harness retains a current-session fill witness only after validated native unfill/refill and mandatory Save/readback. Project settings, canonical DRU, marker, project binding and physical scope are pinned before filling and rechecked through saving. Later mutation dispatch invalidates the witness even if saved bytes would be identical. Read-only reopening does not reconstruct fresh authority from serialized historical evidence. The tool reports missing authority and no passed rows until the plane is reapplied and saved in an editing session.

The evaluator separately reports:

- Exact stored source/native filled geometry, with fractured contours, holes and component area explicitly separated from the conservative area lower bound after supported round-bore subtraction. Drill topology reports the complete observed bore classifications and its inventory limits; a connected planar interior is not proof of all physical terminal contacts.
- Complete physical inventory and native PAD-graph reachability to a direct eligible pad anchor on the uniquely attributed stored component. This fact has scope `native-pad-reachability-to-stored-zone-component`. The full plane-net row cannot pass until pad, track and barrel contact continuity is checked in global drill-clipped copper; explicit connectivity failures remain failed.
- Pinned, current-source native DRC and thermal-rule applicability, including exclusions, ignored relevant checks, overrides, physical pad members and local zone contact. Native resolved-spoke evidence does not measure physical spoke width or exact spoke count.
- Complete declared reference-route ribbons and the contract margin against eligible copper. Exact strict overlap with a verified round bore is a failure; exact tangency remains unknown. A covered geometric ribbon still leaves the complete reference row unknown when terminal-contact continuity is unproved. Unsupported routes, transitions and copper graphics cannot be filtered into a pass.

Every mandatory V2 row remains in the result. Actual minimum plane copper width, actual thermal width, complete plane-access/clearance interactions and other unfinished general gates prevent overall acceptance. `accepted` and `fabricationAuthorized` remain false. Full historical evidence is written separately from the compact public report; a serialized copy cannot regain current-session authority.

## Native proof02: workflow passed, circuit findings retained

The [proof02 result](../../destination-plane-acceptance-02/evidence-plane-acceptance-01/result.json), SHA-256 `69cef5b32f0075ecbb1ad7a1d50a90f70d1dfd8a0cd865eb41693db1b715c1b3`, completed 49 public operations: native author/sync/place/route, plane refill/save, acceptance reads, normal finish and read-only same-bundle resume. Both sessions closed/checkpointed with no recovery requirement. All intended nets were routed; source and profile preservation checks passed.

After a route edit invalidated the fill witness, the tool returned `incomplete` with no saved witness and every row unknown. Reapplying and saving the plane produced the source-bound assessment, which correctly returned `failed`: native DRC retained three `footprint_symbol_mismatch` warnings for J1/R1/R2, and VIN reference coverage was `uncovered`. The public native-finding projection now retains those descriptions, severities, UUID-to-reference mappings and ignored-check keys. A declared two-spoke threshold on J1 pad 3 remained `unproven`, not a measured count or width.

Read-only resume again returned no fresh witness and no passed rows. This confirms invalidation and restart boundaries as well as successful operations; it does not manufacture an accepted board. The original proof02 recorded a passed `plane-net:GND` row under the earlier native-graph evaluator. Current code preserves that history but now keeps the full row unknown until global drill-clipped contact continuity is established; proof02 did not execute the later drill/common-check extensions.

## Current source additions and remaining gates

The [drill-aware evaluator](../src/harness/fresh-plane-drill-topology.ts) and [acceptance integration](../src/harness/fresh-plane-acceptance.ts) now distinguish stored fill area from a conservative bore-subtracted lower bound. Supported round pad/via bores retain exact integer-nanometre geometry, classification basis and complete known inventory. Unsupported slots, uncertain boundaries or incomplete topology remain unknown; conservative area loss alone does not prove an actual area failure. Physical minimum copper width and thermal width remain unmeasured.

Common saved-source outline, via-policy and trace-geometry checks now feed the actual V2 rows in current code. Their scope is numerical contract geometry, not ampacity, placement or terminal continuity. ERC now populates its existing V2 row from qualified, source-bound native evidence: verified maps to pass, unexcluded native violations map to fail, and unsupported or incomplete coverage maps to unknown. Default ignored checks, exclusions and non-default pin-map uncertainty remain visible and prevent a coverage pass; a clean native report does not waive them. The producer and public-row integration have scoped software verification, but these additions postdate proof02 and no new native ERC qualification run is claimed. The separate 23-case source-fence result covers source changes during assessment; it is not added to earlier suite totals.

The transmission-line adapter now supports **single uncovered microstrip** with `parameters.H_T: "absent"` using protocol 3 (`evleda-uncovered-microstrip-v1`). Finite numeric `H_T` still means a metallic cover height. Coupled-microstrip absent cover is explicitly unsupported; solder mask, arbitrary dielectric construction and board impedance qualification are not implied. Numeric requests retain protocol-2 compatibility. See [the model boundary](../third_party/kicad-transline-core/README.md#explicit-absent-cover-for-single-microstrip).

## DOC6 full footprint identities: offline qualified, native pending

The [DOC6 overlay](../sidecars/patches/doc6/qualified-footprint-identity-sync.patch) writes and compares full `Library:Footprint` IDs instead of bare leaf names, including escaped identities. [Its qualification record](../../working-profiles/doc6-qualified-footprint-identity.json) and [12 passing offline tests](../../working-profiles/doc6-qualified-footprint-identity-tests.json) preserve the old runtime and record the exact sync capability marker. This repairs the namespace-loss mechanism; it has not yet proved native authoring or eliminated proof02's warnings in a new native result.

The default [DOC6 proof03](../../destination-plane-acceptance-03/evidence-plane-acceptance-01/result.json), SHA-256 `6147f7d1095def650f4e4360dbea3b9028fb0150fa99492d6551d85fff256197`, failed during `mcp-catalog` startup with a verification deadline and unconfirmed cleanup. It recorded **zero authoring operations**, no plane creation and no resume. Source-preservation and failure diagnostics remain recorded. The later startup04/05 results below retain their own scopes; this failed result is not a DOC6 authoring pass.

The separate [startup-only probe04](../../destination-startup-doc6-04/result.json), SHA-256 `1bb298405af2c30829a36f871f5854951a439b3e2f02896a08cfbf7387907ffb`, failed at `bridge-revalidation` with `kicad-verification-deadline`. The [source sequence](../src/integrations/kicad-mcp-session.ts#L4733) places that stage after readiness, ordinary catalog discovery and deferred project binding had passed their guards, but no public status call or authoring ran. This was an external startup probe, not a full-board driver.

No editor or Python process remained in the subsequent inspection, and no manual kill was used. Cleanup still reported unconfirmed; IPC/runtime evidence remains retained. Original intent and profile were unchanged, but **no six-source-unchanged claim applies**: Open normalized the project file from 2,477 to 11,310 bytes, and the startup failure prevented a complete before snapshot. The secondary snapshot error remains in the record. This remains an unconfirmed-cleanup result. The later scheduler comparison and startup05 result below do not retroactively qualify its lifecycle.

### Runtime scheduler comparison

The [scheduler comparison](../../destination-verification/runtime-scheduler-benchmark-01/result.json), SHA-256 `749a8d527ad82482e7a45a38bd7aa1a5e88476ff952bf8855520d3207dead8d0`, recorded old factory-plus-current verification at **18.56 seconds** and the new global four-reader scheduler at **15.38 seconds**. Both used the same pinned DOC6 tree, returned identical bridge identity and retained the same file/alias checks and 30-second bound. No editor, CLI or sidecar was launched by this comparison.

The old scheduler ran first and the new one second, so warm filesystem cache is a confound; this is not a controlled or universal speedup claim. [Code/artifact identities](../../destination-verification/runtime-scheduler-benchmark-01/after-benchmark-file-identities.json) were captured **after** the benchmark, not as initial source-code pins. The [archive note](../../destination-verification/runtime-scheduler-benchmark-01/README.md) preserves that limitation and does not claim a hermetic replay.

### Startup05: discovery succeeded, checkpoint refused

The [ordinary production startup05 result](../../destination-startup-doc6-05/result.json), SHA-256 `becaa0c1b9d13900c33f41185a2ef225aa19eda63db69f88a18c23f3f93266ef`, reached connected native status and a **40-tool public catalog** at **2026-09-10 11:51:19 UTC**. No connector wrapping or circuit authoring was performed. Finalization then refused the blank-project checkpoint with **`Live PCB differs from saved source; checkpoint refused.`** The overall record remains `passed: false`; successful discovery is not a completed lifecycle or checkpoint pass.

No PCB editor or Python process remained in the subsequent host inspection. The saved PCB stayed **371 bytes**, SHA-256 `3d36b5da3f0a80ac1a65be694b8c8ffdc389cb830248171122770ea17da8b47b`. Only the project file normalized from 2,477 to 11,310 bytes during closure; the other five tracked sources, original intent and profile were unchanged. This saved-file evidence does **not** explain the unrecorded live PCB difference. A native blank-board observation is being prepared to diagnose it; no differing live geometry or normalization rule is assumed. DOC6's full footprint writer remains unqualified natively.

## Preserved earlier software verification

The [scoped report](../../destination-verification/plane-acceptance-unit-01.json) records **430 passed, two skipped, zero failed across 19 files**. SHA-256: `91a0822e60c0af5ec1c4aececc5b5b5a9980d31ff4839b18db164b24526f582e`. This includes genuine production evidence decoders with simulated process ports; it is not 430 native executions or a replacement for the previously failed full suite.

Source/UI typechecks, strict smoke-driver typechecking and the [final full build](../../destination-verification/plane-acceptance-build-02.log) passed. A final change retains the complete immutable CLI reports, invocation and source snapshot inside the private assessment; its [101-test regression](../../destination-verification/plane-native-retention-final.json) passed across three files, separately from the 430-test report above. The build verified the DOC5 runtime and retained the existing Vite large-chunk warning. Native Python-helper tests separately passed 16 cases against installed and isolated KiCad runtimes.

Independent review found two final-read timing gaps, now fixed and covered: the save path and assessment path must compare the PCB after their final settings read. The tests also cover edits with identical source bytes, stale/serialized witnesses, source/settings/rule changes, foreign inventories, component/area failures, uncovered or uncertain reference geometry, runtime drift and public input isolation.

## Real saved-board reader qualification

The [production-profile reader report](../../destination-verification/plane-contact-reader-03/report.json) passed against the preserved transferred board. SHA-256: `3cb5e56ac68609586175511d875ad0bf14c11e296049d3e2b004885485ee06ad`. It observed three footprints, seven pads, eight tracks, one via and one B.Cu ground zone. The direct neighbors were J1 pad 3 and the GND access via. PCB SHA-256 stayed `062804a7545278eef20b38cf09eb79c96d39f38f7dbab7d0452840aa225bce9e`, 19,201 bytes.

The isolated reader runtime contains exactly 117 files. Its pinned manifest is `11663765550eb62fdedfe43ceeacd45708c316d85fa21f9302125a38909b527c`; the Python helper is `2683a436daf6db0ce585ce4959d07eb83472765630165876e79378675643b568`, 19,041 bytes. The separate destination profile is `09e6384b5b742339c9b35739c306aae66b7d0fbedf2dab799023da903ef02f22`, 7,494 bytes. Existing profiles and runtimes remain unchanged.

Two preceding reader attempts remain failed. The bounded parent loaded 45 of the 46 approved Windows platform DLLs, omitting only unused `windows.storage.dll`; it loaded no additional DLL. The reader now treats the pinned Windows list as an allowlist, while preserving exact copied-runtime membership and file identities before/after execution. Tests still reject unapproved system DLLs. Exact rejected native output is retained before decoder/applicability checks.

These read-only observations do not establish a fresh fill epoch or complete plane acceptance on the historical board.

## Preserved native attempt01 and recovery

The [new public-tool driver result](../../destination-plane-acceptance-01/evidence-plane-acceptance-01/result.json) is **failed**, SHA-256 `73c4042e26e5ac62ef6fd564d2f5152c6677d9ac8cfd6769daa3cd669fa188af`. It recorded zero authoring operations. The first cause was `mcp-catalog` / `kicad-verification-deadline`; the outer connection budget expired while filtered catalog discovery was pending. That discovery performs native IPC capability queries, not just tool registration. The exact stalled subquery is not established.

The owned editor subsequently had only invisible toolkit helper windows and no main frame/dialog. Its remaining process was stopped through a handle checked against the recorded creation time, executable and exact test-project command. The [recovery record](../../destination-plane-acceptance-01/owned-editor-recovery.json), SHA-256 `3a07ecbd0e4a699f73a62ce8463aee335a53ecb520f64c001de5bf05984d72d9`, confirms all six source hashes unchanged. This was **not normal close or a successful checkpoint**. The IPC allocation `e-bE8AUS` and all failure artifacts remain preserved. No PCB editor or Python process remained in the subsequent observation.

Attempt01 remains historical failure evidence. Proof02 subsequently completed the workflow with explicit circuit rejections; the later DOC6 proof03 remains a separate startup failure. Preserve all records and their cleanup distinctions while finishing the current startup work. No clean full-suite or whole-board acceptance claim follows.
