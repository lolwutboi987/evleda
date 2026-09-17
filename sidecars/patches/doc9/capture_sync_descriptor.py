"""Capture real KiCadFastMCP registration only; never run the server or tool."""
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
from unittest.mock import patch

captured = io.StringIO()
with redirect_stdout(captured), \
     patch.object(subprocess, "Popen", side_effect=AssertionError("Offline subprocess")), \
     patch.object(socket, "create_connection", side_effect=AssertionError("Offline network")), \
     patch.object(socket.socket, "connect", side_effect=AssertionError("Offline socket connect")):
    from kicad_mcp.server import KiCadFastMCP
    from kicad_mcp.tools import pcb
    server = KiCadFastMCP("evleda-doc9-registration-only")
    server.filter_runtime_tools = False
    server.operating_mode = pcb.OperatingMode.WRITE  # Descriptor visibility only.
    pcb._register_schematic_sync_tools(server)
    descriptor = next(t.model_dump(mode="json", by_alias=True, exclude_none=True)
                      for t in server.list_tools_sync() if t.name == "pcb_sync_from_schematic")
    fixture = Path(__file__).resolve().parents[3] / "tests/fixtures/kicad-mcp-qualified-footprint-sync-tool.json"
    assert descriptor == json.loads(fixture.read_text(encoding="utf-8"))
module = Path(pcb.__file__).resolve()
print(json.dumps({"success": True, "registeredDescriptor": descriptor,
                  "module": {"path": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest(),
                             "sizeBytes": module.stat().st_size},
                  "pythonFlags": {"isolated": sys.flags.isolated, "no_user_site": sys.flags.no_user_site,
                                  "ignore_environment": sys.flags.ignore_environment,
                                  "dont_write_bytecode": sys.flags.dont_write_bytecode, "utf8_mode": sys.flags.utf8_mode},
                  "serverLoopStarted": False, "nativeApiCalls": 0, "capturedStdout": captured.getvalue()}, indent=2))
