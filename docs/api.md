# EvlEDA v1 REST and MCP contract

This is the stable application interface for EvlEDA v0. Both transports call the
same command handlers and policy gates. REST routes are rooted at `/api/v1`; MCP
tool names are the fourteen operation names below. Four additional attestation
routes exist only on the trusted local-human REST surface. They are deliberately
absent from MCP.

## Transport rules

- REST accepts and returns UTF-8 JSON. Unless noted, the body is an object.
- The server binds to loopback by default. It does not enable CORS for arbitrary
  origins and does not trust forwarded-host or forwarded-client headers.
- Every durable mutation requires a caller-generated `Idempotency-Key` REST
  header. REST clients omit `idempotencyKey` from the body; the adapter injects
  the header value. The equivalent MCP argument is `idempotencyKey`.
- Updates to an existing project, run, or revision require `expectedRevision`.
  `start_design_run` uses the last observed `project.revision`; run- and
  revision-scoped mutations use the owning `run.revision`. This is not the
  store-wide `stateRevision`.
- IDs and digests are opaque. Clients must not derive paths from them.
- Timestamps are RFC 3339 UTC strings and are metadata, never proof of ordering
  or identity unless an enclosing schema explicitly binds them.
- Unknown request fields and unsupported enum values are rejected. Adding a
  field that old clients may safely ignore is backward-compatible for responses;
  changing a field's meaning requires a new API/schema version.
- A command returning `queued` or `running` has been durably accepted, not
  completed. Poll `get_run_status`.

An idempotency key is scoped to the operation and local EvlEDA instance. Reusing
it with the same canonical request digest returns the stored response. Reusing it
with a different digest returns `IDEMPOTENCY_CONFLICT`. Keys must contain 16–128
printable ASCII characters and must not contain credentials.

Bundle export replay is intentionally historical. A byte-equivalent request
under the same export idempotency key returns the previously committed result
and ZIP without rebuilding or reevaluating the current head, evidence, or
qualification gates. A new key requests a fresh export and evaluates current
policy.

## Result identity

The envelope has no separate `context` member. Identity-bearing records inside
`result` are self-describing. Every `ArtifactRecord`, `EvidenceRecord`, bundle
result, and generated-artifact result carries the applicable project, run,
design revision, workflow stage, exact inputs, tool identity, validation status,
unresolved assumptions, and lifecycle. Project/run inspection results instead
contain the complete project, run, and optional head-revision records. A client
must not infer a missing identity from UI selection or a previous response.

Allowed stages are:

`requirements`, `system_architecture`, `component_selection`, `schematic`,
`firmware_contract`, `simulation_checks`, `pcb_placement_routing`,
`manufacturing_package`, and `bringup_package`.

Allowed validation states are `pass`, `fail`, `error`, `not_run`, `unsupported`,
`stale`, `revoked`, and `waived`. Allowed lifecycle states are `candidate`,
`qualified`, and `release_authorized`. These axes are independent of run/stage
execution state; see [architecture.md](architecture.md).

## Envelopes

REST success:

```json
{
  "ok": true,
  "operation": "get_run_status",
  "requestId": "request_…",
  "result": {}
}
```

REST failure:

```json
{
  "ok": false,
  "error": {
    "code": "STAGE_BLOCKED",
    "message": "The stage still has unresolved blockers.",
    "retryable": false,
    "details": {}
  }
}
```

Error `message` is diagnostic and may be clarified; clients branch on `code` and
`retryable`. Details must not expose secrets, unconfined host paths, raw prompts,
or unbounded tool output. Unexpected failures normalize to `INTERNAL_ERROR`
without their internal exception text.

MCP tools accept the same body fields, with path/query identifiers moved into
the argument object and `idempotencyKey` replacing the header. On success they
return one JSON `structuredContent` object containing `operation`, `requestId`,
and `result`. On failure they set `isError: true` and return the same
structured `error`; they do not encode domain failure as successful prose.

## Operations

The standalone design-agent coordinator is not a fifteenth REST/MCP operation
and is not composed into the application command layer. Its current Phase-A
output is `proposal_only`, `agent_claim`, `authorityDisposition: "none"`, and
`validationDisposition: "not_evaluated"`; it cannot mutate a revision, establish
validation evidence, claim native-tool success, or exercise human lifecycle
authority. The implemented system-architecture decision IR/compiler is likewise
isolated Phase-A infrastructure, not an application result or operation.
Production use additionally requires host-provisioned authenticated
trust and durable replay stores and a configured provider; no default live
provider is installed.

| Operation | REST | Durable mutation | Purpose |
| --- | --- | --- | --- |
| `create_project` | `POST /api/v1/projects` | yes | Create a confined local project |
| `start_design_run` | `POST /api/v1/projects/{projectId}/runs` | yes | Parse a prompt and queue the requirements stage |
| `get_run_status` | `GET /api/v1/runs/{runId}` | no | Read execution, stage attempts, blockers, and head identity |
| `inspect_requirements` | `GET /api/v1/runs/{runId}/requirements` | no | Read parsed requirements and assumptions |
| `approve_requirements` | `POST /api/v1/runs/{runId}/requirements/approval` | yes | Bind human review to the exact requirements digest |
| `resume_run` | `POST /api/v1/runs/{runId}/resume` | yes | Resume after a recorded blocker/interruption is resolved |
| `list_artifacts` | `GET /api/v1/runs/{runId}/artifacts` | no | Filter artifact metadata for a selected run/revision |
| `inspect_evidence` | `GET /api/v1/runs/{runId}/evidence` | no | Filter evidence and return its deterministic root |
| `inspect_engineering_practices` | `GET /api/v1/runs/{runId}/engineering-practices` | no | Inspect separately bound native DRC and EvlEDA practice results, coverage, findings, advisories, and external gates |
| `rerun_stage` | `POST /api/v1/runs/{runId}/stages/{stage}/rerun` | yes | Append an attempt and branch a revision |
| `export_candidate_bundle` | `POST /api/v1/revisions/{revisionId}/exports/candidate` | yes | Build an integrity-bound review bundle |
| `export_prototype_bundle` | `POST /api/v1/revisions/{revisionId}/exports/prototype` | yes | Build a qualified, non-production prototype bundle |
| `generate_bringup_plan` | `POST /api/v1/revisions/{revisionId}/generations/bringup-plan` | yes | Generate/refresh guarded bring-up artifacts |
| `generate_firmware_scaffold` | `POST /api/v1/revisions/{revisionId}/generations/firmware-scaffold` | yes | Export the current revision's exact committed firmware-stage artifacts/reports; fails if absent and never advances a head |

### `create_project`

Request body:

```json
{
  "name": "two-channel-controller",
  "description": "Bench prototype",
  "workspace": "two-channel-controller",
  "policyVersion": "evleda.policy.v1"
}
```

`workspace` is a relative logical directory under the configured projects root,
not an arbitrary host path. The server rejects traversal, absolute/UNC/drive
paths, symlink escapes, reserved names, and collisions. `policyVersion` may be
omitted to use the configured pinned policy; when supplied it is only an equality
precondition and a mismatch returns `POLICY_DENIED`.

Returns HTTP 200 with `{ project, stateRevision }`. The project starts with no
run or design revision.

### `start_design_run`

Request body:

```json
{
  "expectedRevision": 0,
  "prompt": "Design a 7–16.8 V, two-channel brushed motor controller at 0.5 A RMS per channel.",
  "configuration": {
    "referenceProfile": "robotics-controller-v0",
    "curatedLibraryDigest": "…64 lowercase hex…",
    "liveResearch": false,
    "modelSettingsIdentity": {
      "algorithm": "sha256",
      "digest": "…64 lowercase hex…",
      "schemaVersion": "evleda.model-settings.v1",
      "canonicalizationVersion": "evleda-c14n-json-v1"
    }
  }
}
```

The prompt bytes and full configuration become exact inputs to the run; later
stages also bind their selected policy, library, templates, backends, and
toolchain inputs. A blank prompt is `INVALID_ARGUMENT`. The current synchronous
handler returns HTTP 200 with a `RunStatusResult` after it durably reaches
requirements approval or a blocker. Parsing ambiguity produces a durable blocked
state; it is not silently filled in.

Selecting `robotics-controller-v0` selects the constrained Rev-A proof-fixture
profile, not a known-good or passing PCB. The current source is deliberately an
expected-negative engineering-practice fixture and cannot complete its PCB stage
without compliant regenerated geometry and all other blockers being resolved.

### `get_run_status`

MCP arguments are `{ "runId": "run_…" }`. REST has no body. Returns:

```json
{
  "project": { "id": "project_…", "revision": 1 },
  "run": {
    "id": "run_…",
    "state": "waiting_requirements_approval",
    "lifecycle": "candidate",
    "headRevisionId": null,
    "revision": 3
  },
  "currentStage": "requirements",
  "blockers": [],
  "effectiveLifecycle": "candidate",
  "activeAttestations": [],
  "stateRevision": 3
}
```

Run state is one of `queued`, `running`, `waiting_requirements_approval`,
`blocked`, `interrupted`, `completed`, or `cancelled`. `headRevision` and
`nextStage` are optional. Stored run/revision lifecycle remains `candidate`;
`effectiveLifecycle` is derived from exact active attestations and physical
evidence. `activeAttestations` makes that derivation inspectable.

### `inspect_requirements`

MCP arguments are `{ "runId": "run_…" }`. Returns `{ projectId, runId,
requirements, requirementsDigest, approvable, approval? }`. Requirement source
spans index the original UTF-16 JavaScript string and include a short excerpt for
review. `approvable` means deterministic gates currently permit a human decision;
it is not an approval or safety claim.

### `approve_requirements`

Request body:

```json
{
  "expectedRevision": 3,
  "requirementsDigest": "…64 lowercase hex…",
  "actor": {
    "type": "human",
    "id": "operator-record-id",
    "displayName": "Local reviewer",
    "role": "requirements_reviewer"
  },
  "scope": "requirements for this run only",
  "rationale": "Voltage, channel count, current and exclusions reviewed."
}
```

This command also requires an idempotency key. The body `actor` is descriptive
and becomes part of the bound approval record; it is not authority. REST must
separately supply the exact allowed `Origin` and a valid
requirements-review credential in `X-EvlEDA-Human-Credential`. REST may omit
`actor` and use the credential-bound configured reviewer; if it supplies
`actor`, all fields must match that reviewer exactly. MCP exposes the tool for
schema parity but its MCP context cannot grant approval, so the call fails
`CAPABILITY_REQUIRED`. The exact digest must equal the current requirements
identity, and blocking assumptions must be absent. Returns `RunStatusResult`.
It does not qualify hardware or change lifecycle.

### `resume_run`

Request body is `{ "expectedRevision": 4 }`. A resume is legal only from a
recorded waiting, blocked, or interrupted state after its prerequisite has become
true. It continues from the first eligible attempt using a new fencing epoch;
late worker output cannot commit. The synchronous handler returns HTTP 200 with
`RunStatusResult` after completion or the next explicit block. If the blocker
remains, that successful response contains the blocked run status, original
affected digests, and required action. `STAGE_BLOCKED` remains an error for
commands whose contract cannot return a blocked `RunStatusResult`.

### `list_artifacts`

REST query parameters:

- `revisionId` (optional; otherwise the run's current selection is used);
- `stage` (optional exact stage filter);
- `includeStale` (optional, exact `true` or `false`, default `false`). Other
  spellings and scalar values return `INVALID_ARGUMENT` rather than being
  coerced.

MCP uses the same names in its argument object plus `runId`. Returns `{ projectId,
runId, revisionId: string | null, artifacts }`. Each item is a complete `ArtifactRecord`; it identifies project,
run, design revision, stage, exact inputs, derived artifacts, tool, validation,
assumptions, lifecycle, content digest/size, and staleness. This operation returns
metadata, not arbitrary file bytes.

### `inspect_evidence`

REST query filters are `revisionId`, `evidenceId`, `stage`, and boolean
`includeStale` (exact `true` or `false`, default `false`; other values are
`INVALID_ARGUMENT`). MCP uses the same fields plus `runId`. Returns
`{ projectId, runId, revisionId: string | null, evidence, evidenceRoot }`. Entries are complete
`EvidenceRecord` values and the canonical root binds the returned ordered set.
Stale/revoked/waived evidence remains visible only when selected by policy/filter
and is never rewritten as pass.

### `inspect_engineering_practices`

`GET /api/v1/runs/{runId}/engineering-practices` accepts optional `revisionId`,
optional opaque `findingCursor`, and integer `findingLimit` from 1 through 100
(default 50). MCP uses the same fields plus `runId`.

The `evleda.engineering-practice-inspection.v1` result identifies the selected
revision through required `revisionId: string | null` (`null` before any head)
and states whether it is the head; binds the exact revision, evidence, board,
catalog, policy, rule-deck, analyzer, and source identities; and exposes two
independent checks:

- `checks.nativeDrc` is identified `kicad_native` evidence for the bound KiCad
  rule deck.
- `checks.evledaPractice` is separate `evleda_check` evidence for the
  source-bound engineering-practice analyzer.

It also returns complete rule coverage with literal `PASS`, `FAIL`, `UNKNOWN`,
and `NOT_RUN` counts, advisories, outstanding fabricator/human/physical gates,
and identity-bound paginated findings. The disposition is `PROVISIONAL_POC` only
for a complete current machine pass with all frozen bindings; otherwise it is
`BLOCKED_DIAGNOSTIC`. Neither disposition qualifies a board or authorizes
manufacturing or release.

Native DRC pass does not imply EvlEDA-practice pass. The retained Rev-A board is
an expected-negative proof fixture: native DRC can be clean while blocking
`ROUTE_STYLE` and `BACKTRACK` practice findings remain.

### `rerun_stage`

Request body:

```json
{
  "expectedRevision": 12,
  "reason": "Re-run after selecting a pinned footprint."
}
```

The stage comes from the REST path or MCP `stage` argument. The command appends a
new attempt, freezes a new input manifest, creates a revision branch as needed,
and marks dependent evidence stale. It never overwrites an old attempt. Returns
HTTP 200 with `RunStatusResult`.

### `export_candidate_bundle`

Request body:

```json
{
  "expectedRevision": 20
}
```

The revision ID is in the path and `expectedRevision` is the owning run's current
revision counter. A fresh export requires that exact revision to be the completed
nine-stage head with a coherent, current artifact/evidence graph; a partial run
returns `GATE_FAILED`. The result contains `fileName`, `mediaType:
"application/zip"`, ZIP `ContentIdentity`, `bytesBase64`, the complete manifest,
exact inputs, tool, validation, assumptions, and lifecycle.

Fresh exports use `evleda.bundle-manifest.v3` and `deterministic-zip-v3`. The
manifest and result contain exactly matching `liveRegenerationPolicy` values
(`scope: "live_model_or_research"`, `claim: "traceable"`, and
`reproducible: false`) and the recomputed
`evleda.live-regeneration-policy.v1` identity. Ordered current exact inputs are
the revision manifest, evidence root, then policy identity. Every v3
bundle-generated artifact binds those three inputs and its policy-bound source
ID. Current durable export receipts use `evleda.bundle-export-replay.v2`.

A candidate manifest has `bundleKind: "candidate"`, lifecycle `candidate`, and
warning exactly `CANDIDATE — NOT FOR MANUFACTURING`. Exporting does not advance
lifecycle. The high-contrast `COVER.svg` visibly renders the exact warning and
lifecycle `candidate`; it is a separate bundle-generated artifact and does not
alter or relabel stored source/native renders. `COVER.svg`, `README.md`,
`WARNING.txt`, canonical
`evidence/evidence.json`, and canonical `provenance/revision.json` are
individually listed, hashed, and given complete provenance; the manifest itself
is the only self-excluded file. Every stored artifact entry preserves its actual
`sourceDesignRevisionId`, exact inputs and dependencies, tool, assumptions,
lifecycle, and timestamps. After confined extraction, use `node
scripts/verify-bundle.mjs <bundle-directory>` for an independent read-only
inventory, byte, provenance-graph, revision-root, evidence-root, and
design-revision-ID check. Add `--expected-revision-manifest <sha256>` and/or
`--expected-evidence-root <sha256>` when comparing with trusted out-of-band
roots. The verifier intentionally does not parse archives. Legacy v1 bundles
require explicit `--allow-legacy-v1` and return only `byte_integrity_only`.
Original unlabeled manifest-v2 exports paired with replay-v1 receipts remain
replayable byte-for-byte without a synthesized policy. Standalone verification
requires `--allow-legacy-v2` and returns
`provenance_roots_without_live_policy`. Labeled/interim v2, crossed
receipt/manifest versions, and missing or mismatched v3 policy identities fail
closed. Clients must discriminate on `result.manifest.schemaVersion`.

### `export_prototype_bundle`

The request is also `{ "expectedRevision": 20 }`; the revision ID is in the path.
A fresh prototype export additionally requires a prior active human qualification
attestation bound to the exact requirements digest, design manifest, and full
evidence root, plus the completed nine-stage head. The manifest has `bundleKind:
"prototype"`, lifecycle `qualified`, and warning exactly `PROTOTYPE — NOT
PRODUCTION RELEASED`. Missing, stale, revoked, or differently bound qualification
fails closed. Its bundle-generated `COVER.svg` visibly renders that exact warning,
`CONTROLLED PROTOTYPE ONLY`, and lifecycle `qualified`. This command neither
qualifies nor releases a revision.

### `generate_bringup_plan`

Request body:

```json
{
  "expectedRevision": 18
}
```

The command generates or returns the identity-matched bring-up package for the
selected revision. Outputs include ordered guarded procedures, equipment and
current-limit prerequisites, expected limits, abort conditions, rail/programming/
communications/sensor/actuator/thermal/fault-reset checks, raw measurement forms,
pin maps, and firmware identity. It must describe unperformed physical steps as
procedures, never passing evidence. Returns HTTP 200 with `{ projectId, runId,
designRevisionId, workflowStage, artifact, revision }`.

### `generate_firmware_scaffold`

Request body is `{ "expectedRevision": 18, "language": "c" }`, where language
is optional and the request schema recognizes `c`, `cpp`, or `rust`. The current
implementation supports only `c`; `cpp` or `rust` returns `GATE_FAILED` rather
than substituting a language. The resulting contract binds the exact
schematic/revision and includes pins, voltage/current assumptions, alternate
functions, timers, interrupts, DMA, protocols, safe/boot states, fault/reset
behavior, board-revision identification, build metadata, validation stubs, and
bring-up tests. The committed stage also contains separate host validation and
STM32G0 target-build reports plus candidate ELF, BIN, and map outputs when the
exact provisioned cross-build passes. The target builder requires the
`verified-private-toolchain-closure` execution policy, hashes the private
compiler/toolchain closure, and disables linker-plugin/LTO discovery outside
that closure. These process controls are not an OS sandbox. Outputs always state
`flashable: false`, remain candidate-only, and never authorize deployment or
release. A schematic, pin-map, resource, host compiler, or target-toolchain
conflict blocks the stage.
Returns HTTP 200 with `{ projectId, runId, designRevisionId, workflowStage,
artifact, revision }`.

## Local-human-only REST operations

These routes are not MCP tools and never appear in MCP discovery. Each requires:

- an exact allowlisted browser `Origin` header;
- a valid role-scoped `X-EvlEDA-Human-Credential`;
- a 16–128 character visible-ASCII `Idempotency-Key`; and
- `expectedRevision` matching the owning run's current revision.

The credential chooses one immutable configured actor and one exact capability
server-side. The body `actor` may be omitted and injected, or supplied only when
all four fields exactly match that configured actor. It cannot select authority.
Missing, wrong, or cross-role credentials, actor mismatches, and missing or
non-allowlisted Origins return `CAPABILITY_REQUIRED` without mutation.

Configure any roles that this daemon should expose:

| Capability | Secret environment entry | Optional actor entries | Routes |
| --- | --- | --- | --- |
| Requirements review | `EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL` | `EVLEDA_REQUIREMENTS_REVIEW_ACTOR_ID`, `EVLEDA_REQUIREMENTS_REVIEW_ACTOR_DISPLAY_NAME` | requirements approval; revocation of a requirements approval |
| Hardware qualification | `EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL` | `EVLEDA_HARDWARE_QUALIFICATION_ACTOR_ID`, `EVLEDA_HARDWARE_QUALIFICATION_ACTOR_DISPLAY_NAME` | external evidence; qualification; revocation of either attestation |
| Manufacturing release | `EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL` | `EVLEDA_MANUFACTURING_RELEASE_ACTOR_ID`, `EVLEDA_MANUFACTURING_RELEASE_ACTOR_DISPLAY_NAME` | manufacturing release; revocation of a release attestation |

An absent role remains unavailable while candidate-only operation continues.
An explicit empty value or actor metadata without its credential is an invalid
startup configuration. Credentials must be distinct, canonical unpadded
Base64URL strings of 43–128 characters, decode to at least 32 bytes, and contain
at least 16 distinct characters. Generate each independently with a CSPRNG, for
example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The v2 physical acceptance/measurement contracts and derived
`evleda.human-physical-evidence.v3` record are implemented and tested. The
current Rev-A production `evleda.physical-acceptance-policy.v2` remains
`incomplete`, however, so it cannot produce an approved executable acceptance
contract. No real current-board physical record, qualification, or manufacturing
release is claimed.

The daemon deletes all raw secret entries from `process.env` before validating
them, retains only SHA-256 digests, compares request digests in constant time,
and redacts the credential header from logs. The old
`EVLEDA_HUMAN_APPROVAL_TOKEN` is rejected and has no implicit compatibility
fallback. Programmatic embedders must pass raw credentials through
`createHumanCredentialBindings`; `buildApiServer` rejects literal, copied, or
pre-hashed binding objects so embedders cannot bypass strength validation.

The connected UI omits `actor` and lets the daemon inject the configured
identity. It holds a typed credential only in active component state, marks the
input `autocomplete="new-password"`, clears it after submission, and never
writes it to project data, a URL, `localStorage`, or `sessionStorage`.

### Submit external physical evidence

`POST /api/v1/revisions/{revisionId}/external-evidence`

```json
{
  "expectedRevision": 20,
  "revisionManifestDigest": "<64 lowercase hex>",
  "evidenceRootDigest": "<64 lowercase hex>",
  "artifactBindings": {
    "bom": { "artifactId": "artifact_bom", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } },
    "cam": {
      "manifest": { "artifactId": "artifact_cam_manifest", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } },
      "artifacts": ["<every manifest-listed Gerber, drill, report, and position artifact binding except the separately bound BOM>"]
    },
    "targetBuildReport": { "artifactId": "artifact_target_build_report", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } },
    "targetBinary": { "artifactId": "artifact_target_binary", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } },
    "bringupProcedure": { "artifactId": "artifact_procedure", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } },
    "acceptance": { "artifactId": "artifact_physical_acceptance", "identity": { "algorithm": "sha256", "digest": "<64 lowercase hex>", "size": 123 } }
  },
  "sourceBlobs": ["<bounded identity-plus-base64 sources>"],
  "asBuiltRecordSourceId": "source-as-built",
  "flashedFirmwareBinarySourceId": "source-flashed-binary",
  "firmwareFlashRecordSourceId": "source-flash-record",
  "measurementRecordSourceId": "source-measurements",
  "instruments": [{ "id": "instrument-001", "calibrationSourceId": "source-calibration" }],
  "rationale": "Raw records reviewed and bound to this exact unit."
}
```

The abbreviated arrays are explanatory placeholders. A real request provides unique,
bounded, canonical-base64 sources with roles `as_built_record`,
`flashed_firmware_binary`, `firmware_flash_record`, `instrument_calibration`,
`required_capture`, optional `supporting_attachment`, and
`parsed_measurement_record`. The legacy `firmwareBuild` binding and
`raw_observation` role are accepted only when inspecting or exactly replaying the
legacy physical-v2 shape; a fresh v3-eligible submission using them fails closed.
Each blob is at most 4 MiB and
the decoded corpus at most 32 MiB; supplied SHA-256 identities are verified on store.

Measurements exist only in the stored strict `evleda.physical-measurements.v2`
source and bind an `evleda.physical-acceptance.v2` contract plus its bring-up
procedure, case executions, capture bindings, instruments, firmware target, and
raw observations. The request has no caller-controlled limit, verdict, or expiry
fields. Test IDs, quantities, required instrument capabilities, units, ranges,
conditions, durations, expected values, and capture requirements come from the
exact current-head `bringup/physical-acceptance.json`. The service also parses
strict as-built, firmware-flash, and calibration sources; requires complete
CAM-manifest equality and canonical artifact roles; and derives the v3 record's
case, observation, category, overall verdict, and policy-capped expiry. Raw
archive entries use digest-addressed paths. Qualification, status, prototype
export, and release re-read and deeply verify those stored bytes. All records
remain candidate-scoped; hashes and a human record do not prove the measurements
were honestly performed.

### Qualify a revision

`POST /api/v1/revisions/{revisionId}/qualification`

Body fields are `expectedRevision`, exact `requirementsDigest`, exact
`evidenceRootDigest`, optional exactly matching `hardware_qualifier` actor,
optional `scope`, and required `rationale`. The revision must be the completed current head, the
digests must equal its current requirements/evidence roots, and that root must
contain a current passing `evleda.human-physical-evidence.v3` record, derived
from the exact v2 acceptance and measurement contracts for the head. Any
missing, expired, malformed, failed, or stale physical record returns
`EXTERNAL_ACCEPTANCE_REQUIRED`. The result contains the bound approval and state
revision. Qualification enables only controlled prototype export; it is not
manufacturing release.

This describes the implemented capability gate, not a current qualification.
The incomplete Rev-A production acceptance policy prevents such a record today.

### Authorize manufacturing release

`POST /api/v1/revisions/{revisionId}/manufacturing-release`

Body fields are `expectedRevision`, exact revision `subjectDigest`, exact
`evidenceRootDigest`, exact `qualificationApprovalId`, optional exactly matching
`release_authority` actor, `scope`, and `rationale`. Policy requires that exact
qualification to remain active plus current passing
`human_physical` evidence bound to the revision and full evidence root. Without
that external acceptance it returns `EXTERNAL_ACCEPTANCE_REQUIRED`. Success
creates a separate exact release attestation; stored run/revision lifecycle still
remains candidate, while `get_run_status.effectiveLifecycle` derives
`release_authorized`.

This likewise describes a guarded mechanism. No Rev-A manufacturing-release
attestation exists or is authorized by the current incomplete physical policy.

### Revoke an attestation

`POST /api/v1/attestations/{approvalId}/revocation`

Body fields are `expectedRevision`, optional exactly matching human `actor`, and
`reason`. The credential-bound actor's capability must match the stored
attestation class: requirements review, hardware qualification, or release
authority. Revocation is append-only,
updates the effective lifecycle immediately, and does not erase the original
record.

## Other local REST endpoints

These convenience endpoints are not part of the fourteen MCP operations:

- `GET /api/v1/health` — initialize/check the local service;
- `GET /api/v1/projects` — list projects;
- `GET /api/v1/projects/{projectId}/runs` — list a project's runs; and
- `GET /api/v1/artifacts/{artifactId}/content` — retrieve identified artifact
  bytes with media type, download name, and SHA-256 ETag.

## Stable error semantics

| Code | Default HTTP | Retryable by itself | Meaning |
| --- | ---: | --- | --- |
| `INVALID_ARGUMENT` | 400 | no | Request/schema/enum/digest/path input is invalid |
| `CAPABILITY_REQUIRED` | 403 | no | A trusted human-only capability is absent |
| `POLICY_DENIED` | 403 | no | The requested transition/export violates policy |
| `PATH_OUTSIDE_WORKSPACE` | 403 | no | A resolved path escapes its configured root |
| `NOT_FOUND` | 404 | no | The addressed local entity or content is absent |
| `IDEMPOTENCY_CONFLICT` | 409 | no | A key was reused with a different canonical request |
| `REVISION_CONFLICT` | 409 | yes, after reread | `expectedRevision` or bound digest is stale |
| `STAGE_ALREADY_RUNNING` | 409 | yes, after status change | An active attempt already owns the stage |
| `REQUIREMENTS_NOT_APPROVED` | 409 | no | A downstream operation needs exact approval |
| `STAGE_BLOCKED` | 422 | only after remediation | Recorded blocker still prevents progress |
| `GATE_FAILED` | 422 | only after remediation | A deterministic policy/validation gate failed |
| `EVIDENCE_MISSING` | 422 | only after evidence | Required evidence node is absent |
| `EVIDENCE_STALE` | 422 | only after regeneration | Evidence does not bind the selected inputs |
| `DIGEST_MISMATCH` | 422 | no | Bytes do not match their claimed identity |
| `ARTIFACT_INTEGRITY_ERROR` | 422 | no | Stored/bundled content violates integrity invariants |
| `EXTERNAL_ACCEPTANCE_REQUIRED` | 422 | no | A human or physical acceptance step is required |
| `TOOLCHAIN_UNAVAILABLE` | 503 | yes | Required executable/sidecar cannot be reached |
| `TOOLCHAIN_UNSUPPORTED` | 422 | no | Detected version/capability is outside the pin |
| `TOOL_RESULT_INCONCLUSIVE` | 422 | only after stronger evidence | Output is malformed, ambiguous, warning-only, or incomplete |
| `INTERNAL_ERROR` | 500 | no | Unexpected internal failure with details suppressed |

`retryable` describes whether repeating may make sense after the stated condition;
it never authorizes an automatic tight loop. Tool timeouts and unexpected local
failures use a stable applicable code with a sanitized cause and are recorded as
blocked/error evidence. Missing datasheets, unavailable parts, unsupported KiCad
constructs, parity failures, stale reports, routing violations, and insufficient
simulation evidence all terminate the active attempt explicitly. Applicable
EvlEDA engineering-practice `FAIL`, `UNKNOWN`, or `NOT_RUN` results remain
blocking even when native KiCad DRC passes.

## Lifecycle invariants for clients

1. Treat `candidate` as unqualified even if every automated status is `pass`.
2. Use `effectiveLifecycle` plus `activeAttestations`; stored run/revision
   lifecycle remains `candidate` and must not be treated as the derived state.
3. Do not infer qualification from requirements approval or prototype-export
   eligibility.
4. Do not infer manufacturing authorization from generated Gerbers/CAM, bundle
   existence, KiCad success, or a model statement.
5. Display the exact bundle warning wherever an export is shown or downloaded.
6. After any design/input/tool/policy change, reread status and identities;
   previous approvals and evidence may be stale.
7. Never turn `unsupported`, `not_run`, `waived`, `stale`, `error`, or an unknown
   value into `pass`.
