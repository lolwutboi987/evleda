"""Capture actual production KiCadFastMCP registration, without server or tool calls."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


captured = io.StringIO()
with redirect_stdout(captured), patch.object(subprocess, "Popen", side_effect=AssertionError("Offline subprocess")), \
     patch.object(socket, "create_connection", side_effect=AssertionError("Offline network")), \
     patch.object(socket.socket, "connect", side_effect=AssertionError("Offline socket connect")):
    load("kicad_mcp.utils.footprint_pose", ROOT / "kicad_mcp/utils/footprint_pose.py")
    pcb = load("kicad_mcp.tools._evleda_doc11_registered", ROOT / "kicad_mcp/tools/pcb.py")
    from kicad_mcp.server import KiCadFastMCP
    server = KiCadFastMCP("evleda-doc11-registration-only")
    server.filter_runtime_tools = False
    server.operating_mode = pcb.OperatingMode.WRITE
    pcb._register_schematic_sync_tools(server)
    descriptor = next(t.model_dump(mode="json", by_alias=True, exclude_none=True)
                      for t in server.list_tools_sync() if t.name == "pcb_sync_from_schematic")
    previous = json.loads((ROOT.parents[2] / "tests/fixtures/kicad-mcp-qualified-footprint-sync-tool.json").read_text())
    without_new_marker = json.loads(json.dumps(descriptor))
    assert without_new_marker["_meta"].pop("evledaQualifiedFootprintPoseSync") == "evleda.kicad-qualified-footprint-pose-sync.v1"
    assert without_new_marker == previous, "Production descriptor changed beyond the new pose qualifier"
for name, payload in [("registered-production-descriptor.json", descriptor), ("descriptor-capture.json", {
    "success": True, "moduleSha256": hashlib.sha256((ROOT / "kicad_mcp/tools/pcb.py").read_bytes()).hexdigest(),
    "helperSha256": hashlib.sha256((ROOT / "kicad_mcp/utils/footprint_pose.py").read_bytes()).hexdigest(),
    "onlyDescriptorChange": "evledaQualifiedFootprintPoseSync marker added", "registeredDescriptor": descriptor,
    "serverLoopStarted": False, "nativeApiCalls": 0, "capturedStdout": captured.getvalue()})]:
    with (ROOT / name).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
print(json.dumps({"success": True, "descriptor": str(ROOT / "registered-production-descriptor.json")}))
