# EvlEDA

The current additive MCP/skills toolbox is documented in [docs/toolbox.md](docs/toolbox.md).
`pnpm mcp:toolbox` serves the verified research guides directly; CAD operations
are exposed when an owning host supplies an already-bound project/session.
The standalone command does not yet create that native binding. The older MCP,
runner, Flux UI and broader application described below are preserved.

For the candidate-only local Flux workspace, see [docs/flux-local.md](docs/flux-local.md).

Fresh Flux runs allow 1–24 authoring iterations, with 12 recommended and used
by default. The cap is bound by each new run's approval and does not guarantee
success; consumed runs cannot gain more attempts through a policy update.
Standalone copied-board limits remain 1–5/default 3. See the
[iteration and resource budget policy](docs/flux-local.md#iteration-budgets-and-approval)
for standalone fresh defaults, message/byte limits, and unchanged timeouts.

EvlEDA's broad product goal is a
local-first agentic hardware-development application: turn requirements into
evidence-bound review candidates. It coordinates architecture, component
selection, KiCad sources and checks, firmware contracts, manufacturing
outputs, and bring-up documentation without treating generated output as proof.

The implementation is intentionally narrower than that goal. EvlEDA v0 can
parameterize and replay the reviewed `EVL-RC-G0-REV-A` topology only within its
7-16.8 V, two-channel, at-most-0.5 A RMS-per-channel envelope. It does not yet
generate arbitrary hardware topology. A wider envelope or structural change
requires a separately reviewed immutable profile and native design.

Autonomous work can reach `candidate` only. A model statement, clean native
ERC/DRC, route closure, generated CAM, or successful firmware build does not make
a design safe, fabricated, certified, qualified, flashable, production-ready, or
released. Qualification and manufacturing release are distinct human
attestations bound to exact immutable identities and real evidence.

## Implemented workflow

```text
React operator console ─┐
REST /v1 API ───────────┼── application commands ── nine-stage workflow
EvlEDA MCP server ──────┘             │                    │
                                      │                    ├─ policy gates
                                      │                    ├─ constrained tools
                                      │                    └─ evidence projection
                            durable records + content-addressed artifacts
                                                    │
                              pinned KiCad MCP sidecar / KiCad 10 CLI
```

REST and MCP expose the same 14 public workflow operations, including
`inspect_engineering_practices`. Human-only authority remains unavailable to the
agent-facing MCP process. KiCad remains authoritative for native project
semantics, ERC/DRC, rendering, and exports; EvlEDA owns orchestration, typed
transformations, traceability, evidence freshness, and lifecycle policy.

The repository also contains isolated Phase-A agent scaffolding and architecture
IR: role contracts, production-host prerequisites, an authenticated provider
boundary, durable frozen replay receipts, mandatory deterministic validators,
and a system-architecture IR/compiler. That subsystem is not wired into the
application factory/service, REST, MCP, or React UI, and production composition
has no default live provider. It is implemented and tested infrastructure, not
an active agent-driven design path.

## Honest reference-design status

The canonical six-layer Rev-A source opens cleanly and has source-bound native
results with zero ERC, DRC, schematic-parity, and route-closure findings. Native
cleanliness and EvlEDA's route-practice policy are separate checks, however.
Rev-A is deliberately retained as an expected-negative BLOCKED_DIAGNOSTIC proof fixture
for the hard `ROUTE_STYLE` and `BACKTRACK` rules. Its plan records
`expected_negative`; until bound analyzer evidence proves compliant regenerated
geometry, engineering-practice inspection must report `BLOCKED_DIAGNOSTIC`, not
`PROVISIONAL_POC`, manufacture-ready, or release status.

The normal production workflow is independently blocked earlier at component
selection because the captured buck source is unavailable and all eight pin/pad
reviews remain pending. A clean native board does not waive either boundary.
See [the current handoff](HANDOFF.md), the
[reference-design details](reference-designs/robotics-controller-v0/README.md),
and the [PCB engineering-practice contract](docs/pcb-engineering-practices.md).

## Reproducibility and durable-state boundaries

Current exports use `evleda.bundle-manifest.v3`,
`evleda.bundle-export-replay.v2`, and the `deterministic-zip-v3` tool profile.
The manifest, result, and every bundle-generated artifact bind the canonical
`evleda.live-regeneration-policy.v1` identity as an exact input. Live model or
research regeneration is labeled traceable and non-reproducible.

Original unlabeled `evleda.bundle-manifest.v2` manifests and their
`evleda.bundle-export-replay.v1` envelopes remain exact legacy data: they keep
the `deterministic-zip-v2` two-input contract and are never relabeled or given a
synthesized policy. The standalone verifier rejects them by default; explicit
`--allow-legacy-v2` verification recomputes provenance roots but returns the
downgraded `provenance_roots_without_live_policy` assurance. Legacy
`evleda.bundle-manifest.v1` remains a separate explicit byte-integrity-only mode.

Acceptance row W-03 is software-complete: fault injection covers every content
commit boundary and proves partial stage artifacts/evidence never become current.
One P2 lock-hardening `it.todo` test remains for recycled live-PID and
process-incarnation handling; it does not reopen the atomic-publication result.
W-08 is unverified: native KiCad and firmware report artifacts embed invocation
details and identities, but no production application writer populates the
state schema's reserved `ToolInvocationRecord` map. Embedded report evidence is
not a durable first-class invocation ledger.

## Physical and firmware boundaries

The software implements strict `evleda.physical-acceptance.v2`,
`evleda.physical-measurements.v2`, and `evleda.human-physical-evidence.v3`
contracts and exercises their qualification/release gates with test fixtures.
The canonical Rev-A repository has no real built-board acceptance record,
hardware qualification, or manufacturing release. Software fixtures cannot
supply those facts.

The real STM32G0 cross-build snapshots the pinned Arm GNU toolchain and CMSIS
support closure, executes from a verified private workspace with bounded inputs,
and emits identity-bound ELF/BIN/map outputs. Those outputs remain
`compiled-non-flashable-candidate`, with `flashable: false` and no release
authority.

## Development

Requires Node.js 24.19 or newer, pnpm, and KiCad 10.x for native integration.
The optional real KiCad-MCP smoke setup is documented in
[the sidecar verification guide](docs/kicad-mcp-sidecar.md); the identity-bound
STM32G0 cross-build is documented in
[the firmware toolchain guide](docs/firmware-toolchain.md). The 1,773-rule,
17-dossier engineering corpus is a manifest-bound application resource; its
module-relative loading, identity, packaging, and update procedure are in the
[deep-rule resource guide](docs/deep-rule-resources.md).

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
```

Runtime state defaults to a local application-data directory and should not live
in the synced source tree. See [the product contract](docs/product-contract.md)
for normative safety and evidence boundaries.

## Verified matrix (2026-09-05)

The latest local verification used Node 24.19.0 and the explicit pinned tool
paths described in `HANDOFF.md`. Targeted rows overlap and must not be added
together.

- Full `node scripts/check.mjs`: 65/65 test files, 929 passed, 1 skip
  (intentional), 1 todo, and 0 failures.
- UI TypeScript: passed; UI Vitest: 10/10 files and 33/33 tests passed.
- Installed-Chrome Playwright: 5/5 passed.
- Real KiCad/reference suites: 4/4 files and 76/76 tests passed.
- Firmware validation: 32 passed and 1 intentional host-compiler skip because
  `EVLEDA_FIRMWARE_CC` was unset; the real Arm cross-build ran and passed.
- Audited `kicad-mcp`: 5/5 passed.
- Evidence and bundle suites: 3/3 files and 43/43 tests passed; standalone
  bundle adversarial verification: 35/35 passed.
- Production build: passed, 92 modules transformed.

These results do not substitute for GitHub CI, fabrication, bench evidence,
qualification, safety review, or release.
