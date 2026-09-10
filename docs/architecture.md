# EvlEDA v0 architecture

This document describes the implementation boundary for EvlEDA v0. The [product
contract](product-contract.md) is normative when this document and an
implementation detail disagree. The product goal is an AI-assisted,
evidence-bound workflow for turning requirements into reviewable PCB proposals.
The current v0 implementation proves that workflow only within a narrow
prototype envelope; it does not yet generate arbitrary validated topologies and
is not an autonomous product-release system. The retained Rev-A design is an
expected-negative full-stack proof fixture, not a compliant known-good template:
native KiCad DRC can pass while separate EvlEDA engineering-practice checks
correctly block it.

## System context

```text
                              local machine

  React operator UI ─┐
  REST /api/v1 ──────┼─> application command layer ─> workflow coordinator
  EvlEDA MCP server ─┘              │                        │
                                    │                        ├─ stage workers
                                    │                        ├─ policy gates
                                    │                        └─ tool adapters
                                    │                                  │
                         atomic state + content store         ┌────────┴────────┐
                                                              │                 │
                                                    KiCad-MCP sidecar      KiCad 10 CLI
                                                    bounded edits/read     isolated checks
```

All v0 services bind to loopback by default and operate on local files. For the
fourteen shared operations, REST and MCP are adapters over the same application
commands; neither transport may implement a weaker policy path. Supplemental
attestation commands exist only on local REST and reuse the same policy/service
core. The UI is an operator console, not an authority boundary. Human approvals
are capabilities supplied through an exact-Origin, credential-verified local
REST interaction, never inferred from a button label, model text, body
actor/role, or MCP caller.

## Component responsibilities

| Component | Owns | Must not own or infer |
| --- | --- | --- |
| Application command layer | Request validation, idempotency, optimistic revision checks, stable errors, transport-neutral results | KiCad file semantics; human authority |
| Workflow coordinator | Stage dependencies, attempts, immutable input manifests, atomic commits, blocking/resume, revision branches | Electrical truth; lifecycle promotion from a successful stage |
| Specialist stage workers | Typed proposals and artifacts for one bounded stage | Cross-stage policy bypasses; direct release decisions |
| Optional Phase-A design-agent coordinator | Strict proposal-only model output, authenticated host-selected trust manifests, frozen replay receipts, and a reviewed architecture-IR handoff | Application mutation, validation evidence, lifecycle authority, or an implicit live provider |
| Policy engine | Supported-envelope gates, requirement approval, evidence freshness, export policy, lifecycle derivation | Safety certification or unrecorded exceptions |
| Content store | SHA-256-addressed immutable bytes and integrity verification | The truth of a claim represented by those bytes |
| State store | Projects, runs, attempts, revisions, approvals, artifact/evidence records, idempotency results, and a schema-reserved invocation collection | Large artifact bytes; mutable replacement of history; inventing invocation records that no application producer wrote |
| KiCad-MCP adapter | Allowlisted, schema-validated, bounded sidecar calls | Unrestricted tool passthrough to REST/MCP clients |
| KiCad CLI adapter | Isolated native validation, reports, renders, and exports | In-place validation of canonical source |
| Bundle exporter | Deterministic review/prototype package assembly and manifest generation | Qualification or manufacturing release |

## Current constrained v0 hardware envelope

The current proof profile is a non-safety-rated, low-voltage prototype robotics
controller envelope with:

- 7–16.8 V DC input;
- two brushed-DC motor channels;
- no more than 0.5 A RMS per channel;
- a 1 A current-chop target; and
- profile-declared MCU, regulated rails, programming/debug access, protection,
  fault handling, configuration, status, and supported communication/sensor
  interfaces.

The profile is not a battery charger or BMS, a motor safety controller, a
human-carrying controller, a medical device, a mains product, or a certified
protective function. “Profile-declared” is deliberate: mentioning USB, CAN,
UART, I²C, SPI, encoders, sensors, or actuators in the broad product vision does
not make every electrical variant supported. A request outside the pinned
profile, or one with an unknown footprint, ambiguous input voltage, missing load
current, or incomplete source evidence, blocks rather than broadens the envelope.

Within that envelope, parameterization is constrained source reuse, not
arbitrary topology generation. A request may narrow the input range to endpoints
inside 7–16.8 V and lower the positive per-channel RMS limit to at most 0.5 A.
It may exercise the exact Rev-A native design only while the profile family, board
revision, two channels, 1 A chop circuit, component/MPN/package/symbol/footprint
set, six-layer 1+4+1 HDI stack, interfaces, pins, resources, protocols, rail contracts,
and layout constraints remain canonical and identical. Any wider envelope or
structural difference requires another reviewed profile and native design. This
reuse is an expected-negative orchestration test: it does not make Rev-A a
passing PCB, qualified hardware, or a production reference.

## Domain model and identity

The durable roots are `Project`, `DesignRun`, and `DesignRevision`.

- A project supplies a confined working root and policy version.
- A run binds the source prompt, workflow/configuration identity, stage-attempt
  history, and current head revision.
- A stage attempt binds one immutable input manifest. The required invariant is
  that a successful attempt commits all of its state references for artifacts
  and evidence atomically and that partial output is never current.
- A rerun appends an attempt and creates a revision branch. It never edits or
  erases an earlier attempt or revision.
- Tool-invocation records are designed to retain canonical argument identity,
  input digests, executable identity, outcome, and captured stdout/stderr
  identities. The durable collection and type exist, but application write
  paths do not populate them; W-08 therefore remains unverified.

W-03's atomic-publication implementation and commit-boundary fault coverage are
software-complete under the current matrix. Exclusive file locks bind PID plus
an OS process-start identity on Windows, Linux, macOS, and FreeBSD. AIX,
Solaris, and unknown platforms are explicitly unsupported and reject lock
admission before helper execution or claim creation. Statements in this
document marked as requirements remain invariants even where their verification
status is incomplete.

Artifact bytes use a `ContentIdentity`:

```json
{ "algorithm": "sha256", "digest": "64 lowercase hex characters", "size": 123 }
```

Structured values use recursively key-sorted JSON, reject non-finite numbers and
non-JSON values, normalize negative zero to zero, and bind both the schema and
canonicalization versions:

```json
{
  "algorithm": "sha256",
  "digest": "64 lowercase hex characters",
  "schemaVersion": "evleda.example.v1",
  "canonicalizationVersion": "evleda-c14n-json-v1"
}
```

An evidence manifest is a dependency graph. Artifact and evidence records carry
project, run, revision, stage, exact input identities, tool identity, validation
status, unresolved assumptions, and lifecycle. `derivedFrom`, subject digests,
and raw/parsed report edges preserve how a claim was obtained. Four evidence
classes remain distinct:

1. `agent_claim` — a model or specialist assertion;
2. `evleda_check` — a deterministic EvlEDA rule or parity check;
3. `kicad_native` — output produced by an identified KiCad executable; and
4. `human_physical` — a human-recorded inspection or physical measurement.

Hashes bind bytes; they do not prove correctness, provenance authenticity,
electrical safety, certification, or that a physical measurement was competently
performed.

## Workflow and stage contracts

The coordinator presents nine stages in order, while storing dependencies
explicitly:

| Stage | Required product | Typical blocking conditions |
| --- | --- | --- |
| `requirements` | Source-linked requirements, constraints, exclusions, acceptance criteria, unresolved assumptions | Ambiguous voltage/current/channel count; unsupported use; approval absent |
| `system_architecture` | Power/signal/fault architecture and requirement allocation | Missing power budget; unsafe or unsupported topology |
| `component_selection` | Pinned parts, symbols, footprints, datasheet identities, limits, lifecycle/sourcing evidence | Missing datasheet; unavailable part; unknown footprint; live claim not captured |
| `schematic` | Editable KiCad schematic plus connectivity/power intent | Unsupported KiCad construct; conflicting pins; missing reference circuit evidence |
| `firmware_contract` | Pin/resource map and generated interface contract | Pin, timer, DMA, interrupt, voltage-domain, reset, or revision-ID conflict |
| `simulation_checks` | Applicable models, assumptions, results, unsupported-coverage statements | Model absent or insufficient; parity or electrical rule failure |
| `pcb_placement_routing` | Editable board, placement/routing constraints, connectivity/geometry reports | Unrouted nets; native clearance/geometry violation; failed, unknown, or not-run EvlEDA engineering-practice rule; stale schematic parity |
| `manufacturing_package` | BOM, sourcing evidence, assembly data, Gerbers, drills, position data, renders and native reports | Stale source; failed ERC/DRC or engineering-practice check; malformed/missing export; bundle mismatch |
| `bringup_package` | Bring-up firmware/tests, pin maps, guarded procedures and expected limits | Incomplete fault/reset procedure; firmware/schematic mismatch; physical step presented as completed |

Each specialist receives only the frozen stage inputs and an allowlisted tool set.
The coordinator validates the returned schema and identities, runs deterministic
checks, and either commits the complete attempt or records explicit blockers.
Warnings are not silently converted to passes.

`inspect_engineering_practices` is the fourteenth shared REST/MCP operation. It
projects native KiCad DRC (`kicad_native`) and the source-bound EvlEDA practice
analyzer (`evleda_check`) as separate channels, along with rule coverage,
blocking findings, advisories, and unresolved external gates. Native DRC success
does not clear or override a failed, unknown, or not-run practice rule. The
inspection is diagnostic only and returns `PROVISIONAL_POC` or
`BLOCKED_DIAGNOSTIC`; neither status grants qualification, manufacturing, or
release authority. Rev-A deliberately demonstrates that native DRC pass and
blocking `ROUTE_STYLE`/`BACKTRACK` practice findings can coexist.

## Execution, evidence, and lifecycle are independent

The implementation must not collapse three separate axes:

- **Run execution:** `queued`, `running`, `waiting_requirements_approval`,
  `blocked`, `interrupted`, `completed`, `cancelled`.
- **Stage-attempt execution:** `pending`, `running`, `waiting_approval`,
  `blocked`, `interrupted`, `succeeded`, `stale`.
- **Evidence:** `pass`, `fail`, `error`, `not_run`, `unsupported`, `stale`,
  `revoked`, `waived`.
- **Effective lifecycle:** `candidate`, `qualified`, `release_authorized`.

A clean check changes evidence, not lifecycle. Stored run and revision lifecycle
remains `candidate`; `get_run_status` derives `effectiveLifecycle` from current
exact attestations/evidence and returns the active attestations that support it.
Requirements approval permits work to continue but is not hardware qualification.
Qualification requires a human hardware-qualifier attestation bound to the exact
requirements, revision manifest, full evidence root, and a current passing
policy-accepted `human_physical` record with all seven required physical
categories. The physical-acceptance and measurement v2 validators and the
human-evidence v3 validators are implemented, but production collection and
acceptance policy remain incomplete. Validator support alone does not qualify
hardware, and no current Rev-A fixture is qualified or release-authorized. Release
additionally binds the exact active qualification approval and requires a separate
human release authority. A
replacement qualification never reactivates an older release. Any content change creates a new candidate revision;
attestations do not float to it. Revocation immediately changes the derived state
without erasing the attestation history.

## Human-only attestation boundary

The fourteen MCP tools contain no capability that can submit physical evidence,
qualify a revision, authorize manufacturing release, or revoke an attestation.
Those operations exist only as local REST routes:

- `POST /api/v1/revisions/{revisionId}/external-evidence`;
- `POST /api/v1/revisions/{revisionId}/qualification`;
- `POST /api/v1/revisions/{revisionId}/manufacturing-release`; and
- `POST /api/v1/attestations/{approvalId}/revocation`.

Requirements approval is one of the fourteen common operation schemas, but an
MCP invocation cannot satisfy its human capability check. Every human-only call
requires an exact allowlisted browser Origin, an idempotency key, the owning run's
expected revision, and a trusted human capability independent from the body
actor. The default daemon loads independent requirements-review,
hardware-qualification, and manufacturing-release credentials, binds each to a
fixed configured actor/capability, deletes the raw environment entries, and
retains only SHA-256 digests for timing-safe request verification. An absent role
denies only that role's human operations; candidate-only operation remains
available. Request actor metadata is injected when omitted and rejected unless
it exactly matches when present. The connected UI omits actor metadata, marks
each credential field as a new password, holds the value only in component
memory, and clears it after submission. Direct embedders must construct opaque
bindings from raw secrets; pre-hashed binding literals are rejected.

## Resumability, concurrency, and freshness

Mutation commands carry an idempotency key. Reusing a key with byte-equivalent
canonical input returns the stored result; reusing it with a different input is
`IDEMPOTENCY_CONFLICT`. Updates also carry the expected state revision. A stale
writer receives `REVISION_CONFLICT` and does not partly apply.

Only one active attempt for a stage and run is allowed. A fencing epoch prevents
late output from an interrupted/timed-out worker from committing over a newer
attempt. On failure, the attempt records blockers, exact affected input digests,
the required action, and whether retry is meaningful. `resume_run` continues
from the first eligible blocked/interrupted stage after prerequisites are fixed;
`rerun_stage` appends a new attempt and invalidates dependent evidence on a new
revision branch.

An upstream identity change marks all dependent artifacts/evidence stale before
they can be inspected as current or exported. Reports are current only when
their subject digests, tool identity, and policy inputs match the selected
revision.

## Curated knowledge and optional research

The curated component library is the default trust baseline. Every usable part
record pins symbols, footprints, datasheet bytes/URL, electrical limits,
lifecycle metadata, layout constraints, and known-good reference-circuit claims.
Updating that library is a reviewed input change.

Live catalog/web research is opt-in. It is untrusted data, not instructions. A
claim may enter a candidate only with its source URL, retrieval time, document
hash, exact extracted claim, and parser/tool identity. Missing, conflicting, or
unavailable evidence blocks selection. Live output is traceable but is not
claimed byte-reproducible.

## Standalone Phase-A design-agent boundary

Phase A provides proposal-only trust scaffolding and a reviewed architecture IR.
Its strict output is `proposal_only`, `agent_claim`,
`authorityDisposition: "none"`, and `validationDisposition: "not_evaluated"`;
provider narrative is untrusted display-and-audit material. It cannot mutate a
revision, establish validation evidence, claim native-tool success, qualify
hardware, or authorize manufacturing or release.

The nine roles map one-to-one onto the workflow stages:
`requirements_analyst`, `system_architect`, `component_engineer`,
`schematic_engineer`, `firmware_contract_engineer`, `simulation_engineer`,
`pcb_layout_engineer`, `manufacturing_engineer`, and `bringup_engineer`.
Current identity boundaries are `evleda.design-agent-prompt-pack.v2`,
`evleda.design-agent-proposal.v2`,
`evleda.design-agent-proposal-output-contract.v2`,
`evleda.design-agent-result.v2`, and `evleda.design-agent-replay.v2`.

The coordinator is not a fifteenth shared application operation. It is not
composed into the application or factory, exposed by REST or MCP, surfaced in the
UI, or supplied with a default provider. A production host must explicitly
provide the provider, host-selected authenticated trust manifests, frozen
instruction/reference/practice/output-contract identities, and an append-only
replay-receipt store. Callers cannot replace trust anchors. Frozen replay returns
the captured proposal without another provider call, but these prerequisites and
the reviewed IR do not make the subsystem an integrated application capability.

## KiCad-MCP sidecar boundary

KiCad 10.x native files remain authoritative. The logical package pin is
`kicad-mcp-pro==3.33.3`, audited against upstream commit
`817969d7e302ad470c2cac3d7c20961419400c47`. A verified launch does not resolve
that name from the network: it runs offline through the absolute `uvx` 0.11.31
path, an explicit Python 3.13.12 path, and the exact local wheel whose SHA-256 is
`c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f`.
The controller binds the `uvx` byte identity, and the launch preflight binds its
sibling `uv`, Python, wheel, Core Metadata, and official archive provenance from
`sidecars/kicad-mcp-pro.lock.json`. It exposes bounded inspection/edit
primitives, never a transparent proxy. The `review` capability profile is
read-only. The `build` profile permits allowlisted edits only when its working
root is disjoint from the canonical project root. See
[the real-sidecar verification guide](kicad-mcp-sidecar.md).

The controller must:

1. start the sidecar as a child process with a minimal environment and no
   release capability;
2. negotiate and record its exact server/tool versions and capability profile;
3. expose only a versioned allowlist of tools required by the active stage;
4. validate every input and output against local schemas and size/time limits;
5. resolve every path under the per-run working root and reject symlinks or
   junctions that escape it;
6. record canonical arguments, input/output identities, stdout/stderr, outcome,
   timeout, and executable identity; and
7. treat tool absence, timeout, malformed/unknown output, warning-only
   ambiguity, or unsupported syntax as a blocker.

Both profiles permanently deny sidecar export, manufacturing, quality-gate,
jobset, VCS-tag/release, and similarly named release capabilities (including
`export_*`, `variant_export_*`, `mfg_*`, and `*release*`). Manufacturing artifacts
come only from the separately constrained native CLI flow after EvlEDA gates.

Sidecar output can be an `agent_claim` or `evleda_check` depending on the
operation. It becomes `kicad_native` evidence only when the identified KiCad
executable itself produced the bound raw output. A sidecar success is never a
substitute for independent native ERC/DRC/export evidence.

## Isolated KiCad CLI validation flow

Ordinary validation must preserve canonical source bytes:

```text
freeze source manifest
        │
        ├─ hash canonical .kicad_* inputs
        │
create fresh run-owned temporary directory
        │
copy only manifest-listed source/library inputs
        │
run identity-bound KiCad 10 CLI with fixed cwd, locale, timeouts and output paths
        │
capture executable/version + argv + exit + stdout/stderr
        │
parse reports fail-closed; perform schematic/PCB/netlist parity checks
        │
write reports/CAM into a separate initially empty output directory
        │
rehash canonical sources and prove they are unchanged
        │
ingest immutable outputs, commit evidence atomically, remove run temp later
```

The coordinator, not the CLI adapter, creates the isolated manifest-listed copy
and passes its root as `projectRoot`. The adapter resolves
`EVLEDA_KICAD_CLI` first, then the Windows KiCad 10 default path, requires a 10.x
version, and fingerprints the reported version/commit, executable SHA-256, and
help-output SHA-256. It passes arguments directly to a process API, never through
a shell; requires the output root to be disjoint from `projectRoot`; and snapshots
all native KiCad source hashes before and after execution. ERC/DRC exit success
is insufficient when a report is missing, malformed, stale, incomplete, or
contains a disallowed violation. Results remain candidate and explicitly set
`releaseAuthorized: false`. KiCad exports are not declared deterministic until
the exact identity-bound build passes isolated two-run equality tests; otherwise
EvlEDA records semantic equivalence or traceable regeneration as appropriate.
For a supported narrowed request, the backend copies and validates the exact
Rev-A source rather than editing or regenerating it. Every native report and CAM
manifest binds the requested profile identity and electrical envelope, records
the reviewed-template instantiation identity, and states that topology generation
and native-source mutation were not performed. A supported request still cannot
bypass missing, stale, or non-passing canonical validation.

Native KiCad DRC is authoritative only for the configured KiCad rule deck. The
source-bound EvlEDA engineering-practice analyzer is an independent gate; either
channel can block PCB or manufacturing work, and one channel's pass cannot
substitute for the other's non-pass.

## Firmware contract

Firmware generation consumes the exact schematic and board-revision identities.
Its machine-readable contract includes pin ownership/polarity, voltage and
current assumptions, alternate functions, timers, interrupts, DMA, buses,
safe/boot states, fault handling, reset behavior, board-revision identification,
and communication protocols. Generated code is a scaffold with validation stubs
and guarded bring-up tests, not production firmware. Cross-checks compare that
contract with schematic connectivity, the pin map, and the selected MCU
resources; conflicts block both firmware and downstream stages.

The host C11 contract test and STM32G0 target build are separate provisioned
backends. The latter uses only an explicit `EVLEDA_ARM_GCC_ROOT`, binds GCC,
linker, objcopy, specs, runtime, pinned ST/Arm CMSIS inputs, generated sources,
and ELF/BIN/map identities, and rejects ambient `PATH` discovery. Even a passing
cross-build remains a non-flashable candidate: the platform forces safe GPIO
levels before output mode and deliberately rejects startup until board straps,
fault inputs, ADC calibration, and disabled peripheral setup are reviewed and
validated. See [STM32G0 candidate cross-build](firmware-toolchain.md).

Firmware reproducibility requires an exact private dependency closure: every
referenced source, toolchain component, configuration, lock, library, and
dependency identity must be captured and available without ambient registry or
version-range resolution. Firmware output remains candidate evidence only. A
passing build cannot qualify the board, authorize flashing, or grant release
authority.

## Bundles

`export_candidate_bundle` creates a review package named and marked
`CANDIDATE — NOT FOR MANUFACTURING`. CAM may be present only for exact review.
`export_prototype_bundle` requires a human qualification attestation bound to the
selected manifest and is marked `PROTOTYPE — NOT PRODUCTION RELEASED`. Exporting
never changes stored or effective lifecycle state. A fresh export requires the
selected revision to be the current completed nine-stage head; a fresh prototype
export additionally requires exact current qualification. A byte-equivalent
same-key durable replay returns the committed historical result and ZIP without
rebuilding or reevaluating current head, evidence, or qualification gates.

Every fresh export produces a ZIP containing `bundle-manifest.json` with schema
`evleda.bundle-manifest.v3`, assembled by `deterministic-zip-v3`. The application
separately persists an `evleda.bundle-export-replay.v2` durable receipt containing
the corresponding stored current result; the receipt is not a ZIP entry. The
public export result has no independent schema version and is discriminated by
`result.manifest.schemaVersion`. Its current member and manifest both carry the
exact policy `{ scope: "live_model_or_research", claim: "traceable",
reproducible: false }` and its recomputed
`evleda.live-regeneration-policy.v1` identity; both policy copies and both
identities must match exactly. This is a governing policy label, not evidence
that a live model or research invocation occurred and not an invocation
classifier. The result and manifest `exactInputs` are exactly
`[revisionManifest, evidenceRoot, liveRegenerationPolicyIdentity]`. Every current
bundle-generated artifact binds the same ordered inputs and uses a policy-bound
deterministic ID; the result and generated-artifact tools require
`deterministic-zip-v3`. The manifest also binds the selected project/run/revision
and ordinal, toolchain, unresolved assumptions, and every included file. Each
file entry carries its path, SHA-256 and byte size, stage, validation state,
source kind and artifact ID, actual originating design revision, exact inputs,
dependency edges, tool, assumptions, lifecycle, and deterministic timestamp/null
fields. `designRevisionId` remains the selected bundle revision while
`sourceDesignRevisionId` preserves inherited provenance.
Artifact paths are strictly sorted with English-locale collation. The manifest
itself is not listed, avoiding a self-hash cycle.

The exact revision-manifest preimage is persisted in the content-addressed store
when a revision is created and exported as canonical
`provenance/revision.json`. The already-gated evidence projection is exported as
canonical `evidence/evidence.json` using `evleda.bundle-evidence.v2`. Those files,
the deterministic high-contrast `COVER.svg`, `README.md`, and `WARNING.txt` are
normal manifest entries with exact byte
identities, complete bundle-generator provenance, fixed generation roles, and
deterministic `bundle_artifact_*` source IDs. `bundle-manifest.json` is the sole
self-excluded file. The cover visibly renders the bundle's exact warning and
lifecycle. It is added alongside stored renders; source and KiCad-native artifact
bytes and provenance are never rewritten or relabeled.

The read-only verifier at `scripts/verify-bundle.mjs` independently implements
canonical JSON and deterministic IDs. In addition to traversal, link,
collision, inventory, and byte checks, it recomputes the revision manifest,
design-revision ID, evidence root, and current policy identity; validates the
artifact/evidence graph ownership; and derives the exact toolchain and assumption
unions. Optional
trusted expected-root arguments bind that internal proof to an out-of-band
identity. It also requires the cover's fixed role/path/media type and exact safe
SVG template, so rehashing a warning-free replacement cannot pass. This check
does not prove authenticity, truth, safety, qualification,
or release. Exact pre-E-08 history remains replayable only as the original
unlabeled manifest-v2/replay-v1 pair. An `evleda.bundle-export-replay.v1` receipt
accepts only the exact legacy export-result member discriminated by
`result.manifest.schemaVersion === "evleda.bundle-manifest.v2"`. That result's
`exactInputs` are exactly `[revisionManifest, evidenceRoot]`; its v2 manifest has
no manifest-level `exactInputs`, and neither the result nor manifest has policy
fields. Legacy result and bundle-generated artifact tools require
`deterministic-zip-v2`. Replay returns the historical result unchanged, without
synthesizing policy, rewriting the receipt or ZIP, or reevaluating current export
gates. Labeled v2, crossed receipt/manifest versions, and hybrids fail closed.
For both retained generations, `manifest.toolchain` is the canonical-identity-sorted,
duplicate-free exact union of manifest artifact tools and contains exactly one
fixed bundler identity matching its manifest/replay generation. Missing, extra,
or crossed bundler entries fail schema validation and durable replay restoration.

The standalone verifier reports these exact assurance and warning outcomes:

- `evleda.bundle-manifest.v3` returns `provenance_roots` with no downgrade warning;
- `evleda.bundle-manifest.v2` requires `--allow-legacy-v2`, returns `provenance_roots_without_live_policy`, and emits `WARNING: legacy v2 bundle has no live-regeneration policy label or identity; no policy was inferred.`;
- `evleda.bundle-manifest.v1` requires `--allow-legacy-v1`, returns `byte_integrity_only`, and emits `WARNING: legacy bundle verified at byte_integrity_only assurance; roots were not recomputed.`

`scripts/test-bundle-verifier.mjs` exercises those failure classes in a uniquely
named operating-system temporary directory and removes only that verified path.
`scripts/test-exported-bundle.ts` additionally creates a complete in-memory
candidate through the application service, confines extraction to a unique
temporary root, and proves the producer's file set satisfies the independent
verifier.

## Reproducibility levels

EvlEDA reports one of three claims, never a generic “deterministic” badge:

1. **Byte-reproducible replay** for EvlEDA-controlled canonical artifacts using
   frozen inputs and captured model/tool outputs, without calling a model again.
2. **Semantic equivalence** for supported KiCad content after removing only
   documented nondeterministic metadata.
3. **Traceable regeneration** for live model or research calls whose outputs may
   differ.

Tool versions, executable digests, component library, policy, templates, locale,
time source, seeds, model settings, prompts, and captured outputs are inputs to
the relevant claim.

## Deployment boundary

v0 is a single-user, local-first application. It has no hosted multi-tenant
control plane, no network-exposed manufacturing service, and no autonomous
release endpoint. It has a credential-gated local-human attestation route, but
that route records authority; it does not publish files, place an order, or
operate manufacturing equipment. Remote access, shared workspaces, arbitrary
plugins, deployment, and manufacturing automation require a new threat model and
are out of scope.
See [security-model.md](security-model.md) for mandatory controls and
[api.md](api.md) for the transport contract.
