"""Runnable in-memory MCP stdio demo: ``python -m backend.mcp_server.demo``."""

from __future__ import annotations

import os
import sys

from backend.mcp_gateway import (
    ActorKind,
    CapabilitySafeGateway,
    InMemoryKiCadAdapter,
    Principal,
    ProfileName,
)

from .server import HostConfig, MCPStdioServer, serve_stdio


def main() -> None:
    actor_id = os.environ.get("EVLEDA_MCP_ACTOR_ID", "demo-designer")
    actor_kind = ActorKind(os.environ.get("EVLEDA_MCP_ACTOR_KIND", "agent"))
    profile = ProfileName(os.environ.get("EVLEDA_MCP_PROFILE", "designer"))
    project_id = os.environ.get("EVLEDA_MCP_PROJECT_ID", "project-demo")
    adapter = InMemoryKiCadAdapter()
    adapter.seed_project(project_id)
    gateway = CapabilitySafeGateway(adapter)
    server = MCPStdioServer(
        gateway,
        HostConfig(
            Principal(actor_id, actor_kind, profile),
            allowed_project_ids=frozenset({project_id}),
        ),
    )
    serve_stdio(server, sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    main()
