# KiCad-MCP sidecar verification

Production Flux uses the manifested offline `kicad-mcp-pro` runtime and a
run-bound KiCad GUI listener. The optional real-sidecar suites separately
exercise the published wheel and manifested launcher. Connection and read
checks do not qualify or release a PCB design.

## Locked runtime

`sidecars/kicad-mcp-pro.lock.json` is the machine-readable authority for these
wheel-smoke toolchain and distribution identities. The production bundle's
Python launcher and complete runtime tree are separately pinned by
the versioned `sidecars/kicad-inspection-runtime-manifest-doc1.json` and the
production profile. The earlier unsuffixed manifest is retained with profile 09.

| Item | Version / size | SHA-256 |
| --- | --- | --- |
| Official `uv` Windows archive | 0.11.31 / 25,653,699 bytes | `410c2fd3126ff621c9450a21cfc200002c7540dc48d130069a8f619cdb0a811b` |
| `uv.exe` extracted from that archive | 0.11.31 / 76,180,480 bytes | `f9984f1375c819a42f59de73abc468eb76abef0a9a4097167b0a770ede81dc18` |
| `uvx.exe` extracted from that archive | 0.11.31 / 339,456 bytes | `27de9e9f6a5089bead9fcbbeff46bf4da34862430b8f949b5d9b1e4b0c916911` |
| Official managed CPython archive | 3.13.12 / 21,724,944 bytes | `34bb9427d022c2810387e1376c6e184d3f3fdd0984b28519ac58295b0ba1adde` |
| Managed `python.exe` | 3.13.12 / 91,648 bytes | `264a93517ecc069ee57dff451b66ed1c7b8d8543911f3d86e494ac44e96d6a10` |
| Published `kicad-mcp-pro` wheel | 3.33.3 / 905,627 bytes | `c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f` |
| Wheel Core Metadata | 3.33.3 / 18,349 bytes | `6bd08b36cb18b43b2584e37d2c6b344254d16b72472ed9e7b5ee7993865184f2` |

The `uv` and Python versions match the audited upstream commit's `Dockerfile`
and `.python-version`. The runtime lives under `D:\Codex-Recovery\tools`; its
cache, home, temporary files, and smoke workspaces are also confined to `D:`.
No administrator installation is required.

The wheel digest identifies the exact published bytes. The audited Git commit
identifies reviewed source. These remain separate provenance claims because the
PyPI release has no cryptographic build-from-commit attestation.

## Offline wheel smoke launch and identity behavior

The optional wheel smoke suite's invocation is equivalent to:

```text
D:\Codex-Recovery\tools\uv\0.11.31\uvx.exe
  --offline --no-config
  --python <locked D: python.exe>
  --from <locked D: kicad_mcp_pro-3.33.3-py3-none-any.whl>
  kicad-mcp-pro
```

The test preflight hashes every locked artifact and parses the wheel Core
Metadata before launch. The controller receives the expected `uvx.exe` SHA-256
and size, resolves it once to an absolute regular file, and rechecks that
identity around tool calls. The preflight also verifies `uv.exe`, because the
Windows `uvx.exe` launcher delegates to its sibling executable.

The exact wheel reports package version `3.33.3` through its version command and
tool output, but its MCP `initialize` response advertises `serverInfo.version`
`1.29.1`, the resolved MCP SDK version. The lock records both values. Code must
not reinterpret that protocol field as the wheel identity or accept version
text in place of the wheel hash.

## Production Windows GUI listener

Production uses the manifested
`D:\Codex-Recovery\tools\kicad-mcp-pro\inspection-runtime-3.33.3-doc1`
bundle directly, without `uvx` or package resolution. Fresh execution requires
profile 10:
`C:\Users\pc\Downloads\EvlEDA-Handoff-2026-09-03\flux-generic-divider-production-profile-20260908-10.json`
(5,294 bytes; SHA-256
`11702e6d33eb90e9d496c5860dc1cca656fc65cfbce12e4d40417d20b287c42c`).
It pins the 4,240-byte installed `kicad-inspection-launcher.py` at SHA-256
`6e14445317f1e4b6eed1df1f908437b9469fa6218861bc3a098d5c3582adcfed`
and `sidecars/kicad-inspection-runtime-manifest-doc1.json` at SHA-256
`d1004ff51b8d7001f220409f39a008439c3b2da65abc37e312c3d3a589fbaa0a`
(1,573,530 bytes). The checked-in launcher source is versioned as
`sidecars/kicad-inspection-launcher-doc1.py`. The sibling addon
`evleda_live_pcb_document.py` is 8,870 bytes, SHA-256
`c824eac600fef0b21166d77c991397006a90415adff42df4b5c8b5e171bf8db4`.
Provider, KiCad toolchain, sidecar distribution, and deadline policies are
unchanged from profile 09. The new absolute launcher path requires its own
five-argument digest, recorded by profile 10. The read-only invocation remains:

```text
<bundle>\environment\Scripts\python.exe
  -I -s -E -B <bundle>\kicad-inspection-launcher.py
  --profile full --mode readonly
```

The five base Python arguments remain profile-bound; the controller appends
the profile and mode. Every deferred session now receives the exact
host-validated `KICAD_MCP_WORKSPACE_ROOT` at startup. The launcher requires an
existing absolute canonical directory with no link/reparse ancestors. It
still rejects startup project, project-file, PCB-file, schematic-file, and
output selectors. Project/output selection happens through the normal
deferred `kicad_set_project` call after connection.

For a compiled run, workspace authority encloses both sibling directories:

| Authority | Path |
| --- | --- |
| Startup workspace | `<compilation>` |
| Deferred project | `<compilation>\project` |
| Deferred report output | `<compilation>\.evleda-mcp-output` |

Supplying the enclosing workspace before upstream configuration initializes
allows the normal deferred bind to accept report output beside the project.
It avoids collapsing workspace authority to the project directory or moving
reports into project source. Startup workspace binding does not select the
project: private working directories, disabled environment-file loading, and
the deferred project/output checks remain in force.

For pinned Windows KiCad 10.0.3, the GUI listener is
`ipc://<T>\kicad\api.sock`, where `T` is one bridge-owned, unique `e-*`
directory below the profile's IPC parent. The GUI receives `TEMP=T` and
`TMP=T`. KiCad 10.0.3 derives the listener from its temporary directory and
has no socket-path override in its server interface. Setting
`KICAD_API_SOCKET` alone on `pcbnew` does not configure that listener.
[Release server source](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/api/api_server.cpp#L75-L128),
[release server interface](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/include/api/api_server.h).

The sidecar receives that exact endpoint in `KICAD_API_SOCKET` and
`KICAD_MCP_KICAD_SOCKET_PATH`. KiCad itself supplies `KICAD_API_SOCKET` to
launched plugin clients; it is not relied on as GUI listener configuration.
Windows uses a named pipe, so absence of a filesystem `api.sock` entry does
not establish listener failure; verify an IPC response from the bound endpoint.
[Plugin environment source](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/api/api_plugin_manager.cpp#L369-L372),
[official connection documentation](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/).

The GUI receives `KICAD_CONFIG_HOME=T\config` and `KICAD_CACHE_HOME=T\cache`.
No ambient settings or plugin tree is copied. The existing explicit library
environment allowlist and project-owned library tables remain in use. Before
launch, the bridge creates and pins these files below `T\config\10.0`:

| File | Initial contents or settings |
| --- | --- |
| `kicad_common.json` | Schema 6; `api.enable_server=true`; `do_not_show_again.data_collection_prompt=true`; `do_not_show_again.update_check_prompt=true` |
| `kicad.json` | Schema 0; `system.check_for_kicad_updates=false`; `pcm.check_for_updates=false` |
| `sym-lib-table` | `(sym_lib_table (version 7))` |
| `fp-lib-table` | `(fp_lib_table (version 7))` |
| `design-block-lib-table` | `(design_block_lib_table (version 7))` |

API enablement defaults to false. All three global tables and both prompt
acknowledgments avoid KiCad's first-run setup wizard; library environment
variables or project tables alone do not satisfy those startup checks.
[Common settings](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/settings/common_settings.cpp),
[library startup checks](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/startwizard/startwizard_provider_libraries.cpp#L230-L232),
[privacy startup checks](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/startwizard/startwizard_provider_privacy.cpp#L81-L86),
[update settings](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/settings/kicad_settings.cpp).

The cache starts empty. Telemetry opt-in uses
`T\cache\kicad\10.0\sentry-opt-in`, independently of prompt-seen flags;
no opt-in file is created. Windows policy can override this default. The
verification host had no `DataCollection` policy in either applicable HKCU or
HKLM KiCad policy key. [Cache path source](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/paths.cpp#L460-L477),
[telemetry opt-in source](https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/common/app_monitor.cpp#L148-L208).

Launch authority is one-use. Initial file identities, exact directory entries,
and empty cache are checked before the GUI starts. Normal later settings,
cache, and `org.kicad.kicad\instances` writes are permitted inside `T`.
Cleanup removes only that exact owned allocation after the GUI's process-exit
witness and inactive sidecar state are confirmed. Launches without a confirmed
exit witness, links, and uncertain teardown retain the allocation and fail
closed.

## Recorded reader patch and current evidence boundary

Profile 09 binds the local
[`0001-explicit-junction-connectivity` patch](../sidecars/patches/README.md).
Only `kicad_mcp/tools/schematic.py::_build_connectivity_groups` changes: an
explicit junction joins every containing incident orthogonal wire before
connectivity groups form. Undotted crossings remain separate; this patch does
not change writer normalization or host/native validation. The patched module is
232,924 bytes, SHA-256
`b427bcf0de3091eab6586bc8338535903fc1f23566e8069555780bf3b63cf66b`.
The [patch record](../sidecars/patches/runtime-patches.json) retains the original
wheel member identity and exact diff. This is a recorded local overlay, not a
new upstream release; published archive/metadata and the distribution lock are
unchanged.

Historical profile 09 retains its 8,458-file, 1,158-directory, 150,271,260-byte
runtime at `inspection-runtime-3.33.3`, its unsuffixed manifest, and its exact
profile bytes. The new doc1 closure contains 8,459 files and 150,280,579 bytes.
Node 24.19.0 source load-only readiness returned `ready` in 17.977 seconds,
exit 0, using five non-model probes and creating no Flux runtime/store, sidecar
session, GUI, server, or model request. The retained
`flux-generic-divider-production-profile-20260908-10.verification.json`
records that result and preservation of profile 09's dependencies. These
checks do not establish native board correctness or addon compatibility.

The current host netclass model uses authored exact `netclass_patterns`, with
the derived `netclass_assignments` cache empty (`{}` or native `null`). Five
child evidence schemas are v2 and bind this assignment model; populated caches
cannot substitute for authored rules. [Lifecycle and legacy-review boundary](flux-local.md#authored-netclass-evidence).
The native `-02` result below establishes the schematic stages, but not PCB
sync or effective live-board class readback. Terminal passage of all 43 divider
acceptance rows remains unproven. Historical runtime/profile 09 artifacts stay
unchanged; new private-document execution must use the separately versioned
finalized doc1/profile 10 runtime. A separate native addon/sync probe remains
required.

## Native -02 probe and private live-board boundary

`D:\EvlEDA-authored-netclass-sync-probe-20260908-02\result.json`
(SHA-256 `9d2da2429c9d0d4ee9d89b5d6113126627022ef649b9c32c1c05e6d2f08918d2`)
records a real, no-model fixture run that authored J1/R1/R2 through host tools
and verified connectivity, bare GND/VIN/VOUT names, managed native netclasses,
and zero native ERC violations. The result remains failed. No
`pcb_sync_from_schematic` call was dispatched: live LF and saved CRLF board
serialization differed before sync, then recovery incorrectly expected an
active-board scalar from `kicad_get_project_info`, which returns configured
project text. The session/editor closed and the owned allocation was released;
source-freeze and runtime hashes remained unchanged. No routing or full-divider
acceptance was established.

The reviewed [board comparison helper](../src/harness/fresh-board-serialization.ts)
first validates physical line endings and quoted strings, then compares the
full ordered raw-token stream using the narrowly pinned serializer exceptions
described below. Raw identities, persistence, rollback preimages, and
concurrent-write checks remain byte-exact.
The separate [native-netlist comparison helper](../src/harness/fresh-native-netlist-comparison.ts)
masks only the validated direct `export/design/date` string. It retains each
raw content identity and a distinct comparison identity; all other bytes remain
exact. Neither helper substitutes for contract, native parity, or save gates.

The reviewed private session reader uses
`evleda.kicad-live-pcb-document.v1`: `documentType: "pcb"`, native
`projectPath` (directory), `boardFilename` (basename), and exact `boardSource`,
plus `schemaVersion`. It validates the bounded matching envelopes, canonical
project root, and exact expected board before returning raw source to host
`readActivePcbSource` / `assertActivePcb`. Validation happens before public chat
sanitation; configured paths or redacted prose are not live document authority.
The capability `evleda_get_live_pcb_document` is absent from public
`callTool`/`listTools` access. Eleven focused private-reader tests passed and
independent review passed. Profile 10 readiness is complete; native addon
compatibility and sync proof remain separate gates.
[Private session implementation](../src/integrations/kicad-mcp-session.ts).
The [doc1 addon contract](../sidecars/doc1-runtime.md) uses repeated native
document observations around the raw source read, with no disk/configuration
fallback. Those observations are not an atomic document lock. Addon framework
tests do not establish completed native KiCad compatibility or synchronization.

## Captured -05 pair and current board comparison

The later `-05` run reached the post-sync live/file comparison but remained
failed and rolled back; native effective-PCB-class inspection was not reached.
Its [captured exact pair](../tests/fixtures/fresh-project/authored-netclass-sync05-board-serialization.json)
contains the original bytes from
`D:\EvlEDA-authored-netclass-sync-probe-20260908-05\exact-sync-comparison`:

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| `disk.kicad_pcb` | 12,430 | `0facbb6524a43568296d513d4809a2d34f8204ab92572c34bf68a64df22e8181` |
| `live.kicad_pcb` | 11,496 | `cef3f8f4d49bf29a5d382ae69f90b3270558c4db15997db86fdfcf3ee6012759` |

The byte relation is `12430 - 601 CR - 552 layout + 219 generated headers = 11496`.
The live serialization has nine generated header forms across three direct
footprints, accounting for 36 tokens. After those forms are excluded, all
1,995 remaining raw tokens match in order: root metadata, geometry, nets,
strings, and UUID data are unchanged in this comparison. This identifies
serialization differences, not a passing layout or acceptance result.

The current bounded helper ignores only ASCII layout whitespace between
tokens, after physical outside-string CRLF-to-LF validation, and the complete
direct-footprint prefix `(version 20260206) (generator "pcbnew")
(generator_version "10.0")` immediately after its quoted name. That prefix is
independently pinned to the KiCad 10.0.3 emitter, not inferred from incoming
root metadata. Partial, altered, duplicate, displaced, or nested header-like
fields cannot be silently omitted. Every other raw token, root field, quoted
string/escape, numeric spelling, unknown field, and token order must match.
EOF whitespace remains exact after physical line-ending conversion.
[Pinned emitter facts](../tests/fixtures/fresh-project/authored-netclass-sync05-board-serialization.json),
[helper and limits](../src/harness/fresh-board-serialization.ts).

Raw disk hashes remain authority for persistence, rollback, and concurrent
changes; comparison representations never replace them. The reviewed helper
SHA-256 is `7485760bfdf12466e54ec87dbaa062b20aed9a5dc79ed131b303a2dbcca8b3c6`.
Seventy-five helper tests, 170 caller tests, and TypeScript checks passed.
Runtime/profile 10 are unchanged. Native `-06`, effective saved/live PCB class
verification, and a terminal pass of all 43 divider acceptance rows remain
pending. Historical failures and the original captured bytes are retained.

## Verified production-path connection scope

The historical profile 07 proof completed at `2026-09-09T01:32:49.929Z` in
60.926 seconds, using `flux-generic-divider-production-profile-20260907-07.json`
(5,279 bytes; SHA-256
`6516961331525979b3c4c48105ada8322652d4337cc3b0ea16b5961b54415af3`).
After one normal deferred project bind, all six required tools were advertised
and called once: `pcb_get_board_summary`, `pcb_get_design_rules`,
`pcb_get_footprints`, `pcb_get_tracks`, `pcb_get_vias`, and `pcb_get_zones`.
Five returned live-GUI observations; design rules correctly reported no
`.kicad_dru` file. The board was an empty prepared candidate.

There were no PCB mutation calls. Source and copied board hashes were unchanged;
the sidecar and GUI closed, the bridge allocation was released, and runtime and
source-freeze identities remained unchanged. The local result is
`D:\EvlEDA-attempt8-postfix-six-tools-20260908\result.json`, SHA-256
`4dec2c39088870a6ed1e47d308cacc966ed26f808cfe6e7ed241feef517a9faa`.
This establishes the production connection/read/cleanup path only, without
establishing completed divider or RP2350 authoring, routing, validation, or
manufacturing readiness.

## Profile 08 native ERC diagnostic

The historical profile 08 local assessment
`D:\EvlEDA-workspace08-native-erc-20260908\post-run-assessment.json`
(SHA-256 `74d2e34b8c92b6af67a609d921e0e0898c954b11bdc367ed70a1f408087dd3d6`)
verified a real sidecar's native KiCad 10.0.3 ERC invocation on a blank fixture:
the exact pinned executable read `compilation\project\workspace-erc-blank.kicad_sch`
and wrote `compilation\.evleda-mcp-output\erc_report.json`, with zero native
violations. It also verified workspace-at-startup followed by normal deferred
project/output binding, unchanged source/runtime bytes, and completed cleanup.

The original diagnostic harness did not exit cleanly (`cleanHarnessExit=false`).
Its sole failed native-report predicate resolved KiCad's reported source
basename against the harness working directory and compared that result with
the absolute schematic path. The assessment verified the basename, sheet UUID,
and captured exact invocation separately, preserving the original failed
result without rerunning or editing the frozen probe. The native report itself
contains no source content hash; separate before/after hashes establish
unchanged source bytes. This is limited workspace/report-output/ERC integration
evidence, not completed divider or RP2350 design work.

## Fresh execution budgets

The fresh authoring iteration ceiling is 24; Flux's default and recommendation
remain 12. Fresh requests above 12 select 256 harness messages and the existing
1 MiB Codex/Claude CLI byte ceiling. The standalone PCB CLI still defaults to
3, and copied boards remain capped at 5. These settings do not extend KiCad
runtime verification, IPC connection, tool, or timeout authority. Resource and
acceptance guards may stop execution before the requested ceiling.

The selected budget is bound by a new run's approval. Historical 12-iteration
proof records remain unchanged, and consumed attempt13 cannot resume with
extra iterations. [Exact entry-point defaults and approval behavior](flux-local.md#iteration-budgets-and-approval).

## Test discovery and failure behavior

Real subprocess tests require explicit opt-in. Set
`EVLEDA_RUN_REAL_KICAD_MCP_SMOKE=1` for the wheel suite or
`EVLEDA_RUN_MANIFEST_KICAD_MCP_PROBE=1` for the direct manifested launcher
suite; otherwise those suites are skipped. Missing pinned paths, byte
mismatches, launch failures, and boundary violations fail an enabled suite.
The wheel suite's path variables and defaults are recorded in the lock file.

Run the focused checks with Node 24.19 or newer:

```powershell
pnpm exec vitest run tests/integration/kicad-mcp.test.ts tests/integration/kicad-mcp-real.test.ts
```

The wheel tests use the controller's `full` profile with mode-specific
allowlists and exercise discovery, terminal pagination, one read, read-only
denial, isolated write-mode discovery without a PCB write, path confinement,
manufacturing/release denial, stderr overflow, bounded request timeout,
idempotent close, and child-process cleanup. The manifested launcher test uses
a synthetic socket and does not perform the six production IPC reads; use the
separate proof above for that scope. The fake-sidecar cases retain
multi-page/cursor, schema-tamper, duplicate/conflicting catalog, output-limit,
and indefinitely hanging request
coverage. Every real test removes its uniquely owned run directory; the offline
runtime cache remains an installed prerequisite rather than a test artifact.
