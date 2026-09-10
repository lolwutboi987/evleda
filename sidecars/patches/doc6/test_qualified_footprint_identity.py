"""Offline DOC6 regression tests against a real imported PCB tool module.

Run with the target runtime: python -I -s -E -B this_file.py /absolute/path/to/pcb.py
One JSON report is written to stdout; no server loop or KiCad native operation runs.
Temporary fixtures respect the caller's TEMP/TMP via tempfile.TemporaryDirectory.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import ExitStack, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

MARKER_KEY = "evledaQualifiedFootprintIdentitySync"
MARKER_VALUE = "evleda.kicad-qualified-footprint-identity-sync.v1"
ROOT_UUID = "12345678-1234-5678-1234-567812345678"
STOCK_ASSIGNMENT = "Resistor_SMD:R_0603_1608Metric"
# KiCad 10 installed stock footprint snapshot, retained here for portable offline tests.
STOCK_FOOTPRINT = '(footprint "R_0603_1608Metric"\n\t(version 20260206)\n\t(generator "kicad-footprint-generator")\n\t(layer "F.Cu")\n\t(descr "Resistor SMD 0603 (1608 Metric), square (rectangular) end terminal, IPC-7351 nominal, (Body size source: IPC-SM-782 page 72, https://www.pcb-3d.com/wordpress/wp-content/uploads/ipc-sm-782a_amendment_1_and_2.pdf)")\n\t(tags "resistor")\n\t(property "Reference" "REF**"\n\t\t(at 0 -1.43 0)\n\t\t(layer "F.SilkS")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n\t(property "Value" "R_0603_1608Metric"\n\t\t(at 0 1.43 0)\n\t\t(layer "F.Fab")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n\t(property "KiLib_Generator" "SMD_2terminal_chip_molded"\n\t\t(at 0 0 0)\n\t\t(layer "F.SilkS")\n\t\t(hide yes)\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n\t(attr smd)\n\t(duplicate_pad_numbers_are_jumpers no)\n\t(fp_line\n\t\t(start -0.237258 -0.5225)\n\t\t(end 0.237258 -0.5225)\n\t\t(stroke\n\t\t\t(width 0.12)\n\t\t\t(type solid)\n\t\t)\n\t\t(layer "F.SilkS")\n\t)\n\t(fp_line\n\t\t(start -0.237258 0.5225)\n\t\t(end 0.237258 0.5225)\n\t\t(stroke\n\t\t\t(width 0.12)\n\t\t\t(type solid)\n\t\t)\n\t\t(layer "F.SilkS")\n\t)\n\t(fp_rect\n\t\t(start -1.48 -0.73)\n\t\t(end 1.48 0.73)\n\t\t(stroke\n\t\t\t(width 0.05)\n\t\t\t(type solid)\n\t\t)\n\t\t(fill no)\n\t\t(layer "F.CrtYd")\n\t)\n\t(fp_rect\n\t\t(start -0.8 -0.4125)\n\t\t(end 0.8 0.4125)\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type solid)\n\t\t)\n\t\t(fill no)\n\t\t(layer "F.Fab")\n\t)\n\t(fp_text user "${REFERENCE}"\n\t\t(at 0 0 0)\n\t\t(layer "F.Fab")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 0.4 0.4)\n\t\t\t\t(thickness 0.06)\n\t\t\t)\n\t\t)\n\t)\n\t(pad "1" smd roundrect\n\t\t(at -0.825 0)\n\t\t(size 0.8 0.95)\n\t\t(layers "F.Cu" "F.Mask" "F.Paste")\n\t\t(roundrect_rratio 0.25)\n\t)\n\t(pad "2" smd roundrect\n\t\t(at 0.825 0)\n\t\t(size 0.8 0.95)\n\t\t(layers "F.Cu" "F.Mask" "F.Paste")\n\t\t(roundrect_rratio 0.25)\n\t)\n\t(embedded_fonts no)\n\t(model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"\n\t\t(offset\n\t\t\t(xyz 0 0 0)\n\t\t)\n\t\t(scale\n\t\t\t(xyz 1 1 1)\n\t\t)\n\t\t(rotate\n\t\t\t(xyz 0 0 0)\n\t\t)\n\t)\n)\n'


GEOMETRY_FOOTPRINT = r'''(footprint "SharedLeaf"
	(layer "F.Cu")
	(property "Reference" "R1" (at 0 -1.5) (layer "F.SilkS"))
	(property "Value" "10k" (at 0 1.5) (layer "F.Fab"))
	(attr smd)
	(fp_line (start -1 -0.5) (end 1 -0.5)
		(stroke (width 0.12) (type default)) (layer "F.SilkS")
		(uuid "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
	(fp_rect (start -1.5 -1) (end 1.5 1)
		(stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd")
		(uuid "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
	(pad "1" smd rect (at -0.8 0 90) (size 0.9 1)
		(layers "F.Cu" "F.Paste" "F.Mask") (net "GND")
		(uuid "cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
	(pad "2" smd roundrect (at 0.8 0) (size 0.9 1)
		(layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.2)
		(uuid "dddddddd-dddd-4ddd-8ddd-dddddddddddd"))
	(model "${KICAD10_3DMODEL_DIR}/Test.step"
		(offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)'''


def load_target(path: Path):
    name = "kicad_mcp.tools._evleda_doc6_identity_test_target"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import target: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class QualifiedFootprintIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = cls.target.FastMCP("evleda-doc6-offline-identity-tests")
        cls.target._register_schematic_sync_tools(cls.server)
        cls.target._register_placement_automation_tools(cls.server)
        cls.descriptors = [
            descriptor.model_dump(mode="json", by_alias=True, exclude_none=True)
            for descriptor in asyncio.run(cls.server.list_tools())
        ]
        cls.registered_descriptor = next(
            descriptor for descriptor in cls.descriptors
            if descriptor["name"] == "pcb_sync_from_schematic"
        )
        tool = cls.server._tool_manager.get_tool("pcb_sync_from_schematic")
        if tool is None:
            raise AssertionError("Sync tool did not register")
        cls.sync_tool = staticmethod(tool.fn)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="evleda-doc6-identity-")
        self.addCleanup(self.temp.cleanup)
        self.scratch = Path(self.temp.name)
        self.footprint = self.scratch / "fixture.kicad_mod"
        self.footprint.write_text(GEOMETRY_FOOTPRINT, encoding="utf-8")
        self.board = self.scratch / "fixture.kicad_pcb"
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # These sentinels make accidental editor/native/writer calls fail closed.
        self.forbidden = {}
        for name in (
            "get_board", "get_command_queue", "_run_cli", "_run_cli_variants",
            "_transactional_board_write", "_reload_board_after_file_sync",
            "_auto_place_force_directed_board_file", "_export_schematic_net_map",
        ):
            self.forbidden[name] = self.stack.enter_context(patch.object(
                self.target, name,
                side_effect=AssertionError(f"Offline test attempted {name}"),
            ))
        self.resolver = self.stack.enter_context(patch.object(
            self.target, "_footprint_file", return_value=self.footprint,
        ))
        self.stack.enter_context(patch.object(self.target.uuid, "uuid4", return_value=ROOT_UUID))

    def render(self, assignment=STOCK_ASSIGNMENT, **overrides):
        arguments = dict(reference="R1", value="10k", x_mm=25.0, y_mm=30.0,
                         rotation=90, pad_nets={})
        arguments.update(overrides)
        return self.target._render_board_footprint_block(assignment, **arguments)

    @staticmethod
    def quoted_root(block):
        match = re.match(r'\(footprint\s+("(?:\\.|[^"\\])*")', block)
        if match is None:
            raise AssertionError("No quoted root name")
        return match.group(1)

    def write_existing_board(self, name, reference="R1"):
        content = (
            '(kicad_pcb (version 20260206)\n'
            f'(footprint {self.target._sexpr_string(name)}\n'
            '\t(layer "F.Cu")\n'
            '\t(uuid "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")\n'
            '\t(at 25 30 90)\n'
            f'\t(property "Reference" "{reference}" (at 0 -1) (layer "F.SilkS"))\n'
            '\t(property "Value" "10k" (at 0 1) (layer "F.Fab"))\n'
            '\t(pad "1" smd rect (at -0.8 0) (size 0.9 1) (layers "F.Cu") (net "GND"))\n'
            ')\n'
            '(segment (start 24.2 30) (end 20 30) (width 0.25) (layer "F.Cu")\n'
            '\t(uuid "ffffffff-ffff-4fff-8fff-ffffffffffff"))\n'
            ')\n'
        )
        self.board.write_text(content, encoding="utf-8")
        return self.board.read_bytes()

    def sync_existing(self, assignment, board_name):
        before = self.write_existing_board(board_name)
        component = dict(reference="R1", value="10k", footprint=assignment,
                         rotation=90, x=10.0, y=10.0)
        with patch.object(self.target, "_board_is_open", return_value=False), \
             patch.object(self.target, "_pcb_sync_gate_failures", return_value=[]), \
             patch.object(self.target, "_collect_schematic_components", return_value=([component], [])), \
             patch.object(self.target, "_get_pcb_file_for_sync", return_value=self.board):
            result = self.sync_tool(use_net_names=False, replace_mismatched=False, auto_place=False)
        self.assertEqual(before, self.board.read_bytes(), "Existing routed fixture changed")
        for operation in self.forbidden.values():
            operation.assert_not_called()
        return result

    def test_stock_assignment_keeps_exact_qualified_root(self):
        self.footprint.write_text(STOCK_FOOTPRINT, encoding="utf-8")
        block = self.render(pad_nets={"1": "GND", "2": "+3V3"})
        self.assertEqual(self.quoted_root(block), '"Resistor_SMD:R_0603_1608Metric"')
        self.resolver.assert_called_once_with("Resistor_SMD", "R_0603_1608Metric")
        parsed = self.target._parse_board_footprint_blocks(block)["R1"]
        self.assertEqual(parsed["name"], STOCK_ASSIGNMENT)
        self.assertEqual(parsed["value"], "10k")
        self.assertEqual(parsed["pad_nets"], {"1": "GND", "2": "+3V3"})
        self.assertEqual((parsed["x_mm"], parsed["y_mm"], parsed["rotation"]), (25.0, 30.0, 90))

    def test_escaped_unicode_quotes_backslashes_and_lf_round_trip(self):
        assignment = '測試\\資料"庫:封裝"\\line\\n\nµΩ'
        expected_root = '"測試\\\\資料\\"庫:封裝\\"\\\\line\\\\n\\nµΩ"'
        block = self.render(assignment)
        self.assertEqual(self.quoted_root(block), expected_root)
        self.assertEqual(self.target._parse_board_footprint_blocks(block)["R1"]["name"], assignment)
        self.resolver.assert_called_once_with('測試\\資料"庫', '封裝"\\line\\n\nµΩ')

    def test_two_libraries_with_same_leaf_remain_distinct(self):
        first = self.render("Library_A:SharedLeaf")
        second = self.render("Library_B:SharedLeaf")
        parsed_first = self.target._parse_board_footprint_blocks(first)["R1"]["name"]
        parsed_second = self.target._parse_board_footprint_blocks(second)["R1"]["name"]
        self.assertEqual((parsed_first, parsed_second), ("Library_A:SharedLeaf", "Library_B:SharedLeaf"))
        self.assertNotEqual(parsed_first, parsed_second)
        # Same source, placement, UUID, properties and pads: only the root identity differs.
        self.assertEqual(first.replace('"Library_A:SharedLeaf"', '"Library_B:SharedLeaf"', 1), second)

    def test_root_rewrite_preserves_all_existing_geometry_pad_and_child_uuid_text(self):
        block = self.render("Library_A:SharedLeaf")
        expected = GEOMETRY_FOOTPRINT.replace('"SharedLeaf"', '"Library_A:SharedLeaf"', 1)
        expected = expected.replace(
            '(layer "F.Cu")',
            '(layer "F.Cu")\n\t(uuid "12345678-1234-5678-1234-567812345678")\n\t(at 25.0000 30.0000 90)',
            1,
        )
        self.assertEqual(block, expected)
        for tag in ("pad", "fp_line", "fp_rect", "model"):
            self.assertEqual(list(self.target._iter_blocks(block, tag)),
                             list(self.target._iter_blocks(GEOMETRY_FOOTPRINT, tag)))

    def test_matching_qualified_identity_is_not_a_mismatch(self):
        result = self.sync_existing(STOCK_ASSIGNMENT, STOCK_ASSIGNMENT)
        self.assertEqual(result, "The PCB already contains all schematic footprint assignments.")

    def test_escaped_qualified_identity_matches_decoded_board_root(self):
        assignment = '庫\\"A:封裝\\"µ'
        result = self.sync_existing(assignment, assignment)
        self.assertEqual(result, "The PCB already contains all schematic footprint assignments.")

    def test_legacy_bare_name_is_reported_without_automatic_changes(self):
        result = self.sync_existing(STOCK_ASSIGNMENT, "R_0603_1608Metric")
        self.assertIn("Existing footprint mismatches:", result)
        self.assertIn("R1: board has R_0603_1608Metric, schematic expects " + STOCK_ASSIGNMENT, result)
        self.assertIn("Mismatched footprints replaced: 0", result)
        self.assertIn("New footprints added: 0", result)

    def test_different_library_same_leaf_is_a_mismatch_without_changes(self):
        result = self.sync_existing("Library_B:SharedLeaf", "Library_A:SharedLeaf")
        self.assertIn("R1: board has Library_A:SharedLeaf, schematic expects Library_B:SharedLeaf", result)
        self.assertIn("Mismatched footprints replaced: 0", result)

    def test_invalid_schematic_assignments_still_fail_split_validation(self):
        for assignment in ("SharedLeaf", ":SharedLeaf", "Library_A:"):
            with self.subTest(assignment=assignment):
                before = self.write_existing_board("Library_A:SharedLeaf")
                with self.assertRaisesRegex(ValueError, "Library:Footprint"):
                    self.sync_existing(assignment, "Library_A:SharedLeaf")
                self.assertEqual(self.board.read_bytes(), before)
                self.forbidden["_transactional_board_write"].assert_not_called()

    def test_renderer_rejects_invalid_assignment_before_resolving(self):
        for assignment in ("SharedLeaf", ":SharedLeaf", "Library_A:"):
            with self.subTest(assignment=assignment):
                with self.assertRaisesRegex(ValueError, "Library:Footprint"):
                    self.render(assignment)
        self.resolver.assert_not_called()

    def test_renderer_rejects_missing_or_malformed_root(self):
        for content in ('(module "SharedLeaf" (layer "F.Cu"))',
                        '(footprint SharedLeaf (layer "F.Cu"))',
                        '(footprint "SharedLeaf"junk (layer "F.Cu"))'):
            with self.subTest(content=content):
                self.footprint.write_text(content, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "no quoted root name"):
                    self.render("Library_A:SharedLeaf")

    def test_registered_descriptor_carries_exact_marker_only_on_sync(self):
        self.assertEqual(self.registered_descriptor["_meta"], {MARKER_KEY: MARKER_VALUE})
        marked = [descriptor["name"] for descriptor in self.descriptors
                  if MARKER_KEY in descriptor.get("_meta", {})]
        self.assertEqual(marked, ["pcb_sync_from_schematic"])
        self.assertGreater(len(self.descriptors), 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("module", type=Path, help="Absolute path to target kicad_mcp/tools/pcb.py")
    arguments = parser.parse_args()
    module_path = arguments.module.resolve(strict=True)
    raw_module = module_path.read_bytes()
    captured = io.StringIO()
    with redirect_stdout(captured):
        QualifiedFootprintIdentityTests.target = load_target(module_path)
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(QualifiedFootprintIdentityTests)
        details = io.StringIO()
        result = unittest.TextTestRunner(stream=details, verbosity=2).run(suite)
    report = {
        "success": result.wasSuccessful(),
        "testsRun": result.testsRun,
        "module": {"path": str(module_path), "sha256": hashlib.sha256(raw_module).hexdigest(),
                   "sizeBytes": len(raw_module)},
        "registeredDescriptor": getattr(QualifiedFootprintIdentityTests, "registered_descriptor", None),
        "registeredToolCount": len(getattr(QualifiedFootprintIdentityTests, "descriptors", [])),
        "details": details.getvalue(),
        "capturedStdout": captured.getvalue(),
    }
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
