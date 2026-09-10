# EvlEDA v0 product contract

This document states both the intended product boundary and what the current software actually proves. A required invariant is not described as verified unless its producer paths and failure cases are covered.

## Product goal and current design envelope

EvlEDA's broad goal is an AI-assisted, evidence-bound workflow that turns requirements into reviewable PCB candidate proposals and subjects them to deterministic, native-tool, and human gates. v0 does not generate arbitrary validated topologies, autonomously qualify hardware, or authorize manufacturing release.

The current `EVL-RC-G0-REV-A` design is a constrained full-stack proof fixture: a 7-16.8 V DC, two-channel brushed-motor controller limited by policy to 0.5 A RMS per channel and a 1 A current-chop target. Template reuse preserves its exact native source, component and library set, six-layer 1+4+1 HDI stack, and interface, pin, resource, protocol, rail, and layout contracts. Structural changes or wider electrical limits require a separately reviewed profile and native design.

Rev-A is deliberately expected-negative, not a compliant reference or known-good production template. Native KiCad DRC can pass while the separate EvlEDA engineering-practice analyzer reports blocking `ROUTE_STYLE` and `BACKTRACK` findings. Its inspection status is therefore `BLOCKED_DIAGNOSTIC`. This coexistence demonstrates fail-closed orchestration; it does not establish that the PCB is qualified, manufacturable, or safe.

Requests with ambiguous supply voltage, missing load current, unsupported interfaces, unknown footprints, incomplete evidence, or out-of-profile requirements stop rather than inventing an assumption.

## Workflow and shared operations

The workflow has nine stages:

1. `requirements`
2. `system_architecture`
3. `component_selection`
4. `schematic`
5. `firmware_contract`
6. `simulation_checks`
7. `pcb_placement_routing`
8. `manufacturing_package`
9. `bringup_package`

REST and MCP expose the same fourteen application operations. The fourteenth, read-only `inspect_engineering_practices`, projects native DRC and EvlEDA-practice results as separate channels, including rule coverage, findings, advisories, and unresolved external gates. It grants no lifecycle or manufacturing authority.

The required publication invariant is that a stage begins from an immutable input manifest and only a complete attempt becomes current; incomplete artifacts or evidence must never be partially published. W-03's software transaction, multi-output fault-injection, and recovery coverage is complete. Durable file-lock admission is explicitly supported only on Windows, Linux, macOS, and FreeBSD. Those platforms bind a lock owner to both PID and an OS process-start identity; AIX, Solaris, and other hosts fail with `TOOLCHAIN_UNSUPPORTED` before a claim or helper process is created.

A rerun appends an attempt and creates a new revision branch; it does not overwrite history.

## Independent state and authority axes

- **Run execution:** `queued`, `running`, `waiting_requirements_approval`, `blocked`, `interrupted`, `completed`, or `cancelled`.
- **Stage-attempt execution:** `pending`, `running`, `waiting_approval`, `blocked`, `interrupted`, `succeeded`, or `stale`.
- **Evidence:** `pass`, `fail`, `error`, `not_run`, `unsupported`, `stale`, `revoked`, or `waived`.
- **Lifecycle:** `candidate`, `qualified`, or `release_authorized`.

Stage success changes execution state only. Automated checks attach evidence only. Neither action qualifies or releases a design. Human-only attestations bind the exact design manifest, evidence root, policy, actor, scope, rationale, and time; they do not carry to a changed revision.

## Evidence, native tools, and invocation records

Artifact-byte and structured identities use `algorithm: "sha256"`. Structured identities hash deterministic, recursively key-sorted JSON and carry `canonicalizationVersion: "evleda-c14n-json-v1"` plus an explicit schema version. The revision manifest is a dependency graph, and hashes prove identity rather than truth, safety, provenance authenticity, or certification.

Evidence classes remain distinct: `agent_claim`, `evleda_check`, `kicad_native`, and `human_physical`. KiCad 10.x native files are the EDA source of truth. Native KiCad DRC is authoritative only for its rule deck; an EvlEDA-practice `FAIL`, `UNKNOWN`, or `NOT_RUN` remains independently blocking. Validation uses an isolated source copy and separate output directory. Tool errors, ambiguous results, timeouts, stale sources, malformed reports, or missing executables block rather than pass.

W-08 remains unverified. `ToolInvocationRecord` and `state.invocations` are schema-reserved, but application workflows have no writer for the first-class invocation ledger. Command details embedded in bound reports are not a substitute for that ledger.

## Design-agent proposal boundary

The reviewed Phase-A design-agent work defines an authenticated trust boundary and a reviewed architecture IR. Live output is strictly `proposal_only`, `agent_claim`, `authorityDisposition: "none"`, and `validationDisposition: "not_evaluated"`; untrusted narrative is display-and-audit-only. A proposal cannot mutate a revision, establish a pass, claim native-tool success, qualify hardware, or authorize manufacture or release.

This subsystem is not yet composed into the application or factory, exposed through REST or MCP, surfaced in a UI, or backed by a default provider. Standalone production composition requires constructor-injected `authenticated_production` trust storage and `durable_append_only_production` replay-receipt storage; callers cannot supply or replace trust anchors and cannot replace stored receipts. A frozen `evleda.design-agent-replay.v2` is admitted only when its exact input and resolved `evleda.design-agent-replay-receipt.v1` binding match, then returns the captured proposal without another provider call. The reviewed subsystem alone is not an integrated product capability.

## Candidate and prototype bundles

A candidate bundle has `bundleKind: "candidate"`, lifecycle `candidate`, and warning exactly `CANDIDATE — NOT FOR MANUFACTURING`. A prototype bundle requires a human qualification attestation for the exact manifest, has `bundleKind: "prototype"`, lifecycle `qualified`, and warning exactly `PROTOTYPE — NOT PRODUCTION RELEASED`; its cover additionally states exactly `CONTROLLED PROTOTYPE ONLY`, and it authorizes only a controlled prototype build. Export never changes lifecycle state.

Fresh exports use `evleda.bundle-manifest.v3`, the `deterministic-zip-v3` capability profile, and durable `evleda.bundle-export-replay.v2` receipts. Both the result and manifest carry exactly `{ scope: "live_model_or_research", claim: "traceable", reproducible: false }` and its recomputed `evleda.live-regeneration-policy.v1` identity. Current generated artifacts bind the ordered revision-manifest, evidence-root, and policy-identity inputs and use policy-bound deterministic IDs. Standalone current-v3 verification returns `provenance_roots` assurance.

Exact historical pre-E-08 exports remain replayable only as the original unlabeled `evleda.bundle-manifest.v2`/`evleda.bundle-export-replay.v1` pair, unchanged, preserving `deterministic-zip-v2`, and without a synthesized policy. A labeled v2, a crossed receipt/manifest version, or any hybrid fails closed. Standalone manifest-v2 verification requires `--allow-legacy-v2` and returns `provenance_roots_without_live_policy` assurance. `evleda.bundle-manifest.v1` remains available only through `--allow-legacy-v1` and returns `byte_integrity_only` assurance.

Fresh export reevaluates current gates. Same-key, byte-equivalent durable replay returns the previously committed result and ZIP without rebuilding or reevaluating current head, evidence, or qualification gates.

## Reproducibility claim

EvlEDA distinguishes byte-reproducible replay for controlled canonical artifacts, semantic equivalence for supported normalized KiCad content, and traceable but non-reproducible live model or research regeneration. Exact replay never calls a model again. Tool versions, libraries, policy, templates, locale, time source, and seeds are inputs. No general claim of deterministic KiCad export is made without pinned-version equality evidence.

## Firmware boundary

Firmware artifacts bind an exact, private dependency closure rather than an open-ended package range or an assumed public registry state. A reproducible build requires every referenced source, toolchain, configuration, lock, and dependency identity to be available under that closure. Firmware output remains candidate evidence only; build success cannot qualify the board, authorize flashing, or grant release authority.

## Physical acceptance boundary

The qualification-eligible physical chain uses `evleda.bringup-plan.v2`, `evleda.physical-acceptance.v2`, `evleda.physical-measurements.v2`, `evleda.as-built-record.v2`, `evleda.firmware-flash-record.v2`, `evleda.instrument-calibration.v1`, and the enclosing `evleda.human-physical-evidence.v3`; their validation paths are implemented. Earlier schema variants remain inspectable or exactly replayable where supported but cannot newly qualify or release hardware. Current records bind the exact revision/evidence roots, BOM and CAM identities, firmware build and flashed binary, as-built records, procedures, measurements, calibration, board and lot, substitutions, operator, environment, and raw sources across all seven physical-evidence categories.

Production policy is still incomplete, and no current Rev-A record is qualified or release-authorized. Implemented schemas and validators do not mean that a board was fabricated, tested, safe, production-ready, or compliant. Even one passing unit would qualify only its exact revision under its tested conditions; it would not establish yield, regulatory compliance, or general platform correctness.

Manufacturing release remains a separate human operation and is unreachable without exact qualifying physical evidence and an explicit release attestation.
