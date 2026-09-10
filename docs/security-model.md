# EvlEDA v0 security model

EvlEDA is a local-first engineering tool that processes untrusted prompts,
documents, component metadata, KiCad projects, model output, and generated files.
Local operation reduces network exposure; it does not make those inputs trusted.
This model covers the v0 single-user application, its KiCad-MCP/CLI workers, and
the separately host-composed design-agent proposal subsystem. That subsystem has
implemented Phase-A scaffolding and architecture IR, but is not wired into the
application factory, REST, MCP, or UI and has no default live provider.

The [product contract](product-contract.md) remains the normative lifecycle and
hardware boundary. Security controls prevent unauthorized effects and preserve
evidence integrity; they do not establish electrical safety.

## Assets and security objectives

| Asset | Objective |
| --- | --- |
| Canonical KiCad sources | Preserve exact current bytes; never overwrite during validation |
| Project/run/revision state | Atomic updates, append-only history, stale-writer rejection |
| Artifact and evidence store | Content integrity, confinement, dependency traceability |
| Curated component library | Pinned reviewed content and provenance; explicit update boundary |
| Human approvals/attestations | Authentic actor capability and exact manifest/evidence binding |
| Local filesystem and credentials | No path escape, arbitrary command execution, or secret disclosure |
| KiCad/MCP executables | Exact version/capability identity and constrained invocation |
| Design-agent trust and proposal records | Host-selected authenticated trust anchors, strict proposal-only output, and exact append-only replay identity |
| Export bundles | Complete file inventory, correct warning/lifecycle, no mixed revisions |

Security objectives are fail-closed validation, least privilege, integrity,
traceability, availability bounded by time/size limits, and a hard separation
between autonomous candidate generation and human lifecycle authority.

## Trust zones

```text
untrusted inputs
  prompts · imported KiCad · datasheets · live web/catalog · model/tool output
                              │
                              v
validation / canonicalization boundary
                              │
                  EvlEDA command + policy core
                     │                    │
           confined immutable store      │ allowlisted, bounded IPC
                                         v
                                KiCad-MCP sidecar / CLI

 untrusted model provider ─> strict proposal parser/canonicalizer
                                  │
        host-authenticated trust manifest + append-only replay receipts
                                  │
                    proposal-only validator handoff

trusted human interaction ── capability broker ── exact approval record
```

- REST, MCP, UI, prompt text, filenames, archives, source documents, and tool
  output are untrusted.
- The command/policy core, canonicalizer, path policy, immutable store, and
  approval capability broker are the trusted computing base.
- The KiCad-MCP sidecar and KiCad CLI are privileged parsers/tools but not policy
  authorities. Their output remains untrusted until schema and identity checks.
- The design-agent provider, raw output, and narrative are untrusted. Production
  trust manifests and replay stores are constructor-injected host prerequisites;
  a run request cannot select or replace their anchors. Structured output remains
  `proposal_only`; narrative remains display/audit-only `agent_claim` data.
- The proposal subsystem is not a public operation or application-state writer.
  Deterministic/native validators must evaluate any later handoff.
- A browser UI can request a command; it cannot mint a human role or lifecycle
  transition.

## Principal threats and mandatory controls

| Threat | Required controls | Failure behavior |
| --- | --- | --- |
| Prompt/document instruction injection | Treat retrieved text and model output strictly as data; stage-specific schemas and tool allowlists; no document-controlled capability expansion | Reject malformed output or block for review |
| Agent authority forgery or replay substitution | Strict v2 proposal-only schema; quarantined untrusted narrative; no pass/lifecycle fields; exact provider/model/instruction/reference/practice/output-contract/trust identities; host-owned production trust store; append-only receipt lookup; deterministic/native validator handoff | Reject output or replay with no project mutation |
| Arbitrary command/argument injection | Spawn executable plus argument array directly; never interpolate through a shell; fixed executable pins and timeouts; minimal environment | Record invocation failure and block |
| Workspace escape (`..`, drive/UNC, symlink, junction, case alias) | Resolve against a configured root; reject absolute and alternate-root forms; inspect every path component; compare real paths; disallow links in bundles and isolated inputs | `PATH_OUTSIDE_WORKSPACE` |
| Canonical source overwrite | Validate only immutable isolated copies; output to a separate initially empty run directory; hash source before and after | Discard attempt output and raise integrity error |
| Stale or mixed-revision commit | Immutable input manifest, optimistic `expectedRevision`, fencing epoch, exact project/run/revision checks, dependency invalidation | `REVISION_CONFLICT` or blocked stale attempt |
| Hash substitution/corruption | SHA-256 plus exact byte size; constant-time validated digest comparison; verify on read and promotion; canonical schema/version binding | `DIGEST_MISMATCH` / `ARTIFACT_INTEGRITY_ERROR` |
| Misleading evidence | Preserve evidence class and non-pass states; bind raw and parsed outputs; never treat hashes/model prose as truth; display assumptions | Block gate or report non-pass honestly |
| Malicious/oversized KiCad or report input | Byte/count/depth/time limits, supported syntax/version gate, isolated process, bounded capture, fail-closed parser | `TOOL_RESULT_INCONCLUSIVE` / `TOOLCHAIN_UNSUPPORTED` |
| MCP confused deputy | Child sidecar, versioned allowlist, per-stage capabilities, no transparent proxy, schema validation, working-root confinement | Deny tool; block stage |
| Untrusted live URL / SSRF | Live research off by default; HTTPS allow policy; reject local/private/link-local/file URLs and redirects to them; response limits; store URL/hash/retrieval metadata | Reject source or block selection |
| Compromised dependency/action | Exact dependency lock, frozen install, immutable full-commit GitHub Action pins, least workflow permissions, no release secrets in CI | CI fails; no publish fallback |
| Approval spoofing/replay | Exact allowlisted Origin plus a distinct role-scoped in-memory credential; inject the configured actor or require an exact body match; idempotency; exact requirements/revision/evidence/policy/scope/time binding; revocation | `CAPABILITY_REQUIRED`, `POLICY_DENIED`, or stale evidence |
| Accidental manufacturing | Candidate/prototype policy gates; exact warning in directory/manifest/README/covers; no MCP release operation; separate local-human release attestation; export never changes lifecycle | Deny export or fail manifest verification |
| Resource exhaustion | Per-command timeouts, concurrency caps, size/file/dependency-depth limits, cancellation/fencing, bounded logs and pagination | Interrupt/block without partial commit |
| Secret leakage | Hash/delete every daemon credential environment value before validation; redact the credential header; keep UI entry in component memory only; no secrets in prompts, persistence, URLs, manifests, errors, logs, bundles, or command lines | Refuse/censor capture and block affected operation |

## Process and filesystem confinement

Each run receives separate canonical-input, working-copy, and output locations
under one configured application root. The controller constructs paths from
opaque IDs; clients may supply only validated relative logical destinations.
Before a privileged read or write it must:

1. reject empty, NUL-containing, absolute, drive-relative, UNC/device, and
   parent-traversal paths;
2. normalize separators and Unicode according to one documented policy;
3. walk components without following a link outside the root;
4. compare the final real path with the real configured root; and
5. open/create with exclusive or no-follow semantics where the platform offers
   them, then re-check the opened object.

The KiCad sidecar and CLI receive a minimal environment containing only required
locale/runtime/library variables. They do not receive cloud credentials, source
control credentials, approval capabilities, a shell, a public listener, or the
release authority. Executable path, version, digest where available, arguments,
cwd, start/end, exit/outcome, and bounded stdout/stderr identities are retained
inside bound native report/evidence artifacts. The schema-reserved
`state.invocations` map has no application production writer and is not yet a
first-class durable invocation ledger.

File-lock process-incarnation helpers use the same restricted posture: an
absolute PowerShell or `ps` path, shell-disabled execution, bounded output and
time, and an explicit system-only environment. Darwin and FreeBSD `ps` probes
also fix the C locale and POSIX `TZ=UTC0`, so host timezone or DST changes cannot
alter a live owner's start identity. Unsupported durable-lock hosts do not fall
back to PATH discovery or weaker process-start approximations.

Timeout, crash, nonzero exit, missing executable, extra/missing output,
unrecognized warning, or malformed report is not success. Process termination
must advance the fencing epoch before another attempt starts, so a late process
cannot commit.

Firmware target builds require the `verified-private-toolchain-closure` policy:
the private compiler/toolchain closure is identity-bound and linker-plugin/LTO
discovery outside it is disabled. Generated ELF, BIN, and map outputs remain
candidate-only and `flashable: false`. These controls do not constitute an OS
sandbox or authorize flashing, deployment, qualification, or release.

## KiCad isolation requirements

KiCad remains authoritative for native semantics, but imported KiCad files are
untrusted structured input. Validation operates on a manifest-listed copy and
writes reports/CAM to a different empty directory. It never invokes a project
script, plugin, action, shell command, or arbitrary URI embedded in a design.

The sidecar runs offline from the exact `kicad-mcp-pro==3.33.3` wheel, SHA-256
`c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f`,
reviewed separately against commit
`817969d7e302ad470c2cac3d7c20961419400c47`. The PyPI bytes and Git commit are
distinct identities because PyPI does not attest that the wheel was built from
that commit. The real-launch preflight verifies the official `uv` archive,
`uv.exe`, `uvx.exe`, managed Python archive/executable, wheel, and wheel Core
Metadata before starting the child. Its `review` profile is read-only; its
`build` profile requires a working root disjoint from canonical sources.
Export/manufacturing/quality-gate/jobset/VCS-tag/release tool families are always
denied.

The CLI adapter resolves `EVLEDA_KICAD_CLI` or the KiCad 10 Windows default,
requires a 10.x executable, and records the version/commit, executable SHA-256,
and help-output SHA-256. The coordinator constructs the isolated manifest-listed
copy before calling the adapter. The adapter then verifies:

- all native KiCad source hashes under the supplied `projectRoot` before and
  after the run;
- report existence, schema/format, source subject, and completeness;
- schematic-to-board/netlist parity where required;
- every expected output and absence of unrequested outputs; and
- evidence subjects against the selected design revision.

Sidecar edits are bounded and reread before commit. Native ERC/DRC/export evidence
must come from the identified native process; an MCP wrapper's success flag is
not native evidence.

KiCad DRC is authoritative only for the bound native KiCad rule deck and is
recorded as `kicad_native`. The source-bound EvlEDA engineering-practice analyzer
is a separate `evleda_check`; neither result substitutes for the other. An
applicable practice `FAIL`, `UNKNOWN`, or `NOT_RUN` remains blocking even when
native DRC passes. Rev-A intentionally proves this separation: clean native DRC
can coexist with blocking `ROUTE_STYLE` and `BACKTRACK` findings and a
`BLOCKED_DIAGNOSTIC` disposition.

## Content and evidence integrity

Content-addressed storage is append-only. New bytes are written to a unique
staging file, flushed, hashed, and atomically promoted to a path derived from the
digest. A collision with existing content is accepted only after rereading and
verifying the existing object. State commits reference only promoted content.

Canonical JSON identity uses schema `evleda-c14n-json-v1` and explicit enclosing
schema versions. It rejects undefined values, unsupported object prototypes, and
non-finite numbers. Identity-bearing payloads contain no ambient wall-clock time
unless the schema explicitly declares it as an input. Reproducibility metadata
and optional bundle `createdAt` are kept outside the identity payload.

Evidence records always retain class, validation state, exact subjects/inputs,
tool identity, assumptions, and freshness. Waivers remain `waived`; unsupported
checks remain `unsupported`; stale/revoked evidence remains visible. The system
must not summarize those values into a generic green pass.

## Bundle safety

`bundle-manifest.json` is the only inventory root and is not self-listed. Before
accepting or presenting a bundle, verify:

- schema/canonicalization version and strict field types;
- for current `evleda.bundle-manifest.v3`, the exact traceable/non-reproducible
  policy label, recomputed `evleda.live-regeneration-policy.v1` identity, and
  ordered revision/evidence/policy exact inputs;
- bundle kind, lifecycle, and exact warning policy;
- exact canonical revision-record and evidence-projection preimages;
- independently recomputed revision/evidence roots and deterministic revision ID;
- sorted, unique, case-insensitive-noncolliding relative artifact paths;
- equality of every artifact project/run/selected-revision ID with the manifest,
  while preserving and validating its actual source revision separately;
- complete per-entry exact inputs, dependency edges, tool, assumptions,
  lifecycle, timestamp/staleness, and generated-role provenance;
- `deterministic-zip-v3` plus policy-bound source identities for every current
  bundle-generated artifact;
- no symlinks/junction escapes, device names, traversal, or alternate roots;
- an exact file-set match excluding the manifest itself;
- every artifact SHA-256 and byte size; and
- the exact deterministic lifecycle-cover template, including visible warning
  and lifecycle text; and
- exact toolchain and unresolved-assumption unions derived from the entries.

Candidate bundles require lifecycle `candidate` and warning `CANDIDATE — NOT FOR
MANUFACTURING`. Prototype bundles require lifecycle `qualified` and warning
`PROTOTYPE — NOT PRODUCTION RELEASED`. A bundle that fails verification is
untrusted and must not be partly consumed. Passing without trusted external
roots proves internal consistency only, not provenance authenticity. v1 bundles
are rejected by default because they lack root preimages and complete entry
provenance; explicit legacy mode checks their byte inventory only.

Current durable `evleda.bundle-export-replay.v2` receipts pair only with current
manifest v3. Exact pre-policy replay-v1 receipts pair only with original,
unlabeled manifest v2 and return those historical bytes and metadata unchanged;
no policy is inferred. Standalone v2 verification requires
`--allow-legacy-v2` and reports `provenance_roots_without_live_policy`. Crossed
versions, labeled/interim v2, missing v3 policy, policy mismatch, or a
`reproducible: true` relabel fail closed. Manifest v1 remains explicit
`--allow-legacy-v1` byte-inventory-only compatibility.

EvlEDA exports ZIP archives, but the standalone verifier intentionally accepts
only a previously extracted directory. Extraction must use a newly created
confined directory with file-count, expanded-size, ratio, depth, special-file,
link, and path limits before applying the same manifest verification.

## Network and live-research policy

Core generation, curated-library use, KiCad work, and verification require no
public listener. REST binds only to `127.0.0.1`/`::1`; a non-loopback bind is an
unsupported deployment requiring authentication, TLS, CSRF/origin controls,
rate limits, audit, and a revised threat model.

Every request is subject to an exact local Host allowlist. When an `Origin` is
present it must exactly match an allowed HTTP(S) origin; the server emits no
permissive CORS response. Human-only routes additionally require an Origin to be
present and exact plus a valid `X-EvlEDA-Human-Credential` for the operation's
role. If that role has no configured credential, the default is
`CAPABILITY_REQUIRED` and zero mutation; candidate-only operations remain
available.

Live research is opt-in per run. A network fetcher, when enabled, is separate
from the model and has no filesystem write or tool authority. It permits only
configured HTTPS sources, resolves and revalidates every redirect target,
rejects loopback/private/link-local/metadata/file schemes, applies DNS rebinding
defenses and byte/time/content-type limits, and stores the final URL, retrieval
time, content hash, and extracted claims. Page text cannot change policy or issue
tools. Missing or conflicting primary evidence blocks the part.

No telemetry, cloud upload, or external model call is implied by the local-first
default. Any future remote provider is opt-in and must clearly identify what
project data leaves the machine.

Likewise, no provider call is implied by the fourteen-operation daemon API. The
standalone Phase-A proposal coordinator calls only a host-injected provider when
explicitly composed. Provider text has no tool, filesystem, policy, validation,
qualification, or lifecycle authority. A live proposal is traceable and never
claimed reproducible; frozen exact replay resolves its append-only receipt and
does not call the provider again.

## Human capability and lifecycle boundary

Requirements approval, hardware qualification, and manufacturing release are
different capabilities:

- A requirements reviewer may approve the exact current requirements digest
  once blocking ambiguity is absent.
- A hardware qualifier may attest only to an exact design manifest/evidence root
  and scope after the required review/physical evidence exists.
- A release authority is separate and may authorize only the exact qualified
  revision with applicable exact physical evidence. The release record binds the
  specific qualification approval reviewed; a replacement qualification requires
  a new release-authority attestation.

The public agent-facing MCP has none of these capabilities. A REST/MCP caller or
design-agent proposal cannot gain one by passing `{ "role": "release_authority" }`
or emitting authority prose. Each configured
credential is bound server-side to one immutable actor and exactly one
capability. REST actor metadata may be omitted, in which case the configured
actor is injected, or supplied as an exact consistency assertion; any field or
role mismatch is `CAPABILITY_REQUIRED`. The application service independently
requires that trusted context to match the attesting actor.

The daemon recognizes three separate secrets:

- `EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL` for requirements approval and its
  revocation;
- `EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL` for external physical evidence,
  qualification, and their revocation; and
- `EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL` for manufacturing release and its
  revocation.

Each secret must be 43–128 canonical unpadded Base64URL characters, decode to at
least 32 bytes (a minimum 256-bit generated value), and contain at least 16
distinct characters. This format check cannot prove randomness, so credentials
must be generated by a cryptographically secure random generator, for example
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
Empty, short, noncanonical, low-diversity, or cross-role duplicate values fail
startup. The deprecated shared `EVLEDA_HUMAN_APPROVAL_TOKEN` also fails startup;
there is no implicit legacy fallback.

The matching `*_ACTOR_ID` and `*_ACTOR_DISPLAY_NAME` environment entries may
set the audit identity for each configured role; otherwise stable local defaults
are used. Actor metadata without its role credential is rejected as an
incomplete binding.

All raw credential environment entries are read once and deleted from
`process.env` before validation. Only SHA-256 digests are retained, and request
digests are compared in constant time. The credential header is redacted from
daemon logs. The UI keeps each typed role credential only in the active React
component, marks the input as a new password, omits actor metadata so the daemon
injects its configured identity, sends the credential in the one human-route
header, clears it after submission, and never uses browser or project storage.
The resulting record binds actor, role, scope, rationale, policy,
subject/evidence roots, time, expiry, and revocation. In-process embedders must
use the raw-secret credential constructor; the server rejects forgeable
pre-hashed binding objects.

Stored run and revision lifecycle remains `candidate`. Status derives
`effectiveLifecycle` and lists `activeAttestations`; revocation or a new design
revision therefore changes the effective result without rewriting history.

Manufacturing release remains intentionally unreachable through the fourteen
MCP operations. The supplemental local-human routes for external evidence,
qualification, manufacturing-release attestation, and revocation require the
same exact-Origin/credential gate. Candidate/prototype exports never mutate
stored or effective lifecycle.

## Physical evidence boundary

Physical measurements are accepted only as candidate-scoped `human_physical`
evidence. Current derivation produces strict
`evleda.human-physical-evidence.v3`. Submission binds the exact current-head revision/evidence roots,
canonical BOM and complete CAM manifest/output set, passing firmware build plus
flashed binary, as-built record, bring-up procedure, and machine-readable physical
acceptance contract. Caller source bytes are bounded, content-identity verified,
stored individually, and preserved in a digest-addressed raw archive.

Observations are parsed only from `evleda.physical-measurements.v2` against the
exact `evleda.physical-acceptance.v2` contract and case/capture/procedure
bindings; the request cannot supply limits, verdicts, or expiry. Test IDs,
quantities, instrument capabilities, units, limits, conditions, durations, and
expected values come from the current revision's generated acceptance artifact.
Strict as-built, flash, and
calibration sources bind board/lot/substitutions, flashed firmware, instruments,
environment, and timestamps. Policy caps sessions at 24 hours, submission age at
seven days, as-built-record age at 90 days, calibration age at 366 days, and
evidence age at 30 days. Observation,
category, overall verdict, and actual expiry are derived. Qualification, lifecycle
status, prototype export, and release re-read and deeply verify the stored record;
missing, failed, expired, stale, wrong-role, or corrupt evidence cannot qualify.
EvlEDA may generate forms and procedures but cannot mark them performed.

Those v2/v3 contracts and fail-closed service paths are implemented. The
production Rev-A `evleda.physical-acceptance-policy.v2` is still explicitly
`incomplete`, so it cannot mint an approved executable acceptance contract. No
real Rev-A physical record, qualification, or manufacturing release exists.

One passing fabricated unit can qualify only an exact revision that first passes
all applicable native and EvlEDA-practice gates under the recorded conditions.
The retained expected-negative Rev-A fixture is not such a revision. A later
qualified unit would not establish production yield, arbitrary
generated-board safety, regulatory compliance, or platform-wide correctness.
CI must never synthesize or claim this evidence.

## CI security posture

The repository workflow grants only `contents: read`, checks out without
persisting credentials, pins third-party actions by full commit, installs the
exact Node/pnpm versions against the committed lockfile, and runs software checks.
It has no deployment event, environment, secrets, artifact publishing, KiCad
hardware access, or lifecycle capability. Pull requests use `pull_request`, not
`pull_request_target`.

## Residual risk and non-claims

- SHA-256 and canonical manifests do not prove design correctness.
- A compromised host, EvlEDA executable, KiCad binary, dependency, or human
  account can invalidate evidence; v0 is not a hardened remote service.
- A role credential proves possession of its configured capability, not the
  configured actor's real-world identity; controlled provisioning and audit
  review remain necessary.
- Process/path controls reduce but do not replace OS sandboxing. Platform-specific
  junction and file-race behavior requires integration testing.
- W-03 atomic stage publication is software-verified. Its cooperative durable
  file lease binds PID and OS process-start identity on Windows, Linux, macOS,
  and FreeBSD. AIX, Solaris, and unknown hosts are rejected before any helper or
  claim; no weaker start-time approximation is used to widen that boundary.
- ERC/DRC, modeled simulation, and firmware compilation leave electrical,
  thermal, EMC, mechanical, manufacturing, and system hazards unproven. Native
  DRC and EvlEDA engineering-practice checks remain distinct software evidence;
  even both passing would not close those physical hazards.
- EvlEDA is not a safety case, certification authority, or substitute for
  qualified engineering review and controlled physical validation.
