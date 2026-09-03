"""Public command wrapper; private implementation remains compatible in 0.x."""

from __future__ import annotations

from collections.abc import Sequence

from backend.mcp_server.cli import main as _implementation_main


def main(argv: Sequence[str] | None = None) -> int:
    """Run the EvlEDA MCP command."""

    return _implementation_main(argv)


__all__ = ("main",)
