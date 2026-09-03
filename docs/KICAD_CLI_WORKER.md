# Pinned KiCad 10 CLI worker

`backend.kicad_worker.LocalKiCadCliService` is the concrete host-side verification
implementation for `backend.mcp_server.hooks.KiCadOperationService`. It runs genuine ERC/DRC
against one exact managed project revision. It does not accept a path, shell fragment,
environment variable, or arbitrary command from a tool caller.

## Pinned host runtime

The reviewed KiCad runtime contract is:

- executable: a reviewed absolute `--kicad-cli` path, or an automatically
  selected non-link executable in a protected official platform installation;
  `PATH` and executable-selection environment variables are not searched
- KiCad version: `10.0.6`
- executable SHA-256: `393525236969434e24bc710334efe244fb285ef6596a1aea8e74353ef4db5477`

`WorkerPolicy` requires the exact executable hash and exact patch version. Construction fails
if either differs. The executable is hashed again immediately before a verification run.

## Trusted host bindings

The host injects two narrow interfaces:

- `ManagedBundleResolver.resolve_bundle(project_id, expected_project_revision)` returns exact
  `ProjectBundleInput.all_files`: `.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, and the complete
  compiler-owned auxiliary set, including project library tables, `.kicad_sym`, `.pretty`
  modules. One domain-separated digest binds every relative name, media type, length, and byte
  payload. Active `.kicad_prl` UI state is forbidden in this source set.
- `ManagedArtifactPublisher.publish_artifact(...)` is reserved for future reviewed render/export
  adapters. Verification never calls it.

`ManagedKiCadBundle` rejects path syntax in its stem, mismatched project/revision identity,
non-byte payloads, unsorted or case-colliding auxiliary names, reserved report shadows, and a
digest that does not bind the complete file set. Tool arguments remain the existing closed MCP
shape:

```json
{
  "project_id": "project-1",
  "expected_project_revision": "rev_<64 lowercase hex>",
  "checks": ["drc", "erc"]
}
```

The checks must be sorted and unique. No argument can select an executable, source/output path,
working directory, environment, timeout, report format, severity, or rule switch.

## Exact execution policy

The worker creates a fresh per-operation directory beneath the host-configured root. A monitored
project child contains only the complete digest-checked bundle plus declared JSON reports; a
separate sibling holds cwd, home, config, documents, cache, and temp state. Nested managed parents
are created one segment at a time and reject symlinks/reparse nodes. Files use exclusive creation,
fsync, readback, and hashing. Recursive inventories before, between, and after native commands
reject any absent, added, case-colliding, reparse, `.kicad_dru`, library-table, `.pretty`, or other
undeclared project node. The worker invokes argv directly with `shell=False` and removes the whole
operation directory afterward. Stdout and stderr are concurrently drained with independent hard
byte caps; timeout or either cap kills the process.

KiCad 10.0.6 unavoidably needs a same-stem `.kicad_prl` while it runs. The worker, never the
resolver or MCP caller, injects the proven 2,306-byte LF-only file as runtime support. Its template
version and hash are part of `WorkerPolicy`; its stem-specific manifest is bound into the journal,
MCP evidence, and native report. The worker verifies the PRL byte-for-byte before, between, and
after checks, then discards it with the temporary operation directory.

ERC is always:

```text
kicad-cli sch erc --format json --severity-all --exit-code-violations \
  --output <WORKDIR>/erc.json <WORKDIR>/<stem>.kicad_sch
```

DRC is always:

```text
kicad-cli pcb drc --format json --severity-all --schematic-parity \
  --all-track-errors --exit-code-violations \
  --output <WORKDIR>/drc.json <WORKDIR>/<stem>.kicad_pcb
```

Zone refill is disabled by default. The explicit `refill_zones_on_temp_copy` policy adds only
`--refill-zones` to DRC. It never adds `--save-board`. Every primary and auxiliary source file is
hashed before, between, and after checks; any change fails the operation.

## Closed report and outcome semantics

Only the closed KiCad 10 schemas below are accepted:

- `https://schemas.kicad.org/erc.v1.json`
- `https://schemas.kicad.org/drc.v1.json`

The parser rejects duplicate keys, unknown/missing fields, non-finite numbers, wrong version,
wrong source basename, wrong coordinate units, unrecognized severities/types, malformed UUIDs,
sub-nanometre coordinates, and output/report size violations. Coordinates become signed integer
nanometres. Findings and nested items are canonically sorted; the wall-clock `date` is validated
but excluded from normalized evidence.

Exit `0` is accepted only with zero findings. Exit `5` is accepted only with one or more parsed
findings and returns `KiCadServiceResult(succeeded=False, ...)`. Every other exit is a typed tool
error, never a DRC/ERC result. The MCP-compatible payload contains the exact project/revision,
checks, pass flag, blocking count, findings-manifest digest, and the summary digest required by the
existing hook. The findings manifest includes the opened-bundle and before/after file hashes plus
each raw/normalized report, command, and output digest, so `KiCadExecutionEvidence.payload_digest`
transitively binds those native subjects. `KiCadExecutionEvidence` also directly binds the request,
policy, worker/version, revision, opened complete-bundle digest, idempotency key, and aggregate
native exit.

The richer sealed journal report additionally binds:

- the opened managed-bundle digest and each source-file hash before/after KiCad;
- logical argv and argv digest for each check;
- native exit, bounded stdout/stderr text and hashes;
- raw KiCad JSON report SHA-256 and normalized parsed report;
- normalized findings and the MCP payload/evidence digests;
- `manufacturing_release_eligible: false`.

## Durable idempotency

`SQLiteIdempotencyJournal` uses `BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, strict schema, a
compare-and-swap finalization, and a host-supplied stable HMAC-SHA256 key. Its identity matches the
MCP cache scope: actor, operation, worker-policy digest, and idempotency key. The row also binds the
request, project/revision, opened source bundle, and runtime-support manifest.

- A completed retry reconstructs and revalidates the exact result without starting KiCad.
- A terminal tool failure is replayed without starting KiCad.
- A changed request/bundle under the same key is an idempotency conflict.
- A bad HMAC or row shape is reported as journal tampering.
- A process crash after the durable `running` claim is ambiguous and will never be re-executed.

This conservative rule also applies to current read-only verification and is ready for future
operations with external mutation/publication effects.

## Live evidence (2026-08-31)

The canonical reference host now opens compiler v3.0.0's complete 27-file source bundle in
KiCad 10.0.6. Real MCP-dispatched ERC and DRC both return exit `0`, zero findings, and
`blocking_findings: 0`; this is a real passing native verification rather than a fixture result.

- canonical revision:
  `rev_af844937e7d7f0689c6076250d80f30b7057d70cc821ff8fc54e28940c709068`
- compiler source-bundle digest:
  `95421679d2118f555068224dddf90350255e23fc607cb36ef78487a17524b406`
- auxiliary manifest digest:
  `d90d7beb4fbf2f89e306b7f71ca48b0a5c344c86023011dff0838b793b067fb7`
- worker managed-source digest:
  `bc67a78ccd0f02940b42f19684f67988a13c022b58318cf7a8dc41d643963438`
- worker runtime PRL: 2,306 LF-only bytes, SHA-256
  `21f5f814730bd4668286477f0dd098b565b4c9aac5417763909cbba7242095c8`

All 27 source files and the separately policy-bound PRL were byte-identical before, between, and
after both commands. The installed `ecc83-pp` demo intentionally remains an incomplete-source
negative test: a real runner injects an undeclared file after ERC and the worker rejects it before
DRC.

## Deliberate non-claims and remaining integration

- `import_project`, `export_project`, and `render_project` return typed unconfigured failures.
- No result from this worker authorizes manufacturing. Zero ERC/DRC alone would not prove
  stackup, finish, mask/paste, drill/fab tolerances, assembly documentation, human review, or
  release approval.
- `backend.mcp_server.reference_host` now wires this worker to the exact, reparsed reference
  artifact with an external stable journal key, keyed journal sentinel, read-only gateway adapter,
  and explicit `inspect_project`/`kicad_verify` allowlists. Import, export, and render remain absent.
  See `REFERENCE_MCP_HOST.md`.

## Verification commands

```powershell
python -m pytest -q tests\kicad_worker
ruff check backend\kicad_worker tests\kicad_worker --select E,F,I,UP,B,SIM
```
