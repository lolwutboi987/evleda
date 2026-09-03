# Install EvlEDA

EvlEDA is a Python package, local stdio MCP command, and Codex/Claude Code
workflow skill. It expects KiCad to be installed separately on the same
computer. It does not install or replace KiCad, and it has no browser, HTTP
server, hosted service, or Node.js dependency.

## Prerequisites

- Python 3.12 or newer;
- Codex or Claude Code;
- KiCad 10 for native checks, rendering, or export.

Install KiCad through the official platform installer/package source. EvlEDA
automatically checks only protected platform locations. If that discovery does
not fit the installation, use a reviewed absolute path to the real
`kicad-cli` executable. It deliberately does not search `PATH` or an
executable-selection environment variable.

## Install the command

```sh
git clone https://github.com/lolwutboi987/evleda.git
cd evleda
python -m venv .venv
```

Activate `.venv\Scripts\activate` on Windows PowerShell or
`source .venv/bin/activate` on macOS/Linux, then run:

```sh
python -m pip install --upgrade pip
python -m pip install .
evleda-mcp --version
evleda-mcp doctor
evleda-mcp smoke
```

`python -m evleda` is the equivalent module entry point.

`doctor` identifies the trusted KiCad CLI version and SHA-256. `smoke` checks
the stdio MCP protocol without opening KiCad or a network port. If discovery
fails, add an explicit reviewed path to later commands:

```sh
evleda-mcp doctor --kicad-cli /absolute/path/to/kicad-cli
```

Only KiCad 10.x.y is accepted by this release. Do not point the option at a
wrapper script, symlink, or executable obtained from an untrusted checkout.

## Direct stdio registration

For Codex CLI:

```sh
codex mcp add evleda -- evleda-mcp serve --require-kicad
```

For Claude Code:

```sh
claude mcp add evleda -s user -- evleda-mcp serve --require-kicad
```

The clients launch that command locally and speak JSON-RPC over its stdin and
stdout. There is no URL, port, browser callback, token exchange, or remote
account to configure. Restart or open a new client session, inspect the MCP
tool list, and use only the operations the local process advertises.

If protected-platform discovery did not find KiCad, include the explicit path
in the registered command after `serve`, for example:

```sh
codex mcp add evleda -- evleda-mcp serve --require-kicad --kicad-cli /absolute/path/to/kicad-cli
```

For an intentional protocol/fixture inspection session without native KiCad,
launch manually with `evleda-mcp serve --no-kicad`. Do not use that mode to
claim native ERC, DRC, rendering, or export success.

## Codex plugin

This repository is a repo-local marketplace containing `plugins/evleda/`.
After installing the Python command above:

```sh
codex plugin marketplace add .
codex plugin add evleda@evleda
```

Restart the Codex app or start a new task. Confirm both the `evleda` skill and
local MCP server are present. The plugin does not bundle KiCad and does not add
a web application; its MCP configuration launches `evleda-mcp` from the local
environment.

## Claude Code plugin

From a Claude Code session in the checkout:

```text
/plugin marketplace add .
/plugin install evleda@evleda
/reload-plugins
```

Use `/mcp` to confirm the local process. You can validate the repository before
installation with `claude plugin validate .` when that command is available.

## Project and capability behavior

KiCad project files remain native user files. Configure/select a project only
through the exact options exposed by the installed EvlEDA version. Do not grant
the MCP a broad directory when a project-specific root is sufficient.

The active `tools/list` response is authoritative. Inspection and native
verification may be available before render/export; typed mutation appears only
when its feature gate and approval dependencies are enabled. An absent tool is
not an invitation to edit files directly or run arbitrary shell commands.

The bundled `reference-usb-c-3v3-r2` project is a demo fixture for installation
and acceptance tests. It is not a hidden EvlEDA workspace and is not copied over
a user's project.

## Optional private reference evidence

The wheel includes the public reference manifest and curated demo fixture but
not vendor PDFs, confidential drawings, or private caches. Authorized users may
explicitly populate the verified public-source subset for development:

```sh
evleda-fetch-reference-sources --output-dir /private/path/evleda-reference-sources
```

The fetcher accepts an immutable allowlist, bounds redirects and sizes, and
verifies length and SHA-256. Do not commit or redistribute the cache merely
because retrieval succeeded. Normal MCP installation does not require this
cache.

## Verification for contributors

```sh
python -m pip install -e ".[dev]"
python scripts/check_release_static.py
python -m pytest -q
python .github/scripts/validate_plugin_skill.py
python -m build
python scripts/verify_public_distribution.py --dist dist
python scripts/smoke_wheel.py
```

KiCad-dependent tests may skip when the native dependency is unavailable. A
skip is not a passing native verification result.

## Common failures

- **`evleda-mcp` not found:** reactivate the install environment, use its full
  executable path, or install with `pipx` and expose that environment's bin
  directory to the client.
- **KiCad not found:** install KiCad 10 in an official protected location or
  add a reviewed absolute `--kicad-cli` path to the MCP command.
- **MCP disconnect:** ensure diagnostics go to stderr and no wrapper writes
  banners or logs to protocol stdout.
- **Requested tool absent:** check the configured project/profile and accept
  the capability boundary; do not fall back to raw writes.
- **Plugin appears stale:** update/reinstall it, restart or reload the client,
  and verify which cached plugin version is active.
- **DRC 0 but release remains blocked:** expected; digital checks do not close
  physical qualification or manufacturing approval.
