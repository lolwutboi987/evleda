"""Pure-file DOC8 regression of the actual netlist parser -> footprint renderer.

Run with a frozen runtime's python -I -s -E -B -X utf8. Fixtures are exact
retained KiCad CLI netlist and installed stock footprint bytes. No native calls.
"""
from __future__ import annotations

import asyncio
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FOOTPRINT = FIXTURES / "WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm.kicad_mod"
ASSIGNMENT = "Package_SON:WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm"
NC_NAME = "unconnected-(U1-NC-Pad5)"
EXPECTED = {
    **{endpoint: "GND" for endpoint in [("C1", "2"), ("C2", "2"), ("C3", "2"),
        ("J1", "2"), ("J2", "2"), ("U1", "3"), ("U1", "4"), ("U1", "7")]},
    **{endpoint: "VIN_5V" for endpoint in [("C1", "1"), ("C3", "1"), ("J1", "1"),
        ("U1", "1"), ("U1", "2")]},
    **{endpoint: "VOUT_3V3" for endpoint in [("C2", "1"), ("J2", "1"), ("U1", "6")]},
}


def node(pin_type="no_connect", reference="U1", pin="5"):
    type_field = "" if pin_type is None else f'(pintype "{pin_type}")'
    return f'(node (ref "{reference}") (pin "{pin}") (pinfunction "NC_5") {type_field})'


def net(name=NC_NAME, nodes=None, extra=""):
    return f'(export (nets (net (code "4") (name "{name}") {extra} {nodes or node()})))'


class NoConnectTransferTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from kicad_mcp.server import KiCadFastMCP
        from kicad_mcp.tools import pcb
        cls.target = pcb
        cls.retained = (FIXTURES / "pcb_sync.net").read_text(encoding="utf-8")
        cls.actual_map = pcb._parse_netlist_text(cls.retained)
        cls.server = KiCadFastMCP("evleda-doc8-offline-nc-tests")
        cls.server.filter_runtime_tools = False
        cls.server.operating_mode = pcb.OperatingMode.WRITE
        pcb._register_schematic_sync_tools(cls.server)
        cls.descriptor = next(t.model_dump(mode="json", by_alias=True, exclude_none=True)
                              for t in asyncio.run(cls.server.list_tools())
                              if t.name == "pcb_sync_from_schematic")

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.forbidden = []
        for name in ("get_board", "get_command_queue", "_run_cli", "_run_cli_variants",
                     "_transactional_board_write", "_reload_board_after_file_sync",
                     "_auto_place_force_directed_board_file", "_export_schematic_net_map"):
            self.forbidden.append(self.stack.enter_context(patch.object(
                self.target, name, side_effect=AssertionError(f"Offline test attempted {name}"))))
        self.resolver = self.stack.enter_context(patch.object(
            self.target, "_footprint_file", return_value=FOOTPRINT))
        self.stack.enter_context(patch.object(self.target.uuid, "uuid4",
                                             return_value="12345678-1234-5678-1234-567812345678"))

    def tearDown(self):
        for operation in self.forbidden:
            operation.assert_not_called()

    def render(self, source):
        mapping = self.target._parse_netlist_text(source)
        block = self.target._render_board_footprint_block(
            ASSIGNMENT, reference="U1", value="TPS7B8133DRVR", x_mm=25.0, y_mm=30.0,
            rotation=90, pad_nets={pin: name for (ref, pin), name in mapping.items() if ref == "U1"})
        return mapping, block, self.target._parse_board_footprint_blocks(block)["U1"]

    def assert_transferred(self, source, expected_name=NC_NAME):
        mapping, _, parsed = self.render(source)
        self.assertEqual(mapping[("U1", "5")], expected_name)
        self.assertEqual(parsed["pad_nets"]["5"], expected_name)

    def test_retained_native_export_has_exact_functional_net_map(self):
        self.assertEqual(self.actual_map, EXPECTED)

    def test_retained_parser_renderer_keeps_nc_pad_netless_and_real_nets(self):
        _, _, parsed = self.render(self.retained)
        self.assertEqual(parsed["pad_nets"], {"1": "VIN_5V", "2": "VIN_5V", "3": "GND",
                         "4": "GND", "6": "VOUT_3V3", "7": "GND"})
        self.assertNotIn("5", parsed["pad_nets"])

    def test_singleton_no_connect_is_netless(self):
        mapping, _, parsed = self.render(net())
        self.assertEqual(mapping, {})
        self.assertEqual(parsed["pad_nets"], {})

    def test_singleton_passive_plus_no_connect_is_netless(self):
        for pin_type in ("passive+no_connect", "no_connect+passive"):
            with self.subTest(pin_type=pin_type):
                mapping, _, parsed = self.render(net(nodes=node(pin_type)))
                self.assertEqual(mapping, {})
                self.assertEqual(parsed["pad_nets"], {})

    def test_misleading_name_without_exact_nc_token_remains_assigned(self):
        for pin_type in ("passive", "input", "not_no_connect", "no_connectivity",
                         "passive+not_no_connect", "no_connect_extra", "NO_CONNECT", None):
            with self.subTest(pin_type=pin_type):
                self.assert_transferred(net(nodes=node(pin_type)))

    def test_no_connect_type_on_ordinary_name_remains_assigned(self):
        for name in ("NC", "GND", "VIN_5V", "unconnected-user-net"):
            with self.subTest(name=name):
                self.assert_transferred(net(name), name)

    def test_noncanonical_sentinel_names_remain_assigned(self):
        for name in ("unconnected-", "unconnected-()", "unconnected-(U1-NC-Pad5",
                     "unconnected-(U1-NC-Pad5)-suffix", "prefix-unconnected-(U1-NC-Pad5)"):
            with self.subTest(name=name):
                self.assert_transferred(net(name), name)

    def test_multiple_nodes_never_suppressed(self):
        for pin_type in ("no_connect", "passive+no_connect", "passive"):
            with self.subTest(pin_type=pin_type):
                source = net(nodes=node() + node(pin_type, "J9", "1"))
                self.assert_transferred(source)
                self.assertEqual(self.target._parse_netlist_text(source)[("J9", "1")], NC_NAME)

    def test_duplicate_endpoint_nodes_are_not_treated_as_singleton(self):
        self.assert_transferred(net(nodes=node() + node()))

    def test_unparseable_second_node_prevents_singleton_classification(self):
        self.assert_transferred(net(nodes=node() + '(node (ref "J9"))'))

    def test_pintype_outside_the_node_cannot_classify_it_as_nc(self):
        self.assert_transferred(net(nodes=node("passive"), extra='(pintype "no_connect")'))

    def test_ambiguous_duplicate_pintype_is_preserved(self):
        self.assert_transferred(net(nodes=node().replace('(pintype "no_connect")',
                                                       '(pintype "no_connect") (pintype "passive")')))

    def test_quoted_or_prefixed_node_text_is_not_a_second_node(self):
        for extra in ('(description "misleading (node text)")', '(node_extra (ref "J9"))'):
            with self.subTest(extra=extra):
                mapping, _, parsed = self.render(net(extra=extra))
                self.assertEqual(mapping, {})
                self.assertEqual(parsed["pad_nets"], {})

    def test_nested_or_quoted_pintype_cannot_supply_nc_classification(self):
        for nested in ('(metadata (pintype "no_connect"))', '(pinfunction "(pintype \\"no_connect\\")")'):
            with self.subTest(nested=nested):
                self.assert_transferred(net(nodes='(node (ref "U1") (pin "5") ' + nested + ')'))

    def test_actual_stock_identity_and_all_pad_primitives_preserved(self):
        _, block, parsed = self.render(self.retained)
        self.assertEqual(parsed["name"], ASSIGNMENT)
        self.assertEqual(parsed["value"], "TPS7B8133DRVR")
        self.assertEqual((parsed["x_mm"], parsed["y_mm"], parsed["rotation"]), (25.0, 30.0, 90))
        self.resolver.assert_called_once_with(*ASSIGNMENT.split(":", 1))
        original = list(self.target._iter_blocks(FOOTPRINT.read_text(encoding="utf-8"), "pad"))
        rendered = list(self.target._iter_blocks(block, "pad"))
        self.assertEqual(len(original), 9)
        self.assertEqual(len(rendered), 9)
        self.assertEqual([p for p in rendered if p.startswith('(pad ""')],
                         [p for p in original if p.startswith('(pad ""')])
        self.assertEqual(len([p for p in rendered if p.startswith('(pad ""')]), 2)
        # Remove only the renderer's added net field; every physical pad byte remains.
        self.assertEqual([re.sub(r'\n\t\t\(net "[^"\\]*"\)', '', p) for p in rendered], original)

    def test_qualified_sync_descriptor_is_unchanged(self):
        self.assertEqual(self.descriptor["_meta"], {
            "evledaQualifiedFootprintIdentitySync": "evleda.kicad-qualified-footprint-identity-sync.v1"})
        fixture = Path(__file__).resolve().parents[3] / "tests/fixtures/kicad-mcp-qualified-footprint-sync-tool.json"
        self.assertEqual(self.descriptor, json.loads(fixture.read_text(encoding="utf-8")))


def main():
    inputs = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(FIXTURES.iterdir())}
    captured, details = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory(prefix="evleda-doc8-offline-") as scratch, redirect_stdout(captured):
        os.environ.update({"KICAD_MCP_WORKSPACE_ROOT": scratch, "KICAD_MCP_PROJECT_DIR": scratch,
                           "KICAD_MCP_OPERATING_MODE": "readonly", "KICAD_MCP_TELEMETRY_ENABLED": "false",
                           "KICAD_MCP_KICAD_CLI": "C:/Program Files/KiCad/10.0/bin/kicad-cli.exe",
                           "PYTHON_DOTENV_DISABLED": "1"})
        with patch.object(subprocess, "Popen", side_effect=AssertionError("Offline subprocess")), \
             patch.object(socket, "create_connection", side_effect=AssertionError("Offline network")):
            result = unittest.TextTestRunner(stream=details, verbosity=2).run(
                unittest.defaultTestLoader.loadTestsFromTestCase(NoConnectTransferTests))
    assert inputs == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(FIXTURES.iterdir())}
    module = Path(NoConnectTransferTests.target.__file__).resolve()
    report = {"success": result.wasSuccessful(), "testsRun": result.testsRun,
              "runtimeRoot": str(Path(sys.executable).resolve().parents[2]),
              "pythonExecutable": sys.executable,
              "pythonFlags": {"isolated": sys.flags.isolated, "no_user_site": sys.flags.no_user_site,
                              "ignore_environment": sys.flags.ignore_environment,
                              "dont_write_bytecode": sys.flags.dont_write_bytecode, "utf8_mode": sys.flags.utf8_mode},
              "module": {"path": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest(),
                         "sizeBytes": module.stat().st_size}, "fixturePins": inputs, "fixtureInputsUnchanged": True,
              "retainedExportPadMap": {f"{ref}:{pin}": name for (ref, pin), name in sorted(NoConnectTransferTests.actual_map.items())},
              "registeredDescriptor": getattr(NoConnectTransferTests, "descriptor", None),
              "details": details.getvalue(), "capturedStdout": captured.getvalue()}
    print(json.dumps(report, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
