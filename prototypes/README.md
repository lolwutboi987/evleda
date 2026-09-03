# Experimental existing-project host

`project_host.py` is an unfinished development prototype for a local,
host-configured KiCad project. It is intentionally outside the installable
Python packages, is not imported by `evleda-mcp`, and must not be described as
a supported MCP capability.

Before moving any part of it into `backend/mcp_server/`, add restart,
idempotency, tamper, path-confinement, render/export, clean-wheel, and real
KiCad tests. The supported runtime remains the tool surface returned by
`evleda-mcp` over local stdio.
