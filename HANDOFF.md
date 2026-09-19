# EvlEDA continuation handoff

Current note: 2026-09-19. The active work is the reusable chat-driven KiCad/EE toolbox and its RP2350 candidate. The separate application UI remains deferred. Preserve existing designs, evidence, failed attempts and runtime profiles.

## Current candidate and tooling

The approved candidate is 22 × 60 mm with two copper layers, 2.54 mm GPIO pitch and 17.78 mm header-row spacing. PCB trace turns must be straight or 45 degrees. Both external GPIO service strips exclude unrelated tracks, vias and plane fill; only exact own-pad inward leads are permitted.

The latest published, normally closed native snapshot is [native-signal-routing-60-08](designs/rp2350-pico/native-signal-routing-60-08/README.md). It contains 630 saved track segments, 96 vias and no ground fill. Native endpoint observation reported 35 connected and 32 disconnected functional nets. It is incomplete. Later local routing batches must be checked and published before being treated as a newer delivered snapshot.

The guarded front-silkscreen operation now supports 0/90/180/270-degree text and explicit integer-nanometre materialization. Exact native readback and source preservation remain mandatory. The focused text/serialization/native-unit suites passed 152 tests; separate angle suites passed 52 tests and V2 authoring/save-policy suites passed 186 tests. Source/UI typechecks and an isolated backend build passed. These are scoped results, not a full-suite or native-text-qualification claim; the latter is pending.

Continue through public workspace operations. Inspect the active project and advertised schema before editing; obtain a fresh route selection for each route mutation, retain save/readback evidence, and close projects normally. Do not rewrite canonical rules, checkpoints, lease files or unsafe markers to force progress. Placement, route completion, native DRC, return-plane behavior and electrical qualification remain separate questions.

See [toolbox usage](docs/toolbox.md), [destination verification](docs/destination-verification.md), and [current status and roadmap](docs/current-status-and-roadmap.md). The original transfer handoff describes an earlier machine and remains historical context.

## Retained application and reference boundaries

The legacy application is a constrained implementation of a broader hardware-development goal. It does not yet generate arbitrary topology. Its reserved first-class invocation map has no production writer. The standalone Phase-A coordinator and architecture IR remain separate subsystems: They are not wired into the application factory/service, REST, MCP, or UI, and there is no default live provider. These statements concern the retained application architecture, not the public native toolbox's own operation receipts.

Current bundle exports use `evleda.bundle-manifest.v3`, `evleda.bundle-export-replay.v2`, and `deterministic-zip-v3`. Preserve exact older bundle schemas and their explicitly downgraded legacy-verification modes; do not relabel old evidence.

The historical Rev-A reference is an expected-negative `BLOCKED_DIAGNOSTIC` fixture for `ROUTE_STYLE` and `BACKTRACK`. Those native-clean results intentionally coexist with an `expected_negative` proof-fixture result under the independent EvlEDA route-quality policy. Native DRC and EvlEDA practice evidence do not substitute for each other. As documented in the retained acceptance matrix, the canonical reference has no real physical-acceptance record, qualification, or release.

The transferred checkout is missing the historical `reference-designs/robotics-controller-v0` fixture. Keep affected verification failures explicit until the correct original fixture is recovered and authenticated. The older September 3 workspace is not automatically the September 5 or September 9 reference state.

## Historical verification record — 2026-09-05

The following overlapping results are preserved from the checked-in [README verification matrix](README.md#verified-matrix-2026-09-05). They are historical reported results, not a new execution on the current checkout; do not add targeted counts together or infer that current GitHub CI passes.

- Full `node scripts/check.mjs`: 65/65 test files, 929 passed, 1 skip (intentional), 1 todo, and 0 failures.
- UI TypeScript: passed; UI Vitest: 10/10 files and 33/33 tests passed.
- Installed-Chrome Playwright: 5/5 passed.
- Real KiCad/reference suites: 4/4 files and 76/76 tests passed.
- Firmware validation: 32 passed and 1 intentional host-compiler skip because `EVLEDA_FIRMWARE_CC` was unset; the historical record reports that the real Arm cross-build passed.
- Audited `kicad-mcp`: 5/5 passed.
- Evidence and bundle suites: 3/3 files and 43/43 tests passed; standalone bundle adversarial verification: 35/35 passed.
- Production build: passed, 92 modules transformed.

On September 19, GitHub CI was still failing. Local reproduction identified this missing repository handoff as a documentation-contract failure. Restoring this document repairs that input; subsequent full verification and CI results must still be observed. No current complete software-verification, fabricated-board or release claim is made.
