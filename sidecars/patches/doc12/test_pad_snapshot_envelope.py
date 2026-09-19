"""Offline envelope/registration regressions; no native connection or source writes."""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult, TextContent

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]

def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

load("evleda_live_pcb_document", REPO / "sidecars/evleda_live_pcb_document.py")
addon = load("evleda_doc12_pad_snapshot", ROOT / "evleda_live_pcb_pad_snapshot.py")
fixture = json.loads((REPO / "tests/fixtures/fresh-pcb-pads/native-pad-snapshot-envelope.json").read_text(encoding="utf-8"))

class EnvelopeTests(unittest.TestCase):
    def test_complete_payload_and_exact_marker(self):
        payload = fixture["structuredContent"]
        result = addon._snapshot_result(payload)
        wire = json.loads(result.model_dump_json(by_alias=True, exclude_none=True))
        self.assertEqual(set(wire), {"content", "structuredContent", "isError"})
        self.assertEqual(wire["structuredContent"], payload)
        self.assertEqual(wire["content"], [{"type": "text", "text": addon.COMPACT_TEXT}])
        self.assertFalse(wire["isError"])
        self.assertEqual(json.loads(addon.COMPACT_TEXT), {
            "schemaVersion": "evleda.kicad-live-pcb-pad-snapshot-envelope.v2",
            "payloadLocation": "structuredContent", "payloadSchemaVersion": addon.SCHEMA_VERSION})

    def test_reclaims_duplicate_space_without_raising_limits(self):
        payload = json.loads(json.dumps(fixture["structuredContent"]))
        payload["boardSourceBefore"] += "\n" * 350_000
        payload["boardSourceAfter"] += "\n" * 350_000
        legacy = CallToolResult(content=[TextContent(type="text", text=json.dumps(payload, separators=(",", ":")))], structuredContent=payload, isError=False)
        result = addon._snapshot_result(payload)
        self.assertGreater(len(legacy.model_dump_json(by_alias=True, exclude_none=True).encode()), addon.MAX_RESULT_BYTES)
        self.assertLess(len(result.model_dump_json(by_alias=True, exclude_none=True).encode()), addon.MAX_RESULT_BYTES)
        self.assertEqual(result.structuredContent, payload)
        self.assertEqual(addon.MAX_RESULT_BYTES, 2 * 1024 * 1024 - 4096)
        self.assertEqual(addon.MAX_BOARD_SOURCE_BYTES, 1024 * 1024)

    def test_exact_wire_byte_limit(self):
        base = addon._snapshot_result({"data": ""})
        overhead = len(base.model_dump_json(by_alias=True, exclude_none=True).encode())
        addon._snapshot_result({"data": "x" * (addon.MAX_RESULT_BYTES - overhead)})
        for value in ("x" * (addon.MAX_RESULT_BYTES - overhead + 1), "é" * (addon.MAX_RESULT_BYTES // 2)):
            with self.assertRaisesRegex(ToolError, "nothing was truncated"):
                addon._snapshot_result({"data": value})

    def test_non_finite_values_are_not_silently_normalized(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            with self.assertRaises(ValueError):
                addon._snapshot_result({"value": value})

    def test_real_fastmcp_transport_preserves_compact_envelope(self):
        async def run():
            server = FastMCP("doc12-offline-test")
            addon.register(server, lambda: self.fail("No native connection allowed"))
            captured = addon._snapshot_result(fixture["structuredContent"])
            with patch.object(addon, "read_live_pcb_pad_snapshot", return_value=captured):
                async with create_connected_server_and_client_session(server._mcp_server) as client:
                    tools = await client.list_tools()
                    descriptor = next(t for t in tools.tools if t.name == addon.TOOL_NAME)
                    self.assertEqual(descriptor.inputSchema, addon.INPUT_SCHEMA)
                    self.assertEqual(descriptor.outputSchema, addon.OUTPUT_SCHEMA)
                    result = await client.call_tool(addon.TOOL_NAME, {"requested_primitive_ids": []})
                    self.assertEqual(result.structuredContent, captured.structuredContent)
                    self.assertEqual(result.content, captured.content)
                    self.assertFalse(result.isError)
        asyncio.run(run())

if __name__ == "__main__":
    unittest.main()
