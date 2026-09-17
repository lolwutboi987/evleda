"""Pure-file DOC7 qualification; run with the frozen runtime's isolated Python.

No MCP server loop, editor, native API, CLI, or network call is needed. The
unchanged native-format inputs and native CLI XML are retained beside this file.
"""
from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

MARKER = {"evledaExternalPowerFlagConnectivity": "evleda.kicad-external-power-flag-connectivity.v1"}
FIXTURES = Path(__file__).resolve().parent / "fixtures"
MODULES = ("tools/schematic.py", "tools/schematic_topology.py", "schematic/topology.py")


def endpoints(group):
    return sorted(f"{pin['reference']}:{pin['pin']}" for pin in group["pins"])


def xml_physical(variant):
    root = ET.parse(FIXTURES / variant / "netlist.xml").getroot()
    return {
        "components": sorted((c.attrib["ref"], c.findtext("value"), c.findtext("footprint"))
                             for c in root.findall("./components/comp")),
        "nets": sorted((n.attrib["name"], sorted((p.attrib["ref"], p.attrib["pin"])
                                               for p in n.findall("node")))
                       for n in root.findall("./nets/net")),
    }


class PowerFlagTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from kicad_mcp.server import KiCadFastMCP
        from kicad_mcp.tools import schematic as target
        cls.target = target
        cls.before = target._build_connectivity_groups(FIXTURES / "without_flags/power-flag-check.kicad_sch")
        cls.after = target._build_connectivity_groups(FIXTURES / "with_flags/power-flag-check.kicad_sch")
        cls.server = KiCadFastMCP("evleda-doc7-offline-graph-tests")
        # Only registration and pure tool functions are exercised; runtime IPC
        # availability filtering is unrelated to the descriptor itself.
        cls.server.filter_runtime_tools = False
        with patch.object(target, "_get_schematic_file", return_value=FIXTURES / "with_flags/power-flag-check.kicad_sch"):
            target._register_inspection_and_analysis(cls.server)
        cls.descriptors = [tool.model_dump(mode="json", by_alias=True, exclude_none=True)
                           for tool in asyncio.run(cls.server.list_tools())]
        cls.descriptor = next(t for t in cls.descriptors if t["name"] == "sch_get_connectivity_graph")
        cls.source = (FIXTURES / "with_flags/power-flag-check.kicad_sch").read_text(encoding="utf-8")
        cls.service = target.SchematicTopologyService(
            load_schematic=target._load_kicad_schematic,
            with_diagnostics=lambda text, _: text,
            build_connectivity_groups=target._build_connectivity_groups,
            iter_child_sheet_paths=lambda _: [], parse_schematic=target.parse_schematic_file,
            warn=lambda *args, **kwargs: None, read_text=lambda p: p.read_text(encoding="utf-8"),
        )
        cls.public_graph = cls.service.connectivity_graph(FIXTURES / "with_flags/power-flag-check.kicad_sch")

    def groups(self, source):
        with tempfile.TemporaryDirectory(prefix="doc7-graph-fixture-") as scratch:
            file = Path(scratch) / "fixture.kicad_sch"
            file.write_text(source, encoding="utf-8")
            groups = self.target._build_connectivity_groups(file)
            self.assertEqual(file.read_text(encoding="utf-8"), source)
            return groups

    def test_native_format_baseline_has_separate_power_nets(self):
        self.assertEqual([(g["names"], endpoints(g)) for g in self.before], [
            (["GND"], ["J1:2", "U1:1"]), (["VIN"], ["J1:1", "U1:3"]), ([], ["U1:2"]),
        ])

    def test_two_flags_do_not_merge_vin_and_ground(self):
        self.assertEqual([(g["names"], endpoints(g)) for g in self.after], [
            (["GND"], ["#FLG02:1", "J1:2", "U1:1"]),
            (["VIN"], ["#FLG01:1", "J1:1", "U1:3"]), ([], ["U1:2"]),
        ])

    def test_flag_endpoints_preserve_source_pin_metadata(self):
        pins = [p for g in self.after for p in g["pins"] if p["reference"].startswith("#FLG")]
        self.assertEqual(pins, [
            {"reference": "#FLG02", "pin": "1", "value": "PWR_FLAG", "name": "", "etype": "power_out"},
            {"reference": "#FLG01", "pin": "1", "value": "PWR_FLAG", "name": "", "etype": "power_out"},
        ])

    def test_unconnected_flag_is_unnamed_and_does_not_merge(self):
        source = self.source.replace('(lib_id "power:PWR_FLAG") (at 86.36 50.8 0)',
                                     '(lib_id "power:PWR_FLAG") (at 150 100 0)')
        groups = self.groups(source)
        flag = next(g for g in groups if "#FLG01:1" in endpoints(g))
        self.assertEqual(flag["names"], [])
        self.assertEqual(endpoints(flag), ["#FLG01:1"])
        self.assertEqual(flag["points"], [(150.0, 100.0)])
        self.assertFalse(flag["no_connect"])

    def test_flag_value_does_not_supply_a_net_name(self):
        groups = self.groups(self.source.replace('(property "Value" "PWR_FLAG"', '(property "Value" "VIN"'))
        self.assertEqual([g["names"] for g in groups], [["GND"], ["VIN"], []])
        self.assertEqual(sum(p["value"] == "VIN" for g in groups for p in g["pins"]
                             if p["reference"].startswith("#FLG")), 2)

    def test_flag_pin_comes_from_embedded_source_not_installed_library(self):
        source = self.source.replace('(name ""', '(name "source_flag_pin"', 1)
        self.assertNotEqual(source, self.source)
        groups = self.groups(source)
        pins = [p for g in groups for p in g["pins"] if p["reference"].startswith("#FLG")]
        self.assertEqual([p["name"] for p in pins], ["source_flag_pin", "source_flag_pin"])

    def test_nonstock_flag_geometry_is_rejected(self):
        block = self.target._find_symbol_block(self.source, "power:PWR_FLAG")
        self.assertIsNotNone(block)
        updated = block.replace('(at 0 0 90)', '(at 1 2 90)')
        self.assertNotEqual(updated, block)
        source = self.source.replace(block, updated).replace(
            '(lib_id "power:PWR_FLAG") (at 86.36 50.8 0)',
            '(lib_id "power:PWR_FLAG") (at 150 100 90)')
        with self.assertRaisesRegex(ValueError, "PWR_FLAG"):
            self.groups(source)

    def test_malformed_embedded_flag_is_rejected(self):
        for source in [self.source.replace('(pin power_out line', '(pin passive line', 1),
                       self.source.replace('(number "1"', '(number "7"', 1),
                       self.source.replace('PWR_FLAG_0_0', 'PWR_FLAG_2_0'),
                       self.source.replace('(symbol "power:PWR_FLAG"', '(symbol "power:NOT_FLAG"', 1)]:
            with self.subTest(source=hashlib.sha256(source.encode()).hexdigest()):
                with self.assertRaisesRegex(ValueError, "PWR_FLAG"):
                    self.groups(source)

    def test_ordinary_power_symbols_still_merge_by_value(self):
        flag_block = self.target._find_symbol_block(self.source, "power:PWR_FLAG")
        ground = (FIXTURES / "sources/power--GND.sexpr").read_text(encoding="utf-8")
        source = self.source.replace(flag_block, ground.replace('(symbol "GND"', '(symbol "power:GND"', 1))
        source = source.replace('power:PWR_FLAG', 'power:GND')
        source = source.replace('(property "Value" "PWR_FLAG"', '(property "Value" "GND"')
        groups = self.groups(source)
        self.assertEqual([g["names"] for g in groups], [["GND", "VIN"], []])
        self.assertEqual(endpoints(groups[0]), ["J1:1", "J1:2", "U1:1", "U1:3"])

    def test_native_xml_physical_components_and_net_nodes_are_unchanged(self):
        physical = xml_physical("with_flags")
        self.assertEqual(physical, xml_physical("without_flags"))
        self.assertEqual([c[0] for c in physical["components"]], ["J1", "U1"])
        self.assertFalse(any(ref.startswith("#") for _, pins in physical["nets"] for ref, _ in pins))
        expected = {name.removeprefix("/"): sorted(f"{r}:{p}" for r, p in pins)
                    for name, pins in physical["nets"] if name.startswith("/")}
        actual = {g["names"][0]: sorted(f"{p['reference']}:{p['pin']}" for p in g["pins"]
                  if not p["reference"].startswith("#")) for g in self.after if g["names"]}
        self.assertEqual(actual, expected)

    def test_actual_registered_tool_and_public_graph_have_flag_membership(self):
        tool = self.server._tool_manager.get_tool("sch_get_connectivity_graph")
        result = tool.fn()
        self.assertEqual(result, self.public_graph)
        self.assertIn("GND | pins=#FLG02:1, J1:2, U1:1", result)
        self.assertIn("VIN | pins=#FLG01:1, J1:1, U1:3", result)
        self.assertNotIn("PWR_FLAG", result)

    def test_exact_marker_only_on_graph_tool(self):
        self.assertEqual(self.descriptor.get("_meta"), MARKER)
        self.assertEqual([d["name"] for d in self.descriptors if "evledaExternalPowerFlagConnectivity" in d.get("_meta", {})],
                         ["sch_get_connectivity_graph"])

    def test_child_sheet_flag_value_is_not_a_trace_net(self):
        from dataclasses import replace
        child = FIXTURES / "with_flags/power-flag-check.kicad_sch"
        service = replace(self.service, iter_child_sheet_paths=lambda _: [("Child", child)])
        self.assertEqual(service.trace_net(child, "PWR_FLAG"),
                         "Net 'PWR_FLAG' was not found in the active schematic or child sheets.")
        self.assertIn("Child: labels=2 power_symbols=0", service.trace_net(child, "GND"))


def main():
    captured = io.StringIO()
    with tempfile.TemporaryDirectory(prefix="evleda-doc7-offline-") as scratch, redirect_stdout(captured):
        libraries = Path(scratch) / "symbols"
        libraries.mkdir()
        library_sources = {}
        for source in sorted((FIXTURES / "sources").glob("*.sexpr")):
            library = source.name.split("--", 1)[0]
            library_sources.setdefault(library, []).append(source.read_text(encoding="utf-8"))
        for library, sources in library_sources.items():
            (libraries / f"{library}.kicad_sym").write_text(
                '(kicad_symbol_lib (version 20250928) (generator "evleda-doc7-fixture")\n'
                + '\n'.join(sources) + '\n)\n', encoding="utf-8")
        os.environ.update({"KICAD_MCP_SYMBOL_LIBRARY_DIR": str(libraries),
                           "KICAD_MCP_WORKSPACE_ROOT": scratch, "KICAD_MCP_PROJECT_DIR": scratch,
                           "KICAD_MCP_OPERATING_MODE": "readonly", "KICAD_MCP_TELEMETRY_ENABLED": "false",
                           "PYTHON_DOTENV_DISABLED": "1"})
        inputs = {str(p.relative_to(FIXTURES)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in sorted(FIXTURES.rglob("*")) if p.is_file()}
        details = io.StringIO()
        with patch.object(subprocess, "Popen", side_effect=AssertionError("Offline test attempted subprocess")), \
             patch.object(socket, "create_connection", side_effect=AssertionError("Offline test attempted connection")):
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(PowerFlagTests)
            result = unittest.TextTestRunner(stream=details, verbosity=2).run(suite)
        assert inputs == {str(p.relative_to(FIXTURES)): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(FIXTURES.rglob("*")) if p.is_file()}
    runtime = Path(sys.executable).resolve().parents[2]
    report = {"success": result.wasSuccessful(), "testsRun": result.testsRun,
              "runtimeRoot": str(runtime), "pythonExecutable": sys.executable,
              "pythonFlags": {"isolated": sys.flags.isolated, "no_user_site": sys.flags.no_user_site,
                              "ignore_environment": sys.flags.ignore_environment,
                              "dont_write_bytecode": sys.flags.dont_write_bytecode,
                              "utf8_mode": sys.flags.utf8_mode},
              "importedModules": {name: str(Path(sys.modules['kicad_mcp.' + name.removesuffix('.py').replace('/', '.')].__file__).resolve()) for name in MODULES},
              "modulePins": {name: {"sha256": hashlib.sha256((runtime / "environment/Lib/site-packages/kicad_mcp" / name).read_bytes()).hexdigest(),
                                    "sizeBytes": (runtime / "environment/Lib/site-packages/kicad_mcp" / name).stat().st_size} for name in MODULES},
              "fixturePins": inputs, "fixtureInputsUnchanged": True,
              "withoutFlagsGroups": getattr(PowerFlagTests, "before", None),
              "withFlagsGroups": getattr(PowerFlagTests, "after", None),
              "publicGraph": getattr(PowerFlagTests, "public_graph", None),
              "registeredDescriptor": getattr(PowerFlagTests, "descriptor", None),
              "details": details.getvalue(), "capturedStdout": captured.getvalue()}
    print(json.dumps(report, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
