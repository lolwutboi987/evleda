# Destination plane-evidence integration

This records the 10 September 2026 implementation and its actual verification boundary. The public tool is implemented and its native saved-board reader is qualified. The full fresh-board public-tool run **failed during MCP startup before any authoring operations**; it is not an integrated acceptance pass.

## Product behavior

`evleda_check_plane_acceptance({})` uses the current V2 project, authenticated bundle, exact sources, physical endpoint queries and host-configured helpers. The model supplies no path, pad request, evidence record, coverage margin or selected subset of routes.

The harness retains a current-session fill witness only after validated native unfill/refill and mandatory Save/readback. Project settings, canonical DRU, marker, project binding and physical scope are pinned before filling and rechecked through saving. Later mutation dispatch invalidates the witness even if saved bytes would be identical. Read-only reopening does not reconstruct fresh authority from serialized historical evidence. The tool reports missing authority and no passed rows until the plane is reapplied and saved in an editing session.

The evaluator separately reports:

- Exact source/native filled geometry, including fractured contours and holes, certified connected components and integer area thresholds.
- Complete physical inventory and intended-plane reachability through a direct eligible pad anchor on the uniquely attributed component. A via-only anchor without terminal-to-via reachability evidence remains unresolved.
- Pinned, current-source native DRC and thermal-rule applicability, including exclusions, ignored relevant checks, overrides, physical pad members and local zone contact. Native resolved-spoke evidence does not measure physical spoke width or exact spoke count.
- Complete declared reference-route ribbons and the contract's explicit margin against eligible copper. Unsupported routes, transitions and copper graphics are rejected rather than filtered out. Coverage does not establish impedance or HF suitability.

Every mandatory V2 row remains in the result. Actual minimum plane copper width, actual thermal width, complete plane-access/clearance interactions and other unfinished general gates prevent overall acceptance. `accepted` and `fabricationAuthorized` remain false. Full historical evidence is written separately from the compact public report; a serialized copy cannot regain current-session authority.

## Software verification

The [scoped report](../../destination-verification/plane-acceptance-unit-01.json) records **430 passed, two skipped, zero failed across 19 files**. SHA-256: `91a0822e60c0af5ec1c4aececc5b5b5a9980d31ff4839b18db164b24526f582e`. This includes genuine production evidence decoders with simulated process ports; it is not 430 native executions or a replacement for the previously failed full suite.

Source/UI typechecks, strict smoke-driver typechecking and the [final full build](../../destination-verification/plane-acceptance-build-02.log) passed. A final change retains the complete immutable CLI reports, invocation and source snapshot inside the private assessment; its [101-test regression](../../destination-verification/plane-native-retention-final.json) passed across three files, separately from the 430-test report above. The build verified the DOC5 runtime and retained the existing Vite large-chunk warning. Native Python-helper tests separately passed 16 cases against installed and isolated KiCad runtimes.

Independent review found two final-read timing gaps, now fixed and covered: the save path and assessment path must compare the PCB after their final settings read. The tests also cover edits with identical source bytes, stale/serialized witnesses, source/settings/rule changes, foreign inventories, component/area failures, uncovered or uncertain reference geometry, runtime drift and public input isolation.

## Real saved-board reader qualification

The [production-profile reader report](../../destination-verification/plane-contact-reader-03/report.json) passed against the preserved transferred board. SHA-256: `3cb5e56ac68609586175511d875ad0bf14c11e296049d3e2b004885485ee06ad`. It observed three footprints, seven pads, eight tracks, one via and one B.Cu ground zone. The direct neighbors were J1 pad 3 and the GND access via. PCB SHA-256 stayed `062804a7545278eef20b38cf09eb79c96d39f38f7dbab7d0452840aa225bce9e`, 19,201 bytes.

The isolated reader runtime contains exactly 117 files. Its pinned manifest is `11663765550eb62fdedfe43ceeacd45708c316d85fa21f9302125a38909b527c`; the Python helper is `2683a436daf6db0ce585ce4959d07eb83472765630165876e79378675643b568`, 19,041 bytes. The separate destination profile is `09e6384b5b742339c9b35739c306aae66b7d0fbedf2dab799023da903ef02f22`, 7,494 bytes. Existing profiles and runtimes remain unchanged.

Two preceding reader attempts remain failed. The bounded parent loaded 45 of the 46 approved Windows platform DLLs, omitting only unused `windows.storage.dll`; it loaded no additional DLL. The reader now treats the pinned Windows list as an allowlist, while preserving exact copied-runtime membership and file identities before/after execution. Tests still reject unapproved system DLLs. Exact rejected native output is retained before decoder/applicability checks.

These read-only observations do not establish a fresh fill epoch or complete plane acceptance on the historical board.

## Integrated native attempt and recovery

The [new public-tool driver result](../../destination-plane-acceptance-01/evidence-plane-acceptance-01/result.json) is **failed**, SHA-256 `73c4042e26e5ac62ef6fd564d2f5152c6677d9ac8cfd6769daa3cd669fa188af`. It recorded zero authoring operations. The first cause was `mcp-catalog` / `kicad-verification-deadline`; the outer connection budget expired while filtered catalog discovery was pending. That discovery performs native IPC capability queries, not just tool registration. The exact stalled subquery is not established.

The owned editor subsequently had only invisible toolkit helper windows and no main frame/dialog. Its remaining process was stopped through a handle checked against the recorded creation time, executable and exact test-project command. The [recovery record](../../destination-plane-acceptance-01/owned-editor-recovery.json), SHA-256 `3a07ecbd0e4a699f73a62ce8463aee335a53ecb520f64c001de5bf05984d72d9`, confirms all six source hashes unchanged. This was **not normal close or a successful checkpoint**. The IPC allocation `e-bE8AUS` and all failure artifacts remain preserved. No PCB editor or Python process remained in the subsequent observation.

Next work is to measure the remaining connection budget and native capability-query progress, then complete a new source-bound public acceptance run. Do not disable catalog filtering, relax runtime/source checks, or promote the failed fixture into a successful demonstration.
