# EvlEDA v0 acceptance matrix

This matrix turns the supplied product brief and the
[v0 product contract](product-contract.md) into auditable acceptance obligations.
It is a current-state ledger, not a roadmap checkbox or a safety claim.

## Status vocabulary

- **SOFTWARE-COMPLETE** — the repository contains the in-scope implementation
  and an acceptance check that is sufficiently direct for this requirement.
  This does not mean a board is safe, qualified, fabricated, or released.
- **UNVERIFIED** — implementation or sufficiently direct acceptance evidence is
  missing, partial, stale, indirect, or not executed in the required environment.
  “No known failure” is not evidence.
- **HARDWARE/HUMAN-ONLY** — software may prepare a procedure or record, but the
  acceptance act requires a qualified human, physical board, calibrated
  instrument, fabrication/assembly fact, or release authority. CI cannot close it.

The **current status** column deliberately does not claim a current GitHub CI,
fabrication, bench, qualification, or release pass. A row changes to
SOFTWARE-COMPLETE only with the named evidence; a broad green unit suite cannot
close a narrower native/hardware requirement.

Settled local software snapshot (2026-09-05): `node scripts/check.mjs` passes
the documentation contract, current-v3 and explicit legacy-v2 bundle paths,
35/35 standalone bundle-verifier adversarial cases, exported-bundle integration,
both TypeScript projects, 65/65 Vitest files with 929 pass, 1 intentional skip,
1 todo, 0 failures, and the 92-module production build under Node 24.19.0. UI `tsc` passes;
UI Vitest is 10/10 files and 33/33 tests; Playwright
against installed Chrome is 5/5. Targeted real KiCad/reference coverage is 4/4 files and
76/76 tests; the audited real `kicad-mcp` check is 5/5. The real Arm firmware
campaign has 32 pass and 1 intentional host-compiler skip because
`EVLEDA_FIRMWARE_CC` is unset, while the identity-bound cross-build passes.
Focused evidence/bundle coverage is 3/3 files and 43/43 tests. This is not a
GitHub Actions, fabrication, bench, qualification, or release result.

Canonical native-reference snapshot: validation root
`6df66588417808381b0909041400b4f13c8580d675131fc0335ef57f33062d50`
binds the 60 mm x 45 mm six-layer 1+4+1 HDI board, 106 footprints,
42 native exports, immutable validation inputs, and zero ERC, DRC, schematic
parity, native-open, planner-partial, and planner-unresolved findings. Two
self-contained writer-challenged seeded replays retain independently verified
issuance, receipt, inventory, transcript, and output bytes and produced
byte-identical PCB, project, preparation, and routing-report bytes. Published fabrication capabilities are only an
envelope; written fabrication-engineering approval remains required for the
exact stackup, microvias, impedance, build notes, and CAM.

That native snapshot is not an aggregate engineering pass. Rev-A is retained as
an expected-negative proof fixture: its clean native DRC can coexist with
blocking EvlEDA `ROUTE_STYLE` and `BACKTRACK` practice findings. The required
engineering disposition is `BLOCKED_DIAGNOSTIC`, not `PROVISIONAL_POC`,
qualification, or release.

## Product, scope, and policy

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| P-01 | Runtime is local-first; no hosted multi-tenant service is required | Loopback-only server/config integration test and no required cloud dependency | SOFTWARE-COMPLETE |
| P-02 | v0 is restricted to non-safety-rated low-voltage prototype robotics controllers | Policy tests reject every documented exclusion and out-of-envelope boundary | SOFTWARE-COMPLETE |
| P-03 | Current constrained Rev-A proof scope is 7–16.8 V DC, two brushed-motor channels, ≤0.5 A RMS/channel, and a 1 A chop target; parameterized requests may only narrow voltage/current while every structural invariant remains exact | Frozen profile and expected-negative fixture artifacts, canonical-instantiation boundary/negative tests, requested-profile provenance, and exact schematic/BOM binding | SOFTWARE-COMPLETE |
| P-04 | Battery charging/BMS, mains, safety-rated, human-carrying, medical, certified-protection and motor-safety uses are excluded | Table-driven denial tests for each excluded use | SOFTWARE-COMPLETE |
| P-05 | Ambiguous voltage, missing load current, unsupported interfaces, unknown footprints and incomplete evidence block | Requirement/policy integration tests assert durable blocker and no downstream attempt | SOFTWARE-COMPLETE |
| P-06 | Autonomous work can reach `candidate` only | End-to-end policy test shows no agent/MCP path to `qualified` or `release_authorized` | SOFTWARE-COMPLETE |
| P-07 | Requirements approval, qualification and release are separate human capabilities | Capability-bound policy tests, no lifecycle operations in MCP, and separately gated local-human REST routes | SOFTWARE-COMPLETE |
| P-08 | A clean check, completed stage, CAM export or model claim cannot change lifecycle | Transition property tests over all evidence/execution outcomes | SOFTWARE-COMPLETE |
| P-09 | Any design change creates a candidate revision and old attestations do not carry forward | Revision/attestation invalidation integration test | SOFTWARE-COMPLETE |
| P-10 | Candidate bundle is visibly `CANDIDATE — NOT FOR MANUFACTURING` | Export and standalone-verifier tests extract the deterministic cover and assert its visible warning/lifecycle text | SOFTWARE-COMPLETE |
| P-11 | Prototype bundle requires exact human qualification and is visibly `PROTOTYPE — NOT PRODUCTION RELEASED` | Positive/negative export policy tests bind the exact manifest/evidence root and extract the warning-bearing qualified-lifecycle cover | SOFTWARE-COMPLETE |
| P-12 | Export never changes lifecycle | Before/after state identity test for both export operations | SOFTWARE-COMPLETE |
| P-13 | Manufacturing release is unreachable until exact physical evidence and separate release attestation exist | Capability/policy negative tests plus human release review | HARDWARE/HUMAN-ONLY |
| P-14 | Reference production physical acceptance, qualification, and release are complete for the current board | Generated physical-acceptance `approvalStatus` is `approved`; exact current physical evidence is independently reviewed; non-revoked qualification and separate release records exist | UNVERIFIED |
| P-15 | Product documentation distinguishes the broad agentic hardware-development goal from the narrower constrained current implementation | Cross-document contract verification preserves candidate-only authority, expected-negative Rev-A scope, and the unintegrated Phase-A boundary | SOFTWARE-COMPLETE |

Current P-14 truth: the reference physical-acceptance policy still reports
`approvalStatus: incomplete`; no real current qualification or manufacturing
release exists.

## Workflow and persistence

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| W-01 | Implement the nine ordered stage names exactly | Unit test of public stage order and serialized values | SOFTWARE-COMPLETE |
| W-02 | Stage dependencies are explicit; a stage starts from an immutable input manifest | Workflow integration test inspects committed attempt input roots | SOFTWARE-COMPLETE |
| W-03 | Successful attempt commits all artifacts/evidence atomically; partial output is never current | Every-content-boundary application fault injection plus prepared-journal atomic old/new visibility and recovery tests prove partial stage output never becomes current | SOFTWARE-COMPLETE |
| W-04 | Rerun appends an attempt and revision branch and never overwrites history | State diff/idempotent replay test across rerun | SOFTWARE-COMPLETE |
| W-05 | Resume continues from the first eligible blocked/interrupted stage | Restart/persistence integration test | SOFTWARE-COMPLETE |
| W-06 | Fencing prevents late timed-out/interrupted workers from committing | Deterministic concurrent-worker test | SOFTWARE-COMPLETE |
| W-07 | Upstream changes mark all dependent artifacts/evidence stale/not-current | Rerun invalidation test over descendant stage attempts and records | SOFTWARE-COMPLETE |
| W-08 | Project/run model stores requirements, constraints, parts, revisions, invocations, artifacts, failures, approvals and evidence identities | State schemas and restart round trips cover the other record classes, but no production writer populates `state.invocations`; acceptance still needs end-to-end success/failure/timeout/restart invocation records | UNVERIFIED |
| W-09 | Optimistic state revision rejects stale writers | Concurrent state-store test | SOFTWARE-COMPLETE |
| W-10 | Mutation retries are idempotent; changed input under a reused key conflicts | Per-command idempotency tests over all durable mutations | SOFTWARE-COMPLETE |
| W-11 | `requirements` emits source-linked requirements, exclusions, acceptance criteria and blockers | Parser unit/boundary tests plus approved profile fixtures | SOFTWARE-COMPLETE |
| W-12 | `system_architecture` emits power/signal/fault architecture and requirement allocation | Golden schema/traceability test for reference design | SOFTWARE-COMPLETE |
| W-13 | `component_selection` emits pinned part/datasheet/symbol/footprint/layout/lifecycle evidence | Reference selection test against curated library | SOFTWARE-COMPLETE |
| W-14 | `schematic` emits editable native KiCad source and connectivity intent | KiCad-open/native ERC/netlist test on isolated copy | SOFTWARE-COMPLETE |
| W-15 | `firmware_contract` emits the complete machine-readable hardware contract | Schema test and schematic/pin/resource parity test | SOFTWARE-COMPLETE |
| W-16 | `simulation_checks` reports applicable modeled evidence and unsupported gaps honestly | Supported/unsupported model fixtures and evidence-state assertions | SOFTWARE-COMPLETE |
| W-17 | `pcb_placement_routing` emits editable board and constraint/connectivity/geometry evidence | KiCad-open/native DRC/parity and routing-completeness test | SOFTWARE-COMPLETE |
| W-18 | `manufacturing_package` emits BOM, sourcing, assembly, Gerbers, drills, position data, renders and reports | Exact bundle inventory and KiCad-native export test | SOFTWARE-COMPLETE |
| W-19 | `bringup_package` emits firmware/tests, pin maps, guarded procedures, expected limits and raw forms | Golden content/schema test that contains no fabricated results | SOFTWARE-COMPLETE |

Durable file locks bind PID plus OS process-start identity on Windows, Linux,
macOS, and FreeBSD. Other platforms, including AIX and Solaris, are outside the
durable-lock support boundary and reject admission before helper execution or
claim creation. Legacy v1 PID-only locks remain conservatively readable during
recovery; they are never upgraded by guessing an incarnation.

## Specialist, component, firmware, and UI capabilities

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| C-01 | One coordinator exposes electrical/system architecture capability | Stage worker contract and reference-run artifact | SOFTWARE-COMPLETE |
| C-02 | Coordinator exposes component/datasheet research capability | Curated/live-source fixture with captured claims | SOFTWARE-COMPLETE |
| C-03 | Coordinator exposes schematic generation capability | Native KiCad reference-run artifact and checks | SOFTWARE-COMPLETE |
| C-04 | Coordinator exposes PCB placement/routing planning capability | Native board reference-run artifact and checks | SOFTWARE-COMPLETE |
| C-05 | Coordinator exposes firmware/interface generation capability | Contract/scaffold reference-run artifacts | SOFTWARE-COMPLETE |
| C-06 | Coordinator exposes simulation/verification capability | Modeled evidence and unsupported-coverage artifacts | SOFTWARE-COMPLETE |
| C-07 | Coordinator exposes manufacturing/package validation capability | Complete inventory/native export evidence | SOFTWARE-COMPLETE |
| C-08 | Coordinator exposes bring-up documentation capability | Procedure package fixture | SOFTWARE-COMPLETE |
| C-09 | Curated KB pins symbol, footprint, datasheet, limits, lifecycle, layout constraints and reference circuits | Schema validation and one reviewed reference-profile dataset | UNVERIFIED |
| C-10 | Live research is opt-in and captures URL, document hash, retrieval date and extracted claims | Network-policy negative tests and captured-source fixture | SOFTWARE-COMPLETE |
| C-11 | Firmware contract covers pins/resources, voltage/current, interrupt/timer/DMA, protocols, fault/reset and board revision | Contract schema and reference golden file | SOFTWARE-COMPLETE |
| C-12 | Firmware scaffold includes validation stubs and bring-up tests | Build/test of generated reference scaffold | SOFTWARE-COMPLETE |
| C-13 | Firmware contract matches generated schematic and pin map | Deliberate pin/timer/DMA conflict tests plus reference pass | SOFTWARE-COMPLETE |
| C-14 | Local UI supports prompt intake and requirements review/approval | Browser component/e2e tests including error and keyboard states | SOFTWARE-COMPLETE |
| C-15 | Local UI shows workflow progress, blockers and resumable actions | Browser e2e test against blocked/resumed fixture | SOFTWARE-COMPLETE |
| C-16 | Local UI supports artifact/evidence inspection without flattening statuses | Browser tests for pass/fail/error/unsupported/stale/revoked/waived | SOFTWARE-COMPLETE |
| C-17 | Local UI supports candidate/prototype package export with exact warnings | Browser/export integration test and rendered visual check | SOFTWARE-COMPLETE |
| C-18 | Existing MCP integration remains available through the stable operation set | MCP protocol conformance test for all fourteen tools | SOFTWARE-COMPLETE |
| C-19 | Reviewed standalone agent trust prerequisites bind canonical instruction/catalog/output-contract bytes, exact provider/model policy, an approved adapter registry, and append-only replay receipts | File-backed trust-store, provider-registry, durable-replay restart/tamper, alias, inventory, and policy-mismatch tests | SOFTWARE-COMPLETE |
| C-20 | Phase-A agent scaffolding and system-architecture decision IR preserve frozen authority, requirement, engineering-practice, target-allocation, deterministic-validator, and replay boundaries | Coordinator/workflow-context/orchestrator/validator-registry and system-architecture decision-compiler positive and adversarial unit suites | SOFTWARE-COMPLETE |
| C-21 | Production stage execution uses the agent stack through a reviewed default live provider and exposes its durable provider/invocation state through the application, API/MCP, and UI | Production factory/provider integration plus stage, persistence, restart, public-contract, and operator-workbench tests | UNVERIFIED |

## REST/MCP public operations

The request/result/error requirements are specified in [api.md](api.md). Each
operation needs both a REST contract test and an MCP contract test against the
same command handler and policy result.

| ID | Operation | Required acceptance coverage | Current status |
| --- | --- | --- | --- |
| A-01 | `create_project` | Confinement, idempotency, metadata envelope, restart persistence | SOFTWARE-COMPLETE |
| A-02 | `start_design_run` | Exact prompt/config identities, expected revision, durable queue/block | SOFTWARE-COMPLETE |
| A-03 | `get_run_status` | All run/attempt/blocker states and current identities | SOFTWARE-COMPLETE |
| A-04 | `inspect_requirements` | Source spans, assumptions, approvability, no implicit approval | SOFTWARE-COMPLETE |
| A-05 | `approve_requirements` | Trusted human capability, digest/revision binding, idempotency, no lifecycle change | SOFTWARE-COMPLETE |
| A-06 | `resume_run` | Legal states, remaining blocker, fencing and idempotent retry | SOFTWARE-COMPLETE |
| A-07 | `list_artifacts` | Revision/stage/staleness filters and complete artifact metadata | SOFTWARE-COMPLETE |
| A-08 | `inspect_evidence` | Revision/evidence/stage/staleness filters, deterministic root and non-pass preservation | SOFTWARE-COMPLETE |
| A-09 | `rerun_stage` | New attempt/branch, invalidation, no overwrite, stale-writer rejection | SOFTWARE-COMPLETE |
| A-10 | `export_candidate_bundle` | Completed-head gate, exact inventory/label/lifecycle/integrity and no state promotion | SOFTWARE-COMPLETE |
| A-11 | `export_prototype_bundle` | Completed-head gate, prior exact qualification, negative cases, label and no release | SOFTWARE-COMPLETE |
| A-12 | `generate_bringup_plan` | Exact revision binding, guarded steps, no synthetic physical pass | SOFTWARE-COMPLETE |
| A-13 | `generate_firmware_scaffold` | Exact current-revision committed firmware artifacts/reports are replayed byte-for-byte; absent/language-mismatched outputs fail closed; run/project heads do not move | SOFTWARE-COMPLETE |
| A-14 | Every public result identifies project, revision, stage, exact inputs, tool, validation, assumptions and lifecycle | Shared-envelope schema tests for success from all operations | SOFTWARE-COMPLETE |
| A-15 | Errors have stable code/message/retryable/details semantics on REST and MCP | Table-driven transport conformance tests for every domain code | SOFTWARE-COMPLETE |
| A-16 | Missing/ambiguous/unavailable/unsupported/stale/violating/insufficient inputs produce blocked stages, not guesses | End-to-end deliberate failure suite | SOFTWARE-COMPLETE |
| A-17 | Local-human `submit_external_evidence` remains absent from MCP, verifies/stores bounded source bytes under the strict bring-up/acceptance/measurement/as-built/flash v2 contracts, binds canonical current-head BOM/CAM/build/procedure artifacts, and derives all seven verdict categories into `human_physical` v3 | Positive/adversarial schema, service, result-schema, and REST tests; physical truth remains external | SOFTWARE-COMPLETE |
| A-18 | Local-human `qualify_revision` requires exact requirements/revision/evidence roots plus a current passing derived `human_physical` v3 record backed by the strict physical-acceptance and measurement v2 contracts | Positive/negative service tests including failed and expired observations, credential gate and UI request mapping | SOFTWARE-COMPLETE |
| A-19 | Local-human `authorize_manufacturing_release` remains separate and requires exact qualification plus the same current passing derived `human_physical` v3 evidence | Derived-record policy tests and absence from MCP; real acceptance remains human-only | SOFTWARE-COMPLETE |
| A-20 | Local-human `revoke_attestation` is append-only and immediately changes derived lifecycle | Qualification/release revocation integration test | SOFTWARE-COMPLETE |
| A-21 | Human routes require exact Origin and distinct role-scoped in-memory credentials bound to immutable configured actors; body actor is never authority | REST cross-role/spoofing/zero-mutation tests, startup strength/deletion tests, and component-memory UI header test | SOFTWARE-COMPLETE |
| A-22 | `inspect_engineering_practices` | Exact-revision native-DRC/EvlEDA-practice separation, source and complete-coverage projection, external gates, bounded finding pagination, REST/MCP schema parity, and no lifecycle authority | SOFTWARE-COMPLETE |

## Identity, evidence, and reproducibility

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| E-01 | Artifact bytes use SHA-256 plus byte size | Known-vector, corruption and read-after-write tests | SOFTWARE-COMPLETE |
| E-02 | Structured identities use deterministic recursively key-sorted JSON with explicit schema/canonicalization versions | Cross-order vectors, invalid-value tests and independent fixture | SOFTWARE-COMPLETE |
| E-03 | Manifest is a dependency graph, not a flat checksum list | Graph schema and traversal/freshness tests | SOFTWARE-COMPLETE |
| E-04 | Evidence classes remain `agent_claim`, `evleda_check`, `kicad_native`, `human_physical` | Schema/serialization tests and reference evidence set | SOFTWARE-COMPLETE |
| E-05 | Hash claims never imply correctness/safety/provenance/certification | UI/bundle wording review and policy tests | SOFTWARE-COMPLETE |
| E-06 | Exact replay uses frozen captured inputs and never calls the model again | Model-spy replay integration test and byte equality | SOFTWARE-COMPLETE |
| E-07 | Canonical KiCad replay is byte-identical without normalizing generated source fields | Two self-contained seeded replays plus exact PCB/project/report equality and mutation-negative tests | SOFTWARE-COMPLETE |
| E-08 | Live model/research regeneration is labeled traceable, not reproducible, with the exact `evleda.live-regeneration-policy.v1` identity in the ordered current-bundle inputs | Strict result/manifest/replay schema matrix plus producer, durable-replay, API/MCP, and standalone-verifier adversarial tests reject missing, extra, or reproducible relabeling | SOFTWARE-COMPLETE |
| E-09 | Tool/library/policy/template/locale/time/seed/model settings are explicit inputs | Manifest fixture and missing-input gate tests | SOFTWARE-COMPLETE |
| E-10 | No deterministic KiCad-export claim before isolated two-run equality for the pinned version | The writer creates two fresh targets, issues independent challenges, and verifies distinct, disjoint host-generated run receipts that bind UUIDs/nonces, exact commands and transcripts, tool/source/input/output identities, and zero-finding native evidence; same-root, copied, preexisting/fabricated, minimal, and tampered cases fail closed | SOFTWARE-COMPLETE |
| E-11 | Physical acceptance, measurement, as-built, flash, and bring-up inputs use strict v2 contracts; new qualification-eligible derived `human_physical` evidence uses strict v3 while legacy physical v2 remains replay/audit-only | Contract and service tests cover procedure-case derivation, exact bindings, version rejection, legacy replay, failed categories, expiry, and candidate-only lifecycle | SOFTWARE-COMPLETE |

## KiCad and bundle verification

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| K-01 | KiCad 10.x native files are source of truth | Reference artifacts open in the identity-bound supported KiCad 10.x build; adapter does not replace semantics | SOFTWARE-COMPLETE |
| K-02 | KiCad-MCP sidecar is pinned, allowlisted, confined, timed and schema validated | Hash/provenance preflight plus real and adversarial sidecar adapter tests for discovery, pagination, paths, modes, forbidden tools, schemas, stderr, timeout and cleanup | SOFTWARE-COMPLETE |
| K-03 | Native ERC/DRC/render/netlist/BOM/Gerber/drill/position results record exact executable identity | Isolated native integration test inspects invocation/evidence records | SOFTWARE-COMPLETE |
| K-04 | DRC evidence includes schematic/board parity | Deliberate parity mismatch test | SOFTWARE-COMPLETE |
| K-05 | Validation uses an isolated copy and separate initially empty output directory | Test snapshots canonical hashes before/after success and forced failure | SOFTWARE-COMPLETE |
| K-06 | Tool error, unknown result, warning ambiguity, timeout, stale source, malformed report or missing executable blocks | Integration fixtures cover process/schema/report/staleness/timeout failure classes | SOFTWARE-COMPLETE |
| K-07 | Complete bundle includes editable KiCad, reports, BOM, Gerbers, drills, positions, renders, firmware and bring-up docs | Reference bundle exact-inventory test | SOFTWARE-COMPLETE |
| K-08 | Current `evleda.bundle-manifest.v3` with `evleda.bundle-export-replay.v2` and `deterministic-zip-v3` binds complete per-entry provenance, independently recomputable revision/evidence roots, and the exact live-regeneration policy dependency; original unlabeled manifest-v2/replay-v1 data remains byte-for-byte replayable without inferred policy, while crossed/hybrid versions fail closed | Current/legacy schema matrix, durable restart replay with zero mutation, producer/API/MCP integration, canonical vectors, explicit legacy-v2 verifier downgrade, and semantic-tamper tests | SOFTWARE-COMPLETE |
| K-09 | Bundle verifier rejects traversal, links, duplicates/case collisions, mixed IDs, missing/extra files, digest/size mismatch, root mismatch, and provenance-graph mismatch | 35/35 standalone verifier adversarial cases | SOFTWARE-COMPLETE |
| K-10 | Bundle verifier is read-only and makes no lifecycle/safety claim | Source review and before/after filesystem snapshot | SOFTWARE-COMPLETE |
| K-11 | Native KiCad DRC authority and EvlEDA PCB-engineering-practice analysis remain separate, independently identified checks; neither substitutes for the other and external engineering gates remain distinct | Analyzer/workflow/inspection, application, REST/MCP, UI parser/component, and Playwright tests cover exact-board binding, complete machine-rule coverage, missing/stale/fail/review states, and bounded findings | SOFTWARE-COMPLETE |

## Required software test campaign

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| T-01 | Unit-test requirement parsing and constraint extraction | Boundary and ambiguity test suite | SOFTWARE-COMPLETE |
| T-02 | Unit-test canonical design identities and evidence manifests | Known vectors and bound manifest fixtures | SOFTWARE-COMPLETE |
| T-03 | Unit-test stage transitions and stale-state rejection | Exhaustive 98-pair run/attempt transition matrix plus durable aggregate-invariant, resurrection/history-replacement, and rejected-transaction zero-mutation tests | SOFTWARE-COMPLETE |
| T-04 | Test deterministic regeneration from same prompt, pinned library, settings and tools | Independently receipted isolated runs plus writer, Python-validator, and TypeScript-validator adversarial comparisons | SOFTWARE-COMPLETE |
| T-05 | Deliberate ambiguous-voltage failure | Durable blocker/no-downstream test | SOFTWARE-COMPLETE |
| T-06 | Deliberate impossible-current-budget failure | Durable blocker/no-downstream test | SOFTWARE-COMPLETE |
| T-07 | Deliberate unavailable-footprint failure | Durable blocker/no-downstream test | SOFTWARE-COMPLETE |
| T-08 | Deliberate conflicting-pin-assignment failure | Durable blocker/no-downstream test | SOFTWARE-COMPLETE |
| T-09 | Deliberate unsupported-KiCad-syntax failure | Durable blocker/source-preservation test | SOFTWARE-COMPLETE |
| T-10 | Deliberate stale-source-revision failure | Revision-conflict/no-commit test | SOFTWARE-COMPLETE |
| T-11 | Deliberate ERC/DRC failure | Bound native failure/no-export test | SOFTWARE-COMPLETE |
| T-12 | KiCad CLI integration runs on isolated copies and proves source preservation | Identity-bound KiCad 10 integration output on supported OS | SOFTWARE-COMPLETE |
| T-13 | Generated firmware contract validates against schematic and pin map | Reference positive and deliberate mismatch tests | SOFTWARE-COMPLETE |
| T-14 | Complete output-bundle validation covers every required artifact category | Exact inventory, digest and semantic checks | SOFTWARE-COMPLETE |
| T-15 | Full local software check runs documentation, current/legacy bundle verification, typecheck, unit/integration tests, build and exported-bundle integration | Settled 2026-09-05 `node scripts/check.mjs`: 65/65 test files, 929 pass, 1 skip, 1 todo, 35/35 verifier adversarial cases, and 92-module production build | SOFTWARE-COMPLETE |
| T-16 | Least-privilege CI pins actions/tools and runs the full software check with a frozen lockfile | Reviewed workflow plus a successful GitHub Actions run for the exact commit | UNVERIFIED |
| T-17 | Identity-bound STM32G0B1 Cortex-M0+ cross-build emits deterministic candidate-only ELF, BIN and map from a bounded exact private toolchain closure with LTO/linker plugins disabled and no flash or release authority | Real Arm GNU 14.2.Rel1 private-closure positive/two-run equality plus wrong-tool, version, digest, helper, alias, closure-budget, plugin, memory, and safe-init regressions | SOFTWARE-COMPLETE |

## Physical reference-board acceptance

These rows cannot be closed by generated documents, simulation, CI, a model, or
an unbuilt KiCad design.

| ID | Requirement | Authoritative acceptance evidence | Current status |
| --- | --- | --- | --- |
| H-01 | Fabricate and assemble one exact reference-controller revision | Fabrication/assembly records bound to design/CAM/BOM root, substitutions and lot | HARDWARE/HUMAN-ONLY |
| H-02 | Electrically bring up that exact board under the approved procedure | Operator record, board serial, firmware hash, procedure version, instruments/calibration and raw data | HARDWARE/HUMAN-ONLY |
| H-03 | Measure all regulated power rails across required conditions | Raw calibrated measurements, limits and verdict | HARDWARE/HUMAN-ONLY |
| H-04 | Verify programming/debug operation and board-revision identification | Raw session/log measurements bound to board/firmware | HARDWARE/HUMAN-ONLY |
| H-05 | Verify supported communications | Per-interface raw data and limits bound to board/firmware | HARDWARE/HUMAN-ONLY |
| H-06 | Verify sensor/encoder inputs | Stimulus/response data and limits | HARDWARE/HUMAN-ONLY |
| H-07 | Verify both actuator outputs and current-chop behavior | Guarded-load traces, current/voltage data and limits | HARDWARE/HUMAN-ONLY |
| H-08 | Verify thermal behavior at declared RMS load and environment | Instrumented temperature/current/time/environment data and limits | HARDWARE/HUMAN-ONLY |
| H-09 | Verify fault and reset paths, including safe disable | Controlled fault stimuli, observed outputs and abort record | HARDWARE/HUMAN-ONLY |
| H-10 | Human qualifier attests to exact manifest/evidence root and scope | Non-revoked capability-backed qualification record | HARDWARE/HUMAN-ONLY |
| H-11 | Passing unit is claimed only for that revision/conditions, not arbitrary designs | Qualification wording and scope review | HARDWARE/HUMAN-ONLY |
| H-12 | No production-yield, regulatory, safety or platform-wide claim is made | Independent human release-package review | HARDWARE/HUMAN-ONLY |

## Completion rule

EvlEDA v0 is not accepted merely because CI is green or a candidate bundle
exists. Software acceptance requires every nonphysical product-contract row to
be SOFTWARE-COMPLETE with direct evidence in the intended environment. Practical
reference acceptance additionally requires H-01 through H-11 for one exact
reference revision. Manufacturing release remains a separate human-controlled
decision and is not an autonomous completion step.
