"""Closed stdio entrypoint for the pinned KiCad inspection runtime.

This deliberately bypasses kicad-mcp-pro's console-script ``main`` because
that entrypoint loads an ambient .env file. The host supplies the exact
host-bound configuration through a minimal environment and fixed argv.
"""

from __future__ import annotations

import importlib.util
import os
import stat
import sys

# Defense in depth behind the interpreter's mandatory -B flag.  Keep this
# assignment before any import from the manifested application closure.
sys.dont_write_bytecode = True


def _fail() -> "NoReturn":
    raise SystemExit(64)


def _validate_workspace() -> None:
    workspace = os.environ.get("KICAD_MCP_WORKSPACE_ROOT")
    if (
        not workspace
        or any(character in workspace for character in ("\0", "\r", "\n"))
        or not os.path.isabs(workspace)
    ):
        _fail()
    try:
        canonical = os.path.realpath(workspace, strict=True)
        if os.path.normcase(workspace) != os.path.normcase(canonical):
            _fail()
        cursor = canonical
        while True:
            metadata = os.lstat(cursor)
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or getattr(metadata, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            ):
                _fail()
            parent = os.path.dirname(cursor)
            if parent == cursor:
                break
            cursor = parent
    except (OSError, ValueError):
        _fail()


def main() -> None:
    if not sys.flags.dont_write_bytecode or not sys.dont_write_bytecode:
        _fail()
    _validate_workspace()
    if any(key in os.environ for key in (
        "KICAD_MCP_PROJECT_DIR",
        "KICAD_MCP_PROJECT_FILE",
        "KICAD_MCP_PCB_FILE",
        "KICAD_MCP_SCH_FILE",
        "KICAD_MCP_OUTPUT_DIR",
    )):
        _fail()
    arguments = sys.argv[1:]
    if (
        len(arguments) != 4
        or arguments[:3] != ["--profile", "full", "--mode"]
        or arguments[3] not in ("readonly", "write")
    ):
        _fail()
    operating_mode = arguments[3]

    forbidden = (
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONPYCACHEPREFIX",
        "PIP_CONFIG_FILE",
        "PIP_INDEX_URL",
        "PIP_EXTRA_INDEX_URL",
        "UV_CACHE_DIR",
        "UV_INDEX_URL",
        "UV_EXTRA_INDEX_URL",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "KICAD_MCP_AUTH_TOKEN",
    )
    if any(os.environ.get(key) for key in forbidden):
        _fail()
    if os.environ.get("PATH"):
        _fail()
    expected = {
        "KICAD_MCP_TRANSPORT": "stdio",
        "KICAD_MCP_OPERATING_MODE": operating_mode,
        "KICAD_MCP_PROFILE": "full",
        "KICAD_MCP_TELEMETRY_ENABLED": "false",
        "KICAD_MCP_ENABLE_EXPERIMENTAL_TOOLS": "false",
        "PYTHONNOUSERSITE": "1",
        "PYTHONSAFEPATH": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
    }
    if any(os.environ.get(key) != value for key, value in expected.items()):
        _fail()
    socket_endpoint = os.environ.get("KICAD_API_SOCKET")
    if (
        not socket_endpoint
        or not socket_endpoint.startswith("ipc://")
        or len(socket_endpoint.encode("utf-8")) > 128
        or os.environ.get("KICAD_MCP_KICAD_SOCKET_PATH") != socket_endpoint
    ):
        _fail()

    from kicad_mcp import server as upstream_server

    addon_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "evleda_live_pcb_document.py")
    spec = importlib.util.spec_from_file_location("evleda_live_pcb_document", addon_path)
    if spec is None or spec.loader is None:
        _fail()
    addon = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = addon
    spec.loader.exec_module(addon)
    addon.install(upstream_server)

    upstream_server._run_server_from_options(
        transport="stdio",
        project_dir=None,
        log_level="WARNING",
        log_format="json",
        profile="full",
        operating_mode=operating_mode,
        experimental=False,
        telemetry=False,
    )


if __name__ == "__main__":
    main()
