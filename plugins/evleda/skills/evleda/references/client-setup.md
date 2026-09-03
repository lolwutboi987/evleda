# Client setup and diagnostics

Read this reference when installing EvlEDA, connecting Codex or Claude Code, or diagnosing a missing MCP server. EvlEDA is a local stdio child process only: it opens no network listener and has no browser or hosted runtime.

## Prerequisites

- Python 3.12 or newer;
- the EvlEDA package installed so `evleda-mcp` is on `PATH`;
- KiCad installed separately on the same computer; EvlEDA does not bundle or replace it;
- KiCad 10 in a protected default platform installation, or a reviewed absolute
  `--kicad-cli` path supplied when starting the server. KiCad executable
  discovery never searches `PATH` or executable-selection environment variables.

From the repository root, an isolated install can be made with:

```text
pipx install .
```

For development:

```text
python -m pip install -e .
```

Confirm the installed boundary before configuring a client:

```text
evleda-mcp --version
evleda-mcp doctor
```

`doctor` reports platform, state root, stdio framing mode, discovery policy, and
the trusted KiCad CLI version and digest. It must not write JSON-RPC protocol
traffic to stdout while the server is running; diagnostics belong on stderr.
There is no URL, port, account, or HTTP transport to configure.

## Plugin MCP configuration

The shared plugin `.mcp.json` invokes the installed console command:

```json
{
  "mcpServers": {
    "evleda": {
      "command": "evleda-mcp",
      "args": ["serve", "--require-kicad"]
    }
  }
}
```

This deliberately does not point outside the plugin cache. Claude Code copies marketplace plugins into versioned cache directories; paths to bundled files must use `${CLAUDE_PLUGIN_ROOT}` in MCP `command`, `args`, or `env`. EvlEDA's backend is an independently installed console command, so no plugin-relative backend path is needed and the same configuration remains portable in Codex.

## Codex

From the repository root:

```text
codex plugin marketplace add .
codex plugin add evleda@evleda
```

Start a new task after installation so the skill and MCP server are loaded. Use the client MCP/tool view to confirm the `evleda` server and inspect only the tools it actually advertises. KiCad remains the native editor and checker for the selected project.

## Claude Code

From the repository root:

```text
claude plugin marketplace add .
claude plugin install evleda@evleda
```

Use `/reload-plugins` after an update and `/mcp` to inspect the connection. Claude Code scopes plugin tools by plugin and server name. Do not hard-code scoped names in portable prompts; discover them from the active client.

## Failure triage

- `Executable not found`: activate the environment used for installation or install with `pipx` and ensure its binary directory is on `PATH`.
- `KiCad 10 CLI was required but was not found`: install KiCad 10 in its
  protected default location or launch the console command manually with
  `--kicad-cli` pointing to a reviewed absolute, non-link executable.
- server starts but tools are absent: inspect client debug output, validate both plugin manifests, and confirm `.mcp.json` is at the plugin root.
- a requested mutation tool is absent: the active host is intentionally capability-restricted. Report the boundary; do not replace it with arbitrary shell or filesystem access.
- protocol disconnect: check that the process writes only newline-delimited JSON-RPC to stdout and sends diagnostics to stderr.

For a read-only session when native KiCad is intentionally unavailable, run the server manually with `serve --no-kicad`; do not silently weaken the plugin's default `--require-kicad` configuration.
