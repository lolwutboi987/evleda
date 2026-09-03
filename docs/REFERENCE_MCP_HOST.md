# Local MCP host for the reference PCB

`backend.mcp_server.reference_host` is the least-privilege stdio endpoint for the
finalized USB-C-to-3.3-V reference design. It builds and reparses the canonical
reference artifact in memory. It never reads a project path supplied by an MCP
caller and never accepts an executable, command, environment, output path, or
project-support file through a tool argument.

## Stdio framing limits

Each JSON-RPC payload is limited to 1 MiB of UTF-8 bytes. The terminating line
delimiter is not part of that payload budget, so a valid LF frame is at most
1 MiB plus one byte (or plus two bytes for tolerated CRLF input). Output uses
compact UTF-8 JSON rather than ASCII escaping; invalid surrogate values are
replaced so every emitted frame remains valid UTF-8. An oversized unterminated
input prefix receives a parse-error response immediately, then its remainder is
discarded through the next newline before the server accepts another request.

## Safe inspect-only launch

From the repository root:

```powershell
python -m backend.mcp_server.reference_host
```

With no native pins, startup is read-only and does not create the state
directory. The only advertised tool is `inspect_project`. The project identity
is `reference-usb-c-3v3-r1`; its MCP revision is `rev_` plus the finalized
canonical revision hash returned by inspection.

## Pinned KiCad verification launch

Native verification is enabled only when the executable path, executable
SHA-256, and exact KiCad 10 patch version are all present. Partial or mismatched
configuration terminates startup before MCP traffic is served.

Set the exact reviewed executable for the host. Do not select it from `PATH` or
an environment variable. The command below uses KiCad's protected Windows
installation location; adjust the literal only after reviewing another local
installation. Use the executable's own SHA-256 and reported version rather
than copying values from another machine.

```powershell
$state = Join-Path $env:LOCALAPPDATA 'EvlEDA\reference-mcp-v1'
$kicadCli = 'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
if (-not (Test-Path -LiteralPath $kicadCli -PathType Leaf)) { throw 'KiCad CLI is unavailable' }
if ((Get-Item -LiteralPath $kicadCli -Force).LinkType) { throw 'KiCad CLI cannot be a link' }
$kicadSha256 = (Get-FileHash -Algorithm SHA256 $kicadCli).Hash.ToLowerInvariant()
$kicadVersion = (& $kicadCli version).Trim()

python -m backend.mcp_server.reference_host `
  --state-root $state `
  --kicad-cli $kicadCli `
  --kicad-cli-sha256 $kicadSha256 `
  --kicad-version $kicadVersion
```

This adds exactly `kicad_verify`. Its closed request has only:

```json
{
  "project_id": "reference-usb-c-3v3-r1",
  "expected_project_revision": "rev_<exact canonical revision sha256>",
  "checks": ["drc", "erc"]
}
```

Checks must be non-empty, sorted, unique, and drawn from `drc` and `erc`.
KiCad argv, report locations, isolated environment, limits, and rule switches
come exclusively from the pinned worker policy. The reference resolver requires
the compiler's complete sorted `all_files` set, including its project-local
library tables, symbol library, and footprint modules. Every source byte is
digest-bound, materialized into the monitored project workspace, and checked
before, between, and after ERC/DRC. The source bundle must not contain active
`.kicad_prl` state; the worker injects one policy-bound runtime-only PRL and
checks it separately. Callers cannot add, omit, or replace any file.

`kicad_import`, `kicad_export`, and `kicad_render` are absent. The current local
service does not implement their mutation/format contracts. Adding callable
placeholder methods is not sufficient: each operation needs a reviewed service,
explicit host allowlisting, exact revision evidence, and durable publication or
approval semantics before it may be advertised.

## Journal key and local state

The default state location is external to the checkout:

- Windows: `%LOCALAPPDATA%\EvlEDA\reference-mcp-v1`
- POSIX: `$XDG_STATE_HOME/evleda/reference-mcp-v1`, or
  `~/.local/state/evleda/reference-mcp-v1`

On the first configured launch, the host atomically creates
`journal-hmac-v1.key` with 32 random bytes. The key is never accepted through
MCP, command-line arguments, environment variables, logs, or object repr. A
non-secret key ID is derived from its SHA-256. A keyed immutable sentinel in
the SQLite journal detects replacement by a different valid-length key. If the
journal exists while the key is missing, startup fails; it never generates a
replacement and retries potentially ambiguous work.

Treat this v1 key as immutable and back it up with the journal. Rotation needs
an offline migration that verifies and re-seals all retained rows; deleting or
replacing the files is not rotation. Per-row HMAC does not detect whole-state
rollback, so this local endpoint exposes only read-only native verification.

On POSIX the host requires `0700`-equivalent state directories and a
`0600`-equivalent key. Windows mode bits do not establish a private DACL: use a
current-user-only local state directory. The host rejects a `--state-root`
inside its source checkout; also avoid synchronized folders, shared volumes,
and network paths. A production
Windows deployment still needs explicit DACL/reparse-point enforcement and a
stronger process sandbox.

## Current verification status

A live KiCad 10.0.6 run on 2026-08-31 exercised both checks through this host.
Compiler v3.0.0's hermetic 27-source-file project produced zero ERC findings and zero
DRC findings. The real MCP call returned `passed: true` and
`blocking_findings: 0` with no tool error. The exact canonical revision was
`rev_af844937e7d7f0689c6076250d80f30b7057d70cc821ff8fc54e28940c709068`;
the compiler bundle digest was
`95421679d2118f555068224dddf90350255e23fc607cb36ef78487a17524b406`;
the auxiliary manifest digest was
`d90d7beb4fbf2f89e306b7f71ca48b0a5c344c86023011dff0838b793b067fb7`;
the managed bundle digest was
`bc67a78ccd0f02940b42f19684f67988a13c022b58318cf7a8dc41d643963438`.
The worker separately injected its policy-bound 2,306-byte runtime PRL
(`21f5f814730bd4668286477f0dd098b565b4c9aac5417763909cbba7242095c8`)
under runtime-support manifest
`566e8b828d9661653115dcc931dfa2a4196ea5a64592ffe49c9664da6e813385`,
and verified it byte-identically before, between, and after both commands.
Findings/report digests additionally bind the per-host worker policy and are
returned with each run. Always use the returned revision, findings digest,
report digest, worker, version, and policy evidence; do not treat host
availability or zero ERC/DRC findings as manufacturing approval.

## Verification commands

```powershell
python -m pytest -q -p no:cacheprovider `
  tests\mcp_server\test_reference_host.py tests\kicad_worker
ruff check --no-cache backend\mcp_server\reference_host.py `
  tests\mcp_server\test_reference_host.py
pyright backend\mcp_server\reference_host.py `
  tests\mcp_server\test_reference_host.py
```
