# EvlEDA continuation handoff

Current note: 2026-09-19. The active work is the reusable chat-driven KiCad/EE toolbox and its RP2350 candidate. The separate application UI remains deferred. Preserve existing designs, evidence, failed attempts and runtime profiles.

## Current candidate and tooling

The [placement-revision workflow](proofs/native-placement-revision-20260919/README.md) is now natively qualified. Continue physical layout work on revised project `914f7760-c4c2-4bb8-9b51-b481242878a5` using host30/DOC14; original project `b2e1adba-cf6c-4ccf-a51f-00f63320d6eb` remains preserved. Both have the same 829-track geometry. The revised constraints permit reorienting/repositioning R1/R2 without changing the circuit or USB limits. No component moves have been applied.

The approved candidate is 22 × 60 mm with two copper layers, 2.54 mm GPIO pitch and 17.78 mm header-row spacing. PCB trace turns must be straight or 45 degrees. Both external GPIO service strips exclude unrelated tracks, vias and plane fill; only exact own-pad inward leads are permitted.

The latest normally closed native snapshot is [ground and USB revision 60-12](designs/rp2350-pico/native-ground-usb-60-12/README.md): **829 tracks, 104 vias and one B.Cu ground zone**. Nineteen added front ground segments reduce GND from 12 to **nine physical-pad groups**, with **49 of 64 pads** in the main group. A coordinated three-branch USB adjustment removes the prior sharp bend while preserving the existing source-assessed width, gap, length and skew limits. There are **631 measured turns with zero violations and eight unresolved junctions**. Both GPIO service strips are clear, with 40 exact own-pad leads permitted. Native checks still report **24 unconnected errors and 13 dangling-item warnings**; 53 functional nets are connected and 14 remain disconnected. USB resistor placement, remaining routing, labels and electrical/DFM review are unfinished.

The [spatial geometry checker](docs/plane-geometry-spatial-filtering.md) is now qualified in a live host25/DOC14 session. The earlier recorded-native replay and unchanged operation/vertex bounds remain preserved. All current acceptance failures and missing coverage remain explicit.

The [compact plane-receipt fix](docs/plane-receipt-compaction.md) was qualified on a separate native fixture using host23/DOC14. The first RP2350 trial then exposed a second duplicated envelope inside the host PAD adapter. Host24 selects the existing compact PAD format and passes the real RP2350 plane operation. A [narrowly scoped recovery](docs/unchanged-plane-session-recovery.md) archived the exact failure metadata and released the unchanged prior checkpoint; it rewrote no source or checkpoint. The new RP2350 session resumed, filled, saved/read back, checked, rendered and closed normally. Next work is connecting the ground groups and unfinished signals, resolving USB placement/turn findings and completing labels and electrical/DFM review.

The guarded front-silkscreen operation supports 0/90/180/270-degree text and explicit integer-nanometre materialization. The [native three-component V1 fixture](proofs/native-cardinal-text-20260919/README.md) now verifies all four angles, exact coordinate/font-size conversion, source preservation and normal close. Complete physical materialization is a prerequisite. The focused text/serialization/native-unit suites passed 152 tests; separate angle suites passed 52 tests and V2 authoring/save-policy suites passed 186 tests. Source/UI typechecks and an isolated backend build passed. These are scoped results, not a full-suite pass or completed RP2350 label-placement claim.

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
