"""Pure fake-client tests; no native KiCad connection or subprocess launch."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.shared.memory import create_connected_server_and_client_session
from kipy.proto.common.types import DocumentSpecifier, DocumentType

ADDON_PATH = Path(__file__).resolve().parents[1] / "evleda_live_pcb_document.py"
spec = importlib.util.spec_from_file_location("evleda_live_pcb_document", ADDON_PATH)
addon = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = addon
spec.loader.exec_module(addon)


def document(project=r"D:\owned\project", filename="candidate.kicad_pcb"):
    result = DocumentSpecifier()
    result.type = DocumentType.DOCTYPE_PCB
    result.project.path = project
    result.board_filename = filename
    return result


class FakeBoard:
    def __init__(self, doc, source="(kicad_pcb\r\n)\r\n", on_source=None):
        self.document = doc
        self.source = source
        self.on_source = on_source
        self.source_calls = 0

    def get_as_string(self):
        self.source_calls += 1
        if self.on_source is not None:
            self.on_source()
        return self.source


class FakeClient:
    def __init__(self, inventories=None, board=None):
        doc = document()
        self.inventories = inventories if inventories is not None else [[doc], [doc], [doc]]
        self.board = board or FakeBoard(doc)
        self.inventory_calls = 0
        self.board_calls = 0

    def get_open_documents(self, kind):
        assert kind == DocumentType.DOCTYPE_PCB
        index = self.inventory_calls
        self.inventory_calls += 1
        result = self.inventories[min(index, len(self.inventories) - 1)]
        if isinstance(result, BaseException):
            raise result
        return result

    def get_board(self):
        self.board_calls += 1
        if isinstance(self.board, BaseException):
            raise self.board
        return self.board


class SnapshotTests(unittest.TestCase):
    def test_raw_schema_and_native_source_preserved(self):
        source = '(kicad_pcb\r\n (property "path" "C:\\\\native\\\\escaped")\r \"é\"\n' + "x" * 70000 + ")\r\n"
        client = FakeClient(board=FakeBoard(document(), source))
        result = addon.read_live_pcb_document(lambda: client)
        payload = result.structuredContent
        self.assertEqual(set(payload), {"schemaVersion", "documentType", "projectPath", "boardFilename", "boardSource"})
        self.assertEqual(payload["boardSource"], source)
        self.assertEqual(payload["projectPath"], r"D:\owned\project")
        self.assertEqual(payload["boardFilename"], "candidate.kicad_pcb")
        self.assertEqual(json.loads(result.content[0].text), payload)
        self.assertEqual(len(result.content), 1)
        self.assertIsNone(result.meta)
        self.assertEqual(client.inventory_calls, 3)
        self.assertEqual(client.board_calls, 1)
        self.assertEqual(client.board.source_calls, 1)

    def test_absent_or_multiple_documents_never_uses_board_fallback(self):
        for docs in [[], [document(), document(filename="other.kicad_pcb")]]:
            with self.subTest(count=len(docs)):
                client = FakeClient(inventories=[docs])
                with self.assertRaises(ToolError):
                    addon.read_live_pcb_document(lambda: client)
                self.assertEqual(client.board_calls, 0)
                self.assertEqual(client.board.source_calls, 0)

    def test_board_and_inventory_switches_rejected(self):
        current, other = document(), document(filename="other.kicad_pcb")
        cases = [
            FakeClient(board=FakeBoard(other)),
            FakeClient(inventories=[[current], [other], [other]], board=FakeBoard(current)),
            FakeClient(inventories=[[current], [current], [other]], board=FakeBoard(current)),
            FakeClient(inventories=[[current], [current], []], board=FakeBoard(current)),
        ]
        for client in cases:
            with self.subTest(calls=client.inventories):
                with self.assertRaises(ToolError):
                    addon.read_live_pcb_document(lambda: client)

    def test_mutated_proto_and_board_document_rejected(self):
        doc = document()
        board = FakeBoard(doc, on_source=lambda: setattr(doc, "board_filename", "changed.kicad_pcb"))
        with self.assertRaises(ToolError):
            addon.read_live_pcb_document(lambda: FakeClient(inventories=[[doc], [doc], [doc]], board=board))

    def test_ipc_errors_have_no_config_or_disk_fallback(self):
        for failure in [TimeoutError("native timeout"), ConnectionError("native disconnected")]:
            client = FakeClient(inventories=[failure])
            with patch("builtins.open", side_effect=AssertionError("disk fallback forbidden")):
                with self.assertRaises(ToolError):
                    addon.read_live_pcb_document(lambda: client)
            self.assertEqual(client.board_calls, 0)
        with self.assertRaises(ToolError):
            addon.read_live_pcb_document(lambda: (_ for _ in ()).throw(ConnectionError("client unavailable")))

    def test_invalid_type_fields_and_source_rejected(self):
        for field, value in [("projectPath", "relative"), ("boardFilename", "../other.kicad_pcb"), ("boardFilename", "wrong.kicad_pro")]:
            with self.subTest(field=field):
                doc = document(project=value) if field == "projectPath" else document(filename=value)
                with self.assertRaises(ToolError):
                    addon.read_live_pcb_document(lambda: FakeClient(inventories=[[doc]], board=FakeBoard(doc)))
        for source in ["", "native\0source", "\ud800", "x" * (addon.MAX_BOARD_SOURCE_BYTES + 1), "\\" * 600000]:
            with self.subTest(length=len(source)):
                with self.assertRaises(ToolError):
                    addon.read_live_pcb_document(lambda: FakeClient(board=FakeBoard(document(), source)))
        wrong_type = document()
        wrong_type.type = DocumentType.DOCTYPE_SCHEMATIC
        with self.assertRaises(ToolError):
            addon.read_live_pcb_document(lambda: FakeClient(inventories=[[wrong_type]]))

    def test_deadline_and_concurrent_request_fail_closed(self):
        client = FakeClient()
        with patch.object(addon.time, "monotonic", side_effect=[0, 0, 0, 11]):
            with self.assertRaises(ToolError):
                addon.read_live_pcb_document(lambda: client)
        self.assertEqual(client.inventory_calls, 1)
        self.assertEqual(client.board_calls, 0)
        addon._snapshot_lock.acquire()
        try:
            with self.assertRaises(ToolError):
                addon.read_live_pcb_document(lambda: FakeClient())
        finally:
            addon._snapshot_lock.release()


class FrameworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_fastmcp_wire_envelope_and_no_arguments(self):
        server = FastMCP("pure-live-document-test")
        addon.register(server, lambda: FakeClient())
        async with create_connected_server_and_client_session(server._mcp_server) as client:
            response = await client.call_tool(addon.TOOL_NAME, {})
            wire = response.model_dump(mode="json", by_alias=True, exclude_none=True)
            self.assertEqual(set(wire), {"content", "structuredContent", "isError"})
            self.assertFalse(wire["isError"])
            self.assertEqual(len(wire["content"]), 1)
            self.assertEqual(set(wire["content"][0]), {"type", "text"})
            self.assertEqual(json.loads(wire["content"][0]["text"]), wire["structuredContent"])
            print("EVLEDA_DOC1_ENVELOPE=" + json.dumps(wire, ensure_ascii=False))
            rejected = await client.call_tool(addon.TOOL_NAME, {"unexpected": True})
            self.assertTrue(rejected.isError)

    async def test_upstream_readonly_write_registration_with_fake_native_state(self):
        with tempfile.TemporaryDirectory(prefix="evleda-doc1-pure-", dir="D:\\Temp") as home:
            with patch.dict(os.environ, {"HOME": home, "USERPROFILE": home, "KICAD_MCP_KICAD_CLI": "D:/Codex-Recovery/KiCad/10.0/bin/kicad-cli.exe", "KICAD_MCP_TELEMETRY_ENABLED": "false", "KICAD_MCP_ENABLE_METRICS": "false", "KICAD_MCP_FILTER_RUNTIME_TOOLS": "true"}), patch("kipy.kicad.KiCad.__init__", side_effect=AssertionError("A real KiCad client is forbidden in pure tests")) as native_client:
                from kicad_mcp.capabilities import AccessTier, RuntimeRequirement, get as capability
                from kicad_mcp.config import reset_config
                from kicad_mcp.operating_modes import OperatingMode
                from kicad_mcp.server import KiCadFastMCP
                reset_config()
                for mode in [OperatingMode.READONLY, OperatingMode.WRITE]:
                    server = KiCadFastMCP("pure-upstream-live-test")
                    server.operating_mode = mode
                    server.allowed_tool_names = {"unrelated"}
                    server.filter_runtime_tools = False
                    source = '(kicad_pcb\r\n (property "note" "operation failed: C:\\\\native")\r\n)\n'
                    addon.register(server, lambda: FakeClient(board=FakeBoard(document(), source)))
                    self.assertEqual(server.allowed_tool_names, {"unrelated", addon.TOOL_NAME})
                    self.assertEqual(capability(addon.TOOL_NAME).tier, AccessTier.READ)
                    self.assertEqual(capability(addon.TOOL_NAME).runtime, RuntimeRequirement.KICAD_IPC)
                    self.assertEqual(capability(addon.TOOL_NAME).tested_kicad_versions, ())
                    async with create_connected_server_and_client_session(server._mcp_server) as client:
                        tools = await client.list_tools()
                        tool = next(item for item in tools.tools if item.name == addon.TOOL_NAME)
                        self.assertEqual(tool.inputSchema, {"type": "object", "properties": {}, "additionalProperties": False})
                        self.assertEqual(tool.outputSchema, addon.OUTPUT_SCHEMA)
                        self.assertTrue(tool.annotations.readOnlyHint)
                        result = await client.call_tool(addon.TOOL_NAME, {})
                        self.assertFalse(result.isError, result)
                        self.assertEqual(result.structuredContent["boardSource"], source)
                        server.filter_runtime_tools = True
                        with patch.object(server, "_runtime_ipc_capability_state", return_value=types.SimpleNamespace(reachable=False, operations={})):
                            self.assertNotIn(addon.TOOL_NAME, [item.name for item in (await client.list_tools()).tools])
                        with patch.object(server, "_runtime_ipc_capability_state", return_value=types.SimpleNamespace(reachable=True, operations={})):
                            self.assertIn(addon.TOOL_NAME, [item.name for item in (await client.list_tools()).tools])
                reset_config()
                native_client.assert_not_called()

    async def test_error_envelope_contains_no_success_payload(self):
        server = FastMCP("pure-error-test")
        addon.register(server, lambda: FakeClient(inventories=[[]]))
        async with create_connected_server_and_client_session(server._mcp_server) as client:
            response = await client.call_tool(addon.TOOL_NAME, {})
            self.assertTrue(response.isError)
            self.assertIsNone(response.structuredContent)

    async def test_versioned_launcher_registers_addon_without_starting_native_client(self):
        import kicad_mcp
        launcher = ADDON_PATH.with_name("kicad-inspection-launcher-doc1.py")
        server = FastMCP("pure-launcher-test")
        calls = []
        fake_server = types.SimpleNamespace(build_server=lambda *args, **kwargs: server)
        def run_from_options(**options):
            calls.append(options)
            fake_server.build_server("full", defer_registration=True)
        fake_server._run_server_from_options = run_from_options
        with tempfile.TemporaryDirectory(prefix="evleda-doc1-launcher-", dir="D:\\Temp") as workspace:
            environment = {
                "KICAD_MCP_WORKSPACE_ROOT": workspace,
                "KICAD_MCP_TRANSPORT": "stdio", "KICAD_MCP_OPERATING_MODE": "readonly", "KICAD_MCP_PROFILE": "full",
                "KICAD_MCP_TELEMETRY_ENABLED": "false", "KICAD_MCP_ENABLE_EXPERIMENTAL_TOOLS": "false",
                "PYTHONNOUSERSITE": "1", "PYTHONSAFEPATH": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_DOTENV_DISABLED": "1",
                "KICAD_API_SOCKET": "ipc://D:/owned/kicad/api.sock", "KICAD_MCP_KICAD_SOCKET_PATH": "ipc://D:/owned/kicad/api.sock",
            }
            with patch.dict(os.environ, environment, clear=True), patch.object(sys, "argv", [str(launcher), "--profile", "full", "--mode", "readonly"]), patch.object(kicad_mcp, "server", fake_server, create=True), patch.dict(sys.modules, {"kicad_mcp.server": fake_server}), patch("kipy.kicad.KiCad.__init__", side_effect=AssertionError("native forbidden")) as native_client:
                namespace = {"__name__": "launcher_test", "__file__": str(launcher)}
                exec(compile(launcher.read_text(), str(launcher), "exec"), namespace)
                namespace["main"]()
                native_client.assert_not_called()
        self.assertEqual(len(calls), 1)
        self.assertIsNone(calls[0]["project_dir"])
        self.assertIsNotNone(server._tool_manager.get_tool(addon.TOOL_NAME))

    async def test_launcher_hook_is_instance_local_and_one_shot(self):
        server = FastMCP("pure-hook-test")
        module = types.SimpleNamespace(build_server=lambda *args, **kwargs: server)
        with patch.object(addon, "register") as register:
            addon.install(module)
            self.assertIs(module.build_server("full", defer_registration=True), server)
            register.assert_called_once_with(server)
            with self.assertRaises(RuntimeError):
                addon.install(module)


if __name__ == "__main__":
    unittest.main(verbosity=2)
