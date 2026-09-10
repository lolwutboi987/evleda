# September 10 destination verification

Work is continuing from the September 9 transfer; this is not a product-completion or hardware-acceptance record.

## Qualified workspace milestone

The destination now passes a real STDIO V2 workspace lifecycle and a fresh-process read-only resume:

- [Create/author/sync/place/close/resume report](../../destination-verification/workspace-v2-05/workspace-proof-33a3a1cc-b2ae-4b86-b1e3-3747953df78f/report.json): 29 operations, ready-ID creation and idempotent retry, seven physical/logical terminals, correctly disconnected endpoint assessments, and clean close/checkpoint plus same-connection resume. Report SHA-256 `15e5051048166d5ebf76a06c2dd77d4685e66655efaa266bdc7ff1f52012c8c4`.
- [Fresh-process read-only report](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/report.json): 11 operations, saved-ID resume, endpoint/stackup reads, hash-checked native top/assembly PNG/SVG and clean close. Report SHA-256 `b13e0495886c97f29bd23d34223ebabd6af8316c408d227144fa637c8afb46e7`.
- [Native project](../../destination-workspace-v2-05/projects/4b225d42-538a-4b84-b332-4fc3a61d0e4d/output/project/workspace-plane-divider.kicad_pro) and [top preview](../../destination-verification/workspace-v2-readonly-restart/workspace-proof-3ab24175-324f-44cd-98d2-9a0831cf399d/restart-top.png). All six authored source identities match across both reports and disk. The canonical V2 bundle, V3 checkpoint and owned DRU agree. No successful-project lease, lock or editor remained after the three confirmed closes.

This fixture deliberately has zero tracks, vias and zones; its three nets are disconnected and its checkpoint remains `needs_review`. It qualifies the newly exposed workspace lifecycle, not a replacement complete-board demonstration. The older transferred all-net routed proof remains the separate reference. Native previews were inspected: all three placed footprints and labels are visible; the absence of routing is explicit.

## Restored inputs

The Downloads ZIP matched 65,985,656 bytes and SHA-256 `edde61347ca7f897a9c25c36257a165df6d90b4bfa63d4365ef098a13036d19d`. All 739 selected source files matched the capture manifest before edits. The original OneDrive checkout remains separate.

The completed divider proof under `../../proof/EvlEDA-toolbox-plane-complete-20260909-01` retains the exact main result, six authored sources, eight previews, and three endpoint diagnostics. Its eight tracks, one via, all-net physical reachability and configured clean native checks are transferred evidence, not a new execution on this computer.

## Destination changes and checks

- Real V2 plane schema discovery, submission and ready-ID creation now use the existing plane compiler/bundle and native preparation. V1 behavior remains supported. Focused workspace/V1/V2 guide suites: 32 passed; independent scoped review found no actionable issue.
- Final transferred endpoint integration: 77 targeted tests passed. The real copied KiPy conversion also passed its 4,107-value test on this machine with exact integer comparisons.
- Frozen-lockfile installation, source/UI typechecks, full build, DOC5 closure verification, research/seed verification and package checks passed. The updated skill passed its structural validator. The retained UI build emits its existing large-chunk warning.
- The transfer omitted root pnpm build-permission and Vitest configuration; both were restored. A root `.gitattributes` preserves exact pinned bytes across Git checkouts.
- The DOC5 working copy and both rebuilt analytical helpers have new verified pins; see [destination setup](destination-setup.md). Original runtime/profile/proof bytes remain preserved.

## Open verification issues

The unfiltered destination suite completed in 538.90 seconds with four workers: **4,356 passed, 68 failed, 53 skipped**, plus two unhandled deadline errors. File results were 190 passed, 23 failed and two skipped. This is one failed full run, not a sum of targeted checks. Reports: `../../destination-verification/full-suite-01.json` and the extracted `failures-01.json` alongside it.

Failures include missing historical reference artifacts, unavailable hardcoded old-machine runtime/CLI paths, directory-link tests using the destination's incompatible `D:` volume, test deadlines and a UI assertion. Their causes and applicability are being checked before changes; no blanket exclusions, relaxed production limits or full-suite pass are claimed.

The transfer contains no `reference-designs/` directory. Five tests in `tests/integration/reference-kicad-backend.test.ts` depend on the current Rev-A project, validation manifest, generator inputs and bound exports, including the run `20260905T041400.496613Z-8b7f124253b42c31`. The old OneDrive reference directory cannot substitute: none of the six current native-contract hashes matches any of its 153 files. Its older validation explicitly failed and lacks required current evidence. Matching source/run artifacts are required to restore these legacy tests.

The legacy `scripts/verify-docs.mjs` expects a repository-local historical `HANDOFF.md` and obsolete exact handoff statements. The current handoff is preserved at the transfer root. That checker remains an explicit compatibility gap; no historical content was invented to satisfy it.

The first load-only native-profile check exceeded the existing 30-second integrity-verification deadline while the four-worker suite was active. It launched no editor or sidecar. Its actual error is retained under `../../working-runtime/load-check-LK7HEU/initial-failure.json`. The idle retry passed both production loaders in 44.151 seconds across two separately bounded passes; see `../../working-runtime/load-check-D2tWnY/result.json`.

The first native workspace attempt passed real STDIO discovery, clarification and ready-ID submission, then failed during sidecar connection. Its original startup cause was discarded by existing catch wrappers and cannot be reconstructed. The host closed its owned editor/processes; the project and lease remain preserved under `../../destination-workspace-v2-01/projects/f1718fa8-7cfd-486a-a5ba-cd14880960fa`. Its complete report is under `../../destination-verification/workspace-v2-01/workspace-proof-954ff25a-5b20-4ba3-b62b-9e58a585cbd0/report.json`.

Startup diagnostics now preserve a bounded stage, categorical/code evidence and separate cleanup outcomes before host cleanup, without foreign error prose, getters, native tokens or environment dumps. Uncertainty and runtime-retention behavior remain enforced. Fifty-six host/session/diagnostic tests, three focused bridge faults, scoped review, the full build and final source/UI/script typechecks passed. Initial assertion/type errors during these changes remain in the working verification records; subsequent corrected runs are distinct.

The second native attempt failed with recorded `kicad-verification-deadline` evidence during session connection, before the inner connector stage. It does not retroactively establish the first attempt's cause. Its project/lease `2180639a-2705-4615-b7be-66cc95cc2b5a`, private runtime `evleda-kicad-inspection-XJanXu` and IPC allocation `e-JQWrAa` remain retained. No PCB editor or Python process remained during the post-attempt observation. The complete report is under `../../destination-verification/workspace-v2-02/workspace-proof-bb874baa-4219-4b5f-b6fa-4ec63413d9a9/report.json`.

The third attempt isolated a strict CLI-version-probe failure: exit zero with warning stderr. A real isolated probe established that missing private AppData directories caused KiCad to fall back to the read-only Program Files installation. Creating and binding the declared directories fixed the warning source. Attempt four retained a connection deadline; startup tracking now preserves the current inner stage even if an outer deadline fires. All four failed attempts remain separate from the successful fifth run. The ordinary short-path runtime and AppData fix preserve all hashes, ownership checks, empty-stderr checks and production deadlines.

Diagnostic initialize and registration measurements were also kept separate from qualification. One registration-only control disabled runtime filtering only within that diagnostic process; production filtering was unchanged. Native version/ping and normal filtered catalog discovery subsequently passed against an owned inspection copy. An initial inline-code diagnostic was rejected before process launch by the argument policy; it was corrected to use a file, not relabeled as a native timeout. The diagnostic editor was normally closed with exact process-incarnation/window checks; its source was an isolated copy of the preserved board.

## Focused repairs after the full run

Two groups of destination path/generation corrections passed 32 and 21 tests, respectively. They use NTFS temporary roots, actual KiCad paths, the matching DOC5 launcher and the recorded schematic-patch provenance chain. Junction and exact identity assertions remain active. These are targeted results, not an amended full-suite count.

The failed UI case and three previous timeout cases passed unchanged in isolated runs. The aggregate generic-runtime test still exceeded its own 60-second observation limit; its test-only deadline and teardown handling were corrected while preserving all production limits/assertions. It then passed in 54.8 seconds. New reports are stored alongside the original full-suite report.

The final broader MCP subprocess/bridge regression passed **92 tests, zero failures/skips**, including current configured DOC5 closure, process ownership, deadlines, deferred binding, native document boundaries and private recovery behavior. Its report is [mcp-integration-final.json](../../destination-verification/mcp-integration-final.json). This includes the repaired former drive/path failures and does not replace the failed unfiltered suite.

One-off initialize/editor diagnostic source files are preserved under `../../destination-verification/diagnostic-sources/` with their surrounding evidence. They are historical diagnostic snapshots, not installed product entrypoints. The reusable workspace smoke script remains in the repository.

GitHub publication awaits the user's owner/repository and visibility choice. General plane contact/thermal/island/reference acceptance, saved-routing interface/impedance checks and representative prompt-driven design remain unfinished. The RP2350/Pico-like board follows the reviewed publication milestone.
