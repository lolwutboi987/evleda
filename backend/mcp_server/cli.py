"""The installable ``evleda-mcp`` console command.

``serve`` writes protocol bytes to stdout and diagnostics only to stderr.
It exposes the immutable reference project, never a shell or arbitrary paths.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from backend.mcp_gateway import (
    ActorKind,
    CapabilitySafeGateway,
    InMemoryKiCadAdapter,
    Principal,
    ProfileName,
)

from .distribution import render_doctor, resolve_kicad_installation
from .reference_host import (
    ReferenceHostConfigurationError,
    ReferenceHostSettings,
    build_reference_host,
    default_reference_state_root,
)
from .server import serve_stdio
from .version import DISTRIBUTION_NAME, VERSION


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=DISTRIBUTION_NAME,
        description="Serve the deterministic EvlEDA reference over MCP stdio.",
    )
    parser.add_argument("--version", action="version", version=f"{DISTRIBUTION_NAME} {VERSION}")
    commands = parser.add_subparsers(dest="command")
    for command in ("serve", "doctor"):
        child = commands.add_parser(command)
        child.add_argument("--state-root", type=Path, default=default_reference_state_root())
        child.add_argument(
            "--kicad-cli",
            type=Path,
            help=(
                "reviewed absolute path to a regular, non-link kicad-cli; "
                "PATH and executable-selection environment variables are not searched"
            ),
        )
    serve = commands.choices["serve"]
    serve.add_argument("--actor-id", default="local-reference-agent")
    serve.add_argument("--worker-id", default="local-kicad-cli-reference-v1")
    serve.add_argument("--timeout-seconds", type=int, default=120)
    serve.add_argument("--no-kicad", action="store_true", help="serve inspect-only")
    serve.add_argument(
        "--require-kicad",
        action="store_true",
        help="fail unless a reviewed explicit or protected platform KiCad 10 CLI is available",
    )
    serve.add_argument("--refill-zones-on-temp-copy", action="store_true")
    commands.add_parser("smoke", help="exercise clean stdio MCP framing without KiCad")
    return parser


def _serve(arguments: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if arguments.no_kicad and arguments.require_kicad:
        parser.error("--no-kicad and --require-kicad cannot be used together")
    installation = None
    if not arguments.no_kicad:
        installation = resolve_kicad_installation(arguments.kicad_cli)
    if arguments.require_kicad and installation is None:
        parser.error(
            "KiCad 10 CLI was required but was not found in a trusted platform location; "
            "use a reviewed absolute --kicad-cli path"
        )
    settings = ReferenceHostSettings(
        state_root=arguments.state_root,
        actor_id=arguments.actor_id,
        kicad_executable=None if installation is None else installation.executable,
        kicad_executable_sha256=None if installation is None else installation.sha256,
        kicad_version=None if installation is None else installation.version,
        worker_id=arguments.worker_id,
        timeout_seconds=arguments.timeout_seconds,
        refill_zones_on_temp_copy=arguments.refill_zones_on_temp_copy,
    )
    try:
        runtime = build_reference_host(settings)
    except (RuntimeError, ValueError) as exc:
        if "source-evidence" not in str(exc):
            raise
        raise ReferenceHostConfigurationError(
            "the public wheel does not bundle restricted source-evidence blobs; "
            "populate a verified private cache with evleda-fetch-reference-sources "
            "and set EVLEDA_REFERENCE_EVIDENCE_ROOT to that cache before serving"
        ) from exc
    serve_stdio(runtime.server, sys.stdin.buffer, sys.stdout.buffer)
    return 0


def _smoke() -> int:
    """Exercise the installed protocol transport without KiCad or source evidence."""

    from .server import HostConfig, MCPStdioServer

    project_id = "evleda-smoke-reference"
    adapter = InMemoryKiCadAdapter()
    adapter.seed_project(project_id)
    server = MCPStdioServer(
        CapabilitySafeGateway(adapter),
        HostConfig(
            Principal("evleda-smoke", ActorKind.AGENT, ProfileName.DESIGNER),
            allowed_project_ids=frozenset({project_id}),
        ),
    )
    requests: tuple[dict[str, object], ...] = (
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "evleda-smoke", "version": VERSION},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "ping", "params": {}},
    )
    wire = b"".join(
        json.dumps(item, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
        for item in requests
    )
    output = io.BytesIO()
    serve_stdio(server, io.BytesIO(wire), output)
    try:
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
    except json.JSONDecodeError as exc:
        raise ReferenceHostConfigurationError("MCP smoke response was not JSON-RPC") from exc
    if (
        len(responses) != 3
        or [response.get("id") for response in responses] != [1, 2, 3]
        or responses[0].get("result", {}).get("protocolVersion") != "2025-11-25"
        or not responses[1].get("result", {}).get("tools")
        or responses[2].get("result") != {}
    ):
        raise ReferenceHostConfigurationError("MCP smoke protocol contract failed")
    sys.stdout.write("evleda-mcp smoke: passed (legacy initialize/list-tools/ping)\n")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    supplied = list(sys.argv[1:] if argv is None else argv)
    # This default lets a Codex/Claude config use only ``evleda-mcp``.
    if not supplied or (supplied[0].startswith("-") and supplied[0] != "--version"):
        supplied.insert(0, "serve")
    arguments = parser.parse_args(supplied)
    try:
        if arguments.command == "doctor":
            installation = resolve_kicad_installation(arguments.kicad_cli)
            sys.stdout.write(render_doctor(installation, arguments.state_root))
            return 0
        if arguments.command == "smoke":
            return _smoke()
        return _serve(arguments, parser)
    except ReferenceHostConfigurationError as exc:
        parser.exit(2, f"{DISTRIBUTION_NAME} configuration error: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
