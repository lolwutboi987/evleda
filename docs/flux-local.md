# Local Flux workspace

Flux is mounted beside the existing product. The existing UI remains at `/`;
the candidate-only Flux workspace is at `/flux`; all Flux HTTP operations are
under `/api/v1/flux`.

## Required setup

Use Node 24.19.0 and pnpm 11.19.0. Configure two existing, disjoint, canonical
ordinary directories:

- `EVLEDA_FLUX_SOURCE_ROOT`: either one KiCad project directory or a directory
  whose immediate child directories are KiCad projects. The UI receives opaque
  deterministic source keys, labels, and fingerprints, never filesystem paths.
  A fresh-project source is also cataloged.
- `EVLEDA_FLUX_WORKSPACE_ROOT`: private Flux state, isolated run copies,
  previews, reports, and compilation bundles. It must not be inside the source
  root and must not contain it.

KiCad 10 must be installed. Its exact CLI and PCB editor paths, bytes, PE
versions, and common canonical `bin` root come only from the pinned production
profile; there is no default-path or ambient executable fallback. Optional
`EVLEDA_KICAD_CLI` and `EVLEDA_PCBNEW` selectors are accepted only when they
exactly equal the profile paths. The selected provider
must also be authenticated: Codex/Claude CLI login for local CLI providers or
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` for HTTP providers. There is no provider,
model, executable, tier, or endpoint fallback.

Production Flux additionally requires one server-owned
`evleda.flux-production-profile.v3` JSON file. Its absolute canonical path and
exact bytes are independently pinned with all three variables below:

- `EVLEDA_FLUX_PRODUCTION_PROFILE_PATH`
- `EVLEDA_FLUX_PRODUCTION_PROFILE_SHA256` (64 lowercase hexadecimal digits)
- `EVLEDA_FLUX_PRODUCTION_PROFILE_SIZE_BYTES` (canonical positive decimal)

The profile has this closed shape for OpenAI. Arrays are non-empty, sorted,
duplicate-free, and exact; each nickname list must equal the nicknames used by
its corresponding ID list.

```json
{
  "schemaVersion": "evleda.flux-production-profile.v3",
  "provider": {
    "provider": "openai",
    "model": "exact-user-selected-model-id",
    "tier": "fast",
    "deadlineMs": 270000
  },
  "kicadToolchain": {
    "schemaVersion": "evleda.flux-kicad-toolchain-profile.v1",
    "binRoot": "C:\\absolute\\canonical\\KiCad\\10.0\\bin",
    "kicadCli": {
      "path": "C:\\absolute\\canonical\\KiCad\\10.0\\bin\\kicad-cli.exe",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "sizeBytes": 1,
      "operationalVersion": "10.0.3",
      "operationalCommit": "0000000000000000000000000000000000000000",
      "peFileVersion": "10.0.3.49839",
      "peProductVersion": "10.0.3"
    },
    "pcbnew": {
      "path": "C:\\absolute\\canonical\\KiCad\\10.0\\bin\\pcbnew.exe",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "sizeBytes": 1,
      "peFileVersion": "10.0.3.49839",
      "peProductVersion": "10.0.3"
    }
  },
  "kicadMcpRuntime": {
    "schemaVersion": "evleda.flux-kicad-mcp-runtime-profile.v2",
    "lock": {
      "path": "C:\\absolute\\canonical\\evleda\\sidecars\\kicad-mcp-pro.lock.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "sizeBytes": 1
    },
    "runtimeBundle": {
      "root": "D:\\absolute\\canonical\\kicad-inspection-runtime",
      "manifest": {
        "path": "C:\\absolute\\canonical\\evleda\\sidecars\\kicad-inspection-runtime-manifest-doc1.json",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "sizeBytes": 1
      },
      "expectedClosure": {
        "fileCount": 1,
        "totalBytes": 1,
        "manifestIdentity": {
          "algorithm": "sha256",
          "digest": "0000000000000000000000000000000000000000000000000000000000000000",
          "schemaVersion": "evleda.kicad-mcp-runtime-manifest.v2",
          "canonicalizationVersion": "evleda-c14n-json-v1"
        },
        "treeIdentity": {
          "algorithm": "sha256",
          "digest": "0000000000000000000000000000000000000000000000000000000000000000",
          "schemaVersion": "evleda.kicad-mcp-inspection-runtime-tree.v1",
          "canonicalizationVersion": "evleda-c14n-json-v1"
        },
        "python": {
          "relativePath": "environment/Scripts/python.exe",
          "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "sizeBytes": 1
        },
        "entrypoint": {
          "relativePath": "kicad-inspection-launcher.py",
          "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "sizeBytes": 1
        },
        "protocol": {
          "distribution": "kicad-mcp-pro",
          "distributionVersion": "3.33.3",
          "serverName": "kicad-mcp-pro",
          "serverVersion": "1.29.1",
          "transport": "stdio",
          "modes": ["readonly", "write"]
        }
      }
    },
    "runtimeParentRoot": "D:\\absolute\\canonical\\private-temp",
    "ipcSocketParentRoot": "D:\\EvlEDA-IPC",
    "connectionPolicy": {
      "maxConnections": 8,
      "concurrency": 1,
      "reuse": "same-live-run-bounded",
      "restart": "fail-closed-reallocate-reapprove",
      "cleanup": "after-confirmed-session-and-editor-stop",
      "unconfirmed": "retain-poison-no-retry"
    },
    "runtimePolicy": {
      "allocation": "fresh-per-connect",
      "cleanup": "required",
      "dependencyNetwork": "disabled",
      "packageResolution": "none",
      "workingDirectory": "fresh-private",
      "projectBinding": "post-connect-protocol",
      "environmentFiles": "disabled",
      "pythonLaunch": {
        "flags": ["-I", "-s", "-E", "-B"],
        "argumentCount": 5,
        "argumentsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "bytecodeWrites": "disabled"
      },
      "verificationTimeoutMs": 30000
    },
    "processTreeSupervision": {
      "platform": "win32",
      "strategy": "taskkill-tree-before-sdk-close-v1",
      "terminator": {
        "path": "D:\\absolute\\canonical\\kicad-inspection-runtime\\process-tree-terminator.exe",
        "relativePath": "process-tree-terminator.exe",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "sizeBytes": 1
      },
      "terminationTimeoutMs": 5000,
      "rootProof": "exact-child-process-handle-immediately-before-spawn",
      "earlyRootExit": "zero-numeric-signal-retain-poison",
      "activeCalls": "fence-abort-drain-before-cleanup",
      "confirmation": "taskkill-success-plus-exact-root-exit-and-close",
      "runtimeCleanup": "after-tree-confirmation-and-runtime-revalidation-only",
      "unconfirmed": "retain-poison-no-retry"
    }
  },
  "libraries": {
    "kicadMajorVersion": 10,
    "symbolRoot": "C:\\absolute\\canonical\\KiCad\\10.0\\share\\kicad\\symbols",
    "footprintRoot": "C:\\absolute\\canonical\\KiCad\\10.0\\share\\kicad\\footprints",
    "exactSymbolIds": ["Device:R"],
    "exactFootprintIds": ["Resistor_SMD:R_0603_1608Metric"],
    "stockSymbolNicknames": ["Device"],
    "stockFootprintNicknames": ["Resistor_SMD"]
  },
  "deepRules": {
    "resourceRoot": "C:\\absolute\\canonical\\evleda\\resources\\deep-pcb-rule-corpus\\v1",
    "resourceIdentity": "sha256:e3c7e2b0653c61d56125ce2d8aa7967a77a9446c941a86c8ca4b87d0d9c6698b",
    "catalogIdentity": {
      "algorithm": "sha256",
      "digest": "f65cf3c6f265bccb765e04bbf5f720cfc7caaff584c373d67fe3687bb438fe30",
      "schemaVersion": "evleda.deep-rule-catalog.v1",
      "canonicalizationVersion": "evleda-c14n-json-v1"
    },
    "selection": {
      "maxRules": 24,
      "maxPromptBytes": 8192,
      "maxPromptTokens": 8192,
      "featureCoveragePolicy": "require-all"
    }
  }
}
```

Replace the illustrative zero digests/sizes/commit with the exact installed
values. Version readiness executes only `kicad-cli version` and
`kicad-cli version --format commit` through the bounded non-GUI runner. PE
file/product versions are parsed from the already pinned executable bytes;
`pcbnew` is never launched for readiness or version discovery. Both files are
identity-rechecked around the CLI probes. The pinned Windows build must emit
the exact version or commit followed by one CRLF and no stderr; LF-only,
missing-newline, whitespace, and extra-output variants fail closed. That
`exact-crlf-v1` transcript policy is committed by the KiCad CLI binding
identity. Exact legacy v1 profiles without this section fail setup with
`KICAD_TOOLCHAIN_UNAVAILABLE`.
If either bounded non-GUI KiCad probe cannot confirm process-tree termination,
readiness instead returns `KICAD_PROCESS_TERMINATION_UNCONFIRMED` with a closed
`TOOLCHAIN_FAILURE` diagnostic identity. No Flux runtime or Flux
compilation-bundle store is created; the surrounding local service may still
use its independent application stores. Readiness polling does not retry the
probe, and the operator must inspect and terminate any retained process before
restarting the daemon.
The current runtime/Open receipt is deliberately limited to operational and
PE product version `10.0.3`; each PE file version must begin `10.0.3.` and then
bind its exact build component. A self-consistent 10.0.4 or 11.x pair is not
silently relabeled or admitted.

Production profile v3 also requires the realized shared KiCad MCP runtime.
The pinned manifest closes every directory and file in one offline runtime
bundle, including modes, link counts, CPython, installed distributions,
entrypoint, `.pth` policy, and native import closure. Readiness recomputes the
entire manifest/tree and exact Python/entrypoint identities without launching
the MCP server. Runtime uses the bundled Python directly; it never invokes
`uv`/`uvx`, resolves packages, consults an index/cache/config, or downloads.
Bundled Python starts with exactly `-I -s -E -B <canonical-entrypoint>`; the
profile binds the five-argument digest and disables bytecode writes, while the
manifest total-byte identity proves that no `.pyc` or `__pycache__` entry was
added to the realized runtime.
Each readonly or write connection receives a fresh private working directory
beneath the pinned runtime parent. Deferred sessions receive the exact
host-validated `KICAD_MCP_WORKSPACE_ROOT` at startup, before upstream
configuration initializes. The launcher validates that directory and rejects
startup project/output selectors; the normal deferred `kicad_set_project` call
selects those paths after protocol connection. For a compiled run, workspace
is the enclosing compilation directory, project is `compilation\project`, and
report output is its sibling `compilation\.evleda-mcp-output`. This permits
the authorized sibling report directory without treating it as project source
or narrowing workspace to the project directory. Environment-file loading
remains disabled and the private startup working directory is unchanged.
One bridge-owned, run-bound short IPC endpoint is shared
exactly with `pcbnew`; its raw path is never projected. The base runtime
identity and its distinct readonly inspection and write execution identities,
connection budget, working-directory policy, and process-tree authority are
bound into Open/checkpoint/approval authority. An exact v2 profile, or an
otherwise-valid v3 profile missing this section, returns
`KICAD_MCP_RUNTIME_UNAVAILABLE` with no Flux runtime.

For Windows KiCad 10.0.3, the bridge allocates a unique editor temporary root
`T` below `ipcSocketParentRoot` and binds `ipc://T\kicad\api.sock`. The GUI
receives `TEMP=T` and `TMP=T`, which produces KiCad's actual listener path.
`KICAD_API_SOCKET` and `KICAD_MCP_KICAD_SOCKET_PATH` select that endpoint for
sidecar clients; setting `KICAD_API_SOCKET` on the GUI alone is not its listener
configuration. KiCad 10.0.3 has no server socket-path override. Windows uses a
named pipe, so filesystem absence alone is not a listener-readiness check.
[Release listener source](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/api/api_server.cpp#L75-L128),
[client connection documentation](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/).

Each owned GUI receives fresh `KICAD_CONFIG_HOME=T\config` and
`KICAD_CACHE_HOME=T\cache`. Minimal pinned startup seeds enable API in
`config\10.0\kicad_common.json`, acknowledge the two first-run prompts, disable
both update checks in `kicad.json`, and supply three typed empty global library
tables. No ambient settings or plugin tree is copied. Explicit library
environment variables and project-owned tables remain intact. The empty cache
contains no telemetry opt-in file; a host `DataCollection` policy can override
that default. Normal GUI settings/cache/instance writes are allowed after the
one-use launch claim. The bridge removes only the exact owned allocation after
GUI exit and inactive sidecar state; uncertain teardown retains it. See
[the detailed startup seeds and primary sources](kicad-mcp-sidecar.md#production-windows-gui-listener).

The historical profile 07 production-path proof in
`D:\EvlEDA-attempt8-postfix-six-tools-20260908\result.json` completed all six
required read calls after one deferred project bind and confirmed unchanged
board/runtime/source hashes plus normal cleanup. It is a connection/read test
on an empty prepared board, not completion of divider or RP2350 design work.
[Proof scope and evidence identity](kicad-mcp-sidecar.md#verified-production-path-connection-scope).

Historical profile 08's separate native ERC assessment is
`D:\EvlEDA-workspace08-native-erc-20260908\post-run-assessment.json`.
It verifies zero native violations on a blank fixture, the exact pinned
executable/input/output invocation, normal deferred binding to the sibling
report directory, and cleanup. The original diagnostic harness remained
failed because it compared KiCad's source basename with an incorrectly
resolved absolute path; the assessment preserves that failure and is not a
clean harness exit. This limited integration result does not establish
full-divider completion. [ERC scope and diagnostic limitation](kicad-mcp-sidecar.md#profile-08-native-erc-diagnostic).
The later real native `-02` probe verified schematic authoring/connectivity,
bare names, managed native classes, and ERC zero violations. PCB sync was
never dispatched: the preimage comparison failed on physical LF/CRLF, then
old configuration-response recovery failed. Its failed result remains intact.
The later `-05` run reached post-sync comparison and failed there. Its exact
captured disk/live pair has 1,995 identical remaining raw tokens after the
evidenced physical CRLF, ASCII layout, and pinned generated direct-footprint
header differences are accounted for. The reviewed comparison helper now
preserves the full ordered raw-token stream and exact EOF policy; raw disk
hashes remain authority. Seventy-five helper tests, 170 caller tests, and
TypeScript checks passed. Native `-06`, effective live-board class readback,
and all 43 terminal divider passes remain unproven; captured-pair equality
does not establish accepted layout. Runtime/profile 10 are unchanged.
[Probe evidence and engineering boundaries](kicad-mcp-sidecar.md#native--02-probe-and-private-live-board-boundary).
[Current populated-board comparison](kicad-mcp-sidecar.md#captured--05-pair-and-current-board-comparison).

Every Windows bounded probe or CLI-provider turn receives the same explicit
manifest-contained process-tree terminator authority: absolute helper path,
exact SHA-256 and byte size, fixed bundle working directory, and the closed
two-key `{SYSTEMROOT,WINDIR}` environment. The runner never discovers a helper
from ambient `SystemRoot`, `PATH`, or `COMSPEC`, and it never forwards provider
credentials. It hashes through a bounded open descriptor, keeps that witness
through the helper launch, and reopens/re-hashes/reasserts the path and parent
directory after helper exit before accepting tree termination. Missing or
drifted authority returns typed termination-unconfirmed readiness; it cannot
silently fall back to a different helper.

That legacy/missing-toolchain setup case is deliberately narrower than general
profile validation: only an otherwise valid, exact known v1 or exact
v2-minus-toolchain shape maps to setup readiness. An unsupported schema
version, an extra top-level field even when the toolchain is missing, an
invalid profile digest/size, or another malformed closed authority profile
remains `COMPILER_PROFILE_INVALID` and aborts startup before application stores
are constructed; it is not normalized into the always-mounted setup-readiness
surface.

OpenAI accepts only `standard` or `fast`; `fast` is bound as the Responses
canonical `priority` tier. Anthropic, Codex, and Claude CLI require
`provider-default`. The exact model ID is intentionally public in readiness
and policy, so production accepts only the bounded identifier characters
`A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `@`, `+`, and `-`; path-like and
credential-shaped values are rejected. Codex and Claude CLI profiles also require an `executable`
object with exact `path`, lowercase `sha256`, `sizeBytes`, and exact `version`.
The daemon checks those bytes, runs bounded local version/authentication probes
bracketed by identity rechecks, and revalidates the same bytes before and after
each turn. The only currently supported Codex binary is `codex-cli 0.153.4`.
Before constructing a Flux runtime, the daemon also runs that pinned binary at
a guaranteed no-prompt/no-model boundary with the exact production arguments
and shallow output schema. The expected no-prompt results are identity-bound.
Pinned Codex 0.153.4 has two observed closed-stdin renderings:
the 30-byte `No prompt provided via stdin.\n` form emitted through the
production bounded runner and the 59-byte `Reading prompt from stdin...\nNo
prompt provided via stdin.\n` form emitted by the synchronous compatibility
probe. Only those exact LF byte transcripts are accepted, together with exit
code 1, no termination signal, empty stdout, an unchanged schema, and no output
file; trimming, CRLF substitution, extra config/auth text, or near-matches fail.
The retained transcript receipt is
`tests/fixtures/codex-cli-0.153.4-config-preflight-transcripts.json`. Any
config/schema/version drift returns
`CODEX_CONFIG_INCOMPATIBLE` readiness and does not mount Flux. Portable Node
cannot execute a binary by an already-verified
file descriptor on every supported OS, so a hostile same-user namespace race
still requires an outer restricted account/container for complete isolation.
If the no-model preflight cannot confirm that its process tree terminated,
readiness instead returns `PROVIDER_PROCESS_TERMINATION_UNCONFIRMED` with a
closed `PROVIDER_REQUEST_FAILED` diagnostic identity. Flux remains unmounted,
the private preflight directory is retained, and the host must be inspected
before retrying; this condition is never mislabeled as configuration drift.
The same static setup reason is used when the bounded provider version or
authentication probe cannot confirm tree death. Its closed evidence commits
only to provider, probe kind, executable identity, bounded primary class, and
confirmation category; readiness polling never reruns the probe, and no raw
output, path, argument, or credential is projected.
Codex runs read-only and ephemeral, with user config and rules ignored;
model-run subprocesses inherit no parent environment, the pinned feature flag
removes image inspection, the effective top-level setting disables web search,
and the outer Codex child receives no API-key variable. The full pinned disable
vector removes plugin, app, remote-plugin, agent, input, planning, shell, and
unified-exec features. A no-model fake Responses capture for the pinned
`gpt-5.6-sol` profile still exposes intrinsic `functions.exec` and `wait`, with
nested `apply_patch`; there is no supported global zero-tools switch. The
read-only sandbox is therefore the mutation boundary, not a tool-free or
no-read promise. Claude runs with tools disabled and session persistence
disabled. Do not select the Codex CLI adapter when
the prompt or host contains data that must not be readable by that local
process; use a provider boundary with an actual no-tools request instead.
The path-free no-model capture receipt is retained at
`tests/fixtures/codex-cli-0.153.4-no-model-tool-profile.json`; `pnpm run
check:codex-cli-evidence` recomputes its inventory SHA-256 and requires its
executable/version/argument/environment-policy binding to match the adapter.
For that reason, the Codex provider object must additionally contain the exact
profile-bound acknowledgement `"allowCodexLocalRead": true`. When it is absent
or false, no Flux interpreter/runtime is composed and readiness returns
`CODEX_LOCAL_READ_ACK_REQUIRED`. A ready Codex projection reports
`localReadCapability: "read_only_host_files"`; other providers report `none`.

Codex transports provider output through a closed shallow strict envelope with
an exact schema version, assistant message content, explicit call-presence
boolean, an array of explicit call IDs/names/`argumentsJson` strings, and stop
reason. The output schema dynamically constrains call names to the request's
allowed or required tool. An empty array plus `hasToolCalls: false` is the exact
no-call sentinel. This avoids sending the full PCB intent schema's unsupported
deep constructs through Codex 0.153.4 strict Structured Outputs while keeping
the transport inspectable. The server parses only each bounded `argumentsJson`
string, reconstructs the normalized turn, and then applies the complete
`HarnessProviderTurn`, tool allowlist, exact-required-tool, and PCB intent
validators. The prompt includes a transport-valid `call_1` example using the
actual allowed/required tool name; its empty `argumentsJson` string must be
replaced with the complete argument object. No truncation or schema weakening
is accepted. Production Flux CLI turns start their child-process deadline at
262 seconds, reserving 8 seconds inside the public 270-second interpretation
ceiling for the 6.25-second worst-case bounded process-tree termination and
isolated-directory cleanup path plus scheduling margin.

The local `fluxctl` source-control client applies separate HTTP observation
deadlines, including response-body parsing and same-intent replay:

| Client command | Deadline |
| --- | --- |
| `open` (`flux_open`) | 120 seconds |
| `interpret`, `answer` / clarification, `checkpoint` | 300 seconds |
| All other requests, including create, prepare, approve, resume, inspect, status, and reports | 30 seconds |

The interpretation operations leave a 30-second margin after the 270-second
interpreter ceiling; checkpoint similarly wraps the server's 270-second
checkpoint-observation ceiling. The 120-second Open observation window does
not change server deadlines or authorize another editor launch after a lost
response. Reconcile a pending intent with the same journal and idempotency key.
These client limits are separate from the fixed 30-second MCP runtime
verification deadline. [CLI recovery behavior](flux-control-cli.md).
The standalone harness/provider default remains 90 seconds outside production
Flux composition.

Rejected Codex envelopes also produce one private
`evleda.provider-failure-evidence.v1` record. It contains only a closed failure
leaf, checkpoint booleans, adapter/parser/schema identities, bounded byte
counts and SHA-256 commitments, and at most 16 allowlisted issue tuples. The
canonical record is capped at 4 KiB and stored by its public diagnostic
evidence identity. Raw output, arguments, prompts, command lines, paths, and
credentials are never retained in that record or projected through HTTP/UI.

Host-side PCB interpretation failures that do not carry that richer provider
record instead produce one private
`evleda.flux-pcb-interpreter-failure-evidence.v1` record. Its exact closed
fields retain only the interpreter error code, a derived category, and the
corresponding public diagnostic code. Request-validation and provider-output
classes project as `PROVIDER_RESPONSE_INVALID`, refusal and otherwise
undiagnosed provider failures project as `PROVIDER_REQUEST_FAILED`, timeout and
cancellation retain their dedicated provider diagnostics, and compiler,
compilation-validation, and bundle classes project as `TOOLCHAIN_FAILURE`.
The record contains no model text, error message, stack, prompt, path,
credential, or provider output, remains capped at 4 KiB, and is stored only in
the private operation-failure evidence map by its public evidence identity.

The OpenAI HTTP adapter sends `store:false` and never supplies
`previous_response_id`. It privately retains a bounded, closed, validated copy
of every native reasoning/message/function output item by response ID, then
replays those exact items and subsequent tool outputs in order. Opaque
reasoning never enters reports or public DTOs; missing, evicted, restarted, or
transcript-mismatched state fails before a request. Function strict mode is
enabled only when the original schema is already closed and all fields are
required; optional host schemas are sent unchanged with `strict:false`. Both
the response and every returned item must be completed before text or calls
cross the adapter boundary.

Profile 09 and its actual referenced runtime/manifest paths remain unchanged
for historical reproducibility. Fresh execution requires the separately
versioned doc1/private-document runtime and current profile 10:
`C:\Users\pc\Downloads\EvlEDA-Handoff-2026-09-03\flux-generic-divider-production-profile-20260908-10.json`:
5,294 bytes, SHA-256
`11702e6d33eb90e9d496c5860dc1cca656fc65cfbce12e4d40417d20b287c42c`,
Codex `gpt-5.6-sol`, `provider-default`, and the pinned KiCad 10.0.3 installation
under `D:\Codex-Recovery\KiCad\10.0`. Its runtime root is
`D:\Codex-Recovery\tools\kicad-mcp-pro\inspection-runtime-3.33.3-doc1`.
The installed workspace-aware launcher is 4,240 bytes, SHA-256
`6e14445317f1e4b6eed1df1f908437b9469fa6218861bc3a098d5c3582adcfed`.
The versioned `sidecars/kicad-inspection-runtime-manifest-doc1.json` is
1,573,530 bytes, SHA-256
`d1004ff51b8d7001f220409f39a008439c3b2da65abc37e312c3d3a589fbaa0a`.
It binds the [private document addon](../sidecars/doc1-runtime.md) and retains
the [recorded explicit-junction reader patch](../sidecars/patches/README.md).
Published base provenance stays separate from locally executed bytes. The
Python argument digest is repinned because it includes the new absolute
launcher path; flags remain `-I -s -E -B`.
Provider, toolchain, library, sidecar-lock, and deadline policies remain
unchanged. Profiles 07 through 09 are historical; current receipt envelopes remain
unchanged and carry the current evidence children described below.
The earlier JSON block illustrates the schema, not a replacement profile.

The source load-only readiness check returned `ready` in 17.977 seconds with
Node 24.19.0, exit 0. It used five non-model probes and did not create a Flux
runtime/store, sidecar session, GUI, server, or model request. This verifies
startup composition, not native addon compatibility, synchronization, or the
full divider. The sibling profile 10 `.verification.json` retains the evidence.

A current profile 10 startup example follows; source and workspace roots must
remain disjoint:

```powershell
$env:EVLEDA_FLUX_SOURCE_ROOT = (Resolve-Path '.\fresh-canary-20260906\project').Path
$fluxWorkspace = Join-Path (Get-Location) '.cache\flux'
New-Item -ItemType Directory -Force -Path $fluxWorkspace | Out-Null
$env:EVLEDA_FLUX_WORKSPACE_ROOT = (Resolve-Path $fluxWorkspace).Path
$env:EVLEDA_FLUX_PRODUCTION_PROFILE_PATH = (Resolve-Path 'C:\Users\pc\Downloads\EvlEDA-Handoff-2026-09-03\flux-generic-divider-production-profile-20260908-10.json').Path
$env:EVLEDA_FLUX_PRODUCTION_PROFILE_SHA256 = '11702e6d33eb90e9d496c5860dc1cca656fc65cfbce12e4d40417d20b287c42c'
$env:EVLEDA_FLUX_PRODUCTION_PROFILE_SIZE_BYTES = '5294'
pnpm dev:flux
```

The KiCad environment selectors are optional redundancy. If used, they must
exactly repeat the profile paths:

```powershell
$env:EVLEDA_KICAD_CLI = 'D:\Codex-Recovery\KiCad\10.0\bin\kicad-cli.exe'
$env:EVLEDA_PCBNEW = 'D:\Codex-Recovery\KiCad\10.0\bin\pcbnew.exe'
```

Open `http://127.0.0.1:5173/flux`. Production build and start are `pnpm build`
followed by `pnpm start:flux`; the production UI is then
`http://127.0.0.1:8765/flux`.

`GET /api/v1/flux/readiness` is always mounted on a running daemon. It returns
only setup reason codes or safe provider/compiler/toolchain identities,
versions, and counts. It
never returns credentials, profile/library/executable paths, raw process
output, or raw setup errors. Setup and terminal provider failures may include
only the closed `evleda.flux-diagnostic.v1` code plus a SHA-256 identity of
bounded categorical evidence; titles and remediation are fixed by the UI and
never inferred from provider prose. `/api/v1/flux/policy` remains the separate lifecycle authority used to
create runs; browser-supplied provider/model/tier values must match it exactly.

## Iteration budgets and approval

Fresh projects accept 1 through 24 authoring iterations. Flux recommends 12,
and `fluxctl create-run` uses 12 when `--iterations` is omitted. The standalone
PCB CLI keeps its existing default of 3, including fresh projects:

| Entry point | Allowed iterations | Default |
| --- | --- | --- |
| Flux fresh run / `fluxctl create-run` | 1–24 | 12, also recommended |
| Standalone `pcb-agent`, fresh project | 1–24 | 3 |
| Standalone `pcb-agent`, copied board | 1–5 | 3 |

A fresh requested cap above 12 selects the existing `maxMessages=256` hard
ceiling. Fresh caps through 12 retain the 64-message default. Codex/Claude CLI
execution above 12 also selects the existing 1 MiB `maxOutputBytes` ceiling,
which bounds framed input and process/final-message output; lower caps retain
the 256 KiB CLI default. This iteration-budget change does not raise other
tool/payload limits or any timeout. The HTTP observation deadlines remain
Open 120 seconds, interpret/clarify/checkpoint 300 seconds, and other requests
30 seconds. [Shared iteration policy](../src/harness/pcb-agent-harness.ts),
[execution resource selection](../src/cli/pcb-agent.ts).

24 is a ceiling, not a success guarantee. Resource limits, tool failures,
timeouts, and acceptance gates can terminate a run earlier. The chosen
`iterationCap` is part of the new run's approval subject and execution
authority. A larger requested budget requires a new run and its own completed
prepare/Open/checkpoint/approval lifecycle. Historical 12-iteration records
remain evidence of their original budget. The already-consumed attempt13 run
cannot be resumed or granted extra attempts by this policy update; terminal
replay does not re-execute it, and a different resume key does not replace
consumed approval. [Control and replay behavior](flux-control-cli.md).

## Checkpoint failure settlement

Checkpoint settlement and client deadline handling are implemented. After
admission, checkpoint failures abort remaining work, clear the in-flight
operation, and settle the run/key once as blocked/failed with nonretryable
`OPERATION_UNCERTAIN`. Timeout wording requires an expired 270-second server
deadline; other admitted failures use the generic checkpoint-failure message. Late
continuations cannot publish success after failure settlement. The commit
guard still permits an atomic rename already issued before the deadline to
win the single terminal transition.

The client authenticates the checkpoint's
`evleda.flux-terminal-failure-receipt.v2` against the current blocked run and
settles the matching local intent. Same-key replay retrieves the recorded
failure, including after restart, without launching another checkpoint.
A transport loss without an authenticated terminal receipt leaves the local
intent pending. The observation deadlines remain Open 120 seconds;
interpret/clarify/checkpoint 300 seconds; other requests 30 seconds.
[Server settlement](../src/flux/run-manager.ts),
[client authentication and replay](flux-control-cli.md).

## Authored netclass evidence

Current generic preparation writes one host-generated, escaped, anchored
exact `net_settings.netclass_patterns` entry per contract net, bound to its
bundle-managed class. Matching is case-sensitive under the supported closed
net-name grammar; literal `.` and `+` are escaped. Readback validates the exact
records, not arbitrary regular-expression equivalence. The schematic-derived
`netclass_assignments` cache must be empty (`{}` or native `null`); a populated
cache is rejected and cannot stand in for authored assignment authority.
[Assignment model](../src/harness/fresh-netclass-assignment.ts),
[materialization and readback](../src/harness/fresh-clearance-evidence.ts).

The five current child evidence schemas use v2:
`evleda.fresh-netclass-materialization.v2`,
`evleda.fresh-netclass-semantic-authority.v2`,
`evleda.fresh-netclass-preparation-evidence.v2`,
`evleda.fresh-clearance-evidence-receipt.v2`, and
`evleda.fresh-clearance-rule-source-set.v2`. They bind the authored-pattern,
empty-derived-cache, exclusive-contract-assignment model. Configuration
evidence does not by itself prove native schematic/PCB class agreement or
geometric clearance.

The persisted Flux root is `evleda.flux.v10`. Current Open, checkpoint,
approval, and report envelopes retain their versions while requiring current
v2 children. Historical v1 evidence, identities, reports, and events remain
readable for review. Stale prepared/completed generic runs are fenced as
`needs_review`; their cache-only evidence is not promoted to current authority,
and a new run must be prepared before approval or execution.
[Legacy review and migration](../src/flux/run-store.ts),
[historical validators](../src/flux/legacy-netclass-evidence.ts).

The native `-02` schematic stages confirmed the authored assignments and bare
names, with exact managed native classes and ERC zero violations. Its sync
stage never dispatched, so saved/live PCB class agreement and a terminal
passing report for all 43 divider acceptance rows remain unproven. New host
authority reads exact native document/source through the private reader before
chat sanitation. Board comparison retains all ordered raw tokens except ASCII
layout whitespace and the complete pinned direct-footprint header, with
physical outside-string CRLF handling and exact EOF policy. The separate native
netlist comparator masks only the direct export timestamp. Raw identities,
strings, numeric spelling, and all other data remain exact. The failed `-05`
capture supports this serializer boundary only; native `-06` and full
acceptance remain pending.
Follow the [active roadmap](active-roadmap.md) for the remaining proof and the
required GitHub push before the RP2350 demonstration.

## Live run sequence

The standalone backend defaults every newly created run to
`workflowKind: "generic"`. Before any KiCad preparation it requires the
provider-neutral, non-mutating contract lifecycle:

1. `POST /api/v1/flux/runs/:runId/interpret` moves `draft -> interpreting` and
   persists either `awaiting_clarification` or `contract_ready`.
2. `GET /api/v1/flux/runs/:runId/contract` returns only the bounded path-free
   contract projection, questions/issues, compiler-owned identities, and the
   interpreter receipt.
3. `POST /api/v1/flux/runs/:runId/clarifications` accepts one closed
   `{ answers: [{ id, answer }] }` batch and recompiles. Recompilation
   invalidates any isolated fingerprint, preview, checkpoint state, or
   approval.
4. `POST .../prepare` is rejected unless the generic compilation is ready.
   Approval binds the exact provider profile, compilation bundle, contract,
   library, KiCad toolchain, deep-rule, practice, prompt, and acceptance identities; every
   later lifecycle boundary reloads and re-verifies the stored bundle.

The earlier direct LED flow remains only as the explicitly requested
`workflowKind: "led_compatibility_fixture"`; it is not the default generic
workflow.

After `contract_ready`, Prepare creates a bundle-identity-specific isolated
directory and preview. Open launches only that isolated board. Fresh projects
must then complete provider-free Checkpoint Open before Approval. Resume
consumes the one-time approval and globally serializes KiCad writes.
`completed`, `needs_review`, `blocked`, and `failed` remain distinct terminal
dispositions, while report history exposes only canonical report SHA-256, safe
summary/disposition, fresh acceptance rows/hashes, and durable board-save
identity audits.

There is no generic file endpoint, raw HTML renderer, manufacturing action,
bundle download action, or release action in Flux.
