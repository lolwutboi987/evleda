"""Bounded offline DOC11 producer regression plus retained native oracle replay.

Run with DOC10 environment/Scripts/python.exe -I -s -E -B this_file.py.
No editor, native CLI, managed project, runtime publication or network access.
Only tiny disposable fixtures inside this overlay are written.
"""
from __future__ import annotations

import asyncio
from contextlib import ExitStack
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
if shutil.disk_usage(ROOT).free < 155 * 1024 * 1024:
    raise RuntimeError("DOC11 tests require 150 MiB reserve plus 5 MiB budget")


def load(name: str, file: Path):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


helper = load("kicad_mcp.utils.footprint_pose", ROOT / "kicad_mcp/utils/footprint_pose.py")
target = load("kicad_mcp.tools._evleda_doc11_pose_target", ROOT / "kicad_mcp/tools/pcb.py")
old = load("evleda_doc6_test_fixture", ROOT.parent / "doc6/test_qualified_footprint_identity.py")
ORACLE = ROOT / ("oracle-final" if (ROOT / "oracle-final/manifest.json").exists() else "oracle")
manifest = json.loads((ORACLE / "manifest.json").read_text())


def direct(node, name):
    return [child for child in node.children if child.name == name]


def pose(node):
    values = [value.text for value in direct(node, "at")[0].values]
    if values[-1] == "unlocked":
        values.pop()
    return (int(Decimal(values[0]) * 1_000_000), int(Decimal(values[1]) * 1_000_000),
            int(Decimal(values[2])) % 360 if len(values) == 3 else 0)


def child_key(node):
    if node.name == "pad":
        return (node.name, node.values[0].text, pose(node)[:2])
    return (node.name, tuple(value.text for value in node.values[:1 if node.name == "property" else 2]))


def child_poses(node):
    return {child_key(child): pose(child) for child in node.children if child.name in {"pad", "property", "fp_text"}}


def footprint_from_board(source):
    # Isolate the genuine top-level footprint with the pinned quote-aware parser.
    marker = source.index('\n\t(footprint ')
    block, _ = target._extract_block(source, marker + 2)
    return helper._parse(block)


def assert_only_angle_tokens_changed(before, after):
    """Undo only allowed angle edits; all remaining bytes must be identical."""
    old_children = [n for n in helper._parse(before).children if n.name in {"pad", "property", "fp_text"}]
    new_children = [n for n in helper._parse(after).children if n.name in {"pad", "property", "fp_text"}]
    if len(old_children) != len(new_children):
        raise AssertionError("Child inventory changed")
    restores = []
    for old_node, new_node in zip(old_children, new_children):
        old_values = [v for v in direct(old_node, "at")[0].values if v.text != "unlocked"]
        new_values = [v for v in direct(new_node, "at")[0].values if v.text != "unlocked"]
        old_angle = old_values[2] if len(old_values) == 3 else None
        new_angle = new_values[2] if len(new_values) == 3 else None
        if old_angle is not None and new_angle is not None:
            restores.append((new_angle.start, new_angle.end, old_angle.text))
        elif new_angle is not None:
            if after[new_values[1].end:new_angle.end] != " " + new_angle.text:
                raise AssertionError("Insertion changed original pose suffix whitespace")
            restores.append((new_values[1].end, new_angle.end, ""))
        elif old_angle is not None:
            gap = before[old_values[1].end:old_angle.start]
            insertion = new_values[1].end + len(gap)
            if after[new_values[1].end:insertion] != gap:
                raise AssertionError("Angle deletion changed original pose whitespace")
            restores.append((insertion, insertion, old_angle.text))
    restored = after
    for start, end, text in sorted(restores, reverse=True):
        restored = restored[:start] + text + restored[end:]
    if restored != before:
        raise AssertionError("Bytes outside allowed angle tokens changed")


class PoseTests(unittest.TestCase):
    def test_native_oracle_all_cardinals_and_local_angles(self):
        for row in manifest["rows"]:
            with self.subTest(fixture=row["fixture"], rotation=row["rotation"]):
                source_bytes = Path(row["source"]).read_bytes()
                self.assertEqual(hashlib.sha256(source_bytes).hexdigest(), row["sourceSha256"])
                oracle_bytes = (ORACLE / row["file"]).read_bytes()
                self.assertEqual(hashlib.sha256(oracle_bytes).hexdigest(), row["sha256"])
                source = source_bytes.decode("utf-8").strip()
                planned = helper.project_library_footprint_angles(source, row["rotation"])
                original = helper._parse(source)
                projection = helper._parse(planned)
                native = footprint_from_board(oracle_bytes.decode("utf-8"))
                # Every original child survives with native absolute angle and
                # exact local XY. Native synthesized Datasheet/Description
                # fields are outside original template inventory.
                wanted, actual = child_poses(projection), child_poses(native)
                for key, expected in wanted.items():
                    self.assertEqual(actual[key], expected, key)
                self.assertEqual(len(direct(projection, "pad")), len(direct(native, "pad")))
                assert_only_angle_tokens_changed(source, planned)
                self.assertEqual([source[n.start:n.end] for n in direct(original, "model")],
                                 [planned[n.start:n.end] for n in direct(projection, "model")])
                # An independent native API observation supplies integer-nm
                # anchors, sizes and drills; no rounded host geometry witness.
                native_pads = sorted(row["nativePads"], key=lambda p: (p["number"], p["positionNm"]))
                expected_pads = []
                for pad in direct(projection, "pad"):
                    x, y, angle = pose(pad)
                    rotation = row["rotation"]
                    dx, dy = (x, y) if rotation == 0 else (y, -x) if rotation == 90 else (-x, -y) if rotation == 180 else (-y, x)
                    size = direct(pad, "size")[0]
                    drill = direct(pad, "drill")
                    sizes = [int(Decimal(value.text) * 1_000_000) for value in size.values]
                    if drill:
                        dims = [value.text for value in drill[0].values]
                        if dims[0] == "oval":
                            dims = dims[1:]
                        if len(dims) == 1:
                            dims *= 2
                        drills = [int(Decimal(value) * 1_000_000) for value in dims]
                    else:
                        drills = [0, 0]
                    expected_pads.append({"number": json.loads(pad.values[0].text), "positionNm": [100000000 + dx, 100000000 + dy],
                                          "orientationDeg": angle, "sizeNm": sizes, "drillNm": drills})
                self.assertEqual(native_pads, sorted(expected_pads, key=lambda p: (p["number"], p["positionNm"])))

    def test_zero_rotation_is_byte_identical_and_nonzero_local_angles_survive(self):
        source = old.GEOMETRY_FOOTPRINT
        self.assertEqual(helper.project_library_footprint_angles(source, 0), source)
        projected = helper._parse(helper.project_library_footprint_angles(source, 270))
        self.assertEqual([pose(p)[2] for p in direct(projected, "pad")], [0, 270])
        self.assertIn('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', helper.project_library_footprint_angles(source, 90))

    def test_unknown_mirror_placed_or_malformed_source_rejects(self):
        base = old.GEOMETRY_FOOTPRINT
        cases = [base.replace('(layer "F.Cu")', '(layer "B.Cu")', 1),
                 base.replace('(layer "F.Cu")', '(layer "F.Cu") (at 1 2 90)', 1),
                 base.replace('(layer "F.Cu")', '(layer "F.Cu") (uuid "already-placed")', 1),
                 base.replace('(layer "F.Cu")', '(layer "F.Cu") (fp_text_box "unsupported")', 1),
                 base.replace('(at -0.8 0 90)', '(at -0.8 0 45)'),
                 base.replace('(at -0.8 0 90)', '(at -0.8000001 0 90)'),
                 base.replace('(at -0.8 0 90)', '(at -0.80000000000000000000000000001 0 90)'),
                 base.replace('(at -0.8 0 90)', '(at 1_000 0 90)'),
                 base.replace('(at -0.8 0 90)', '(at ١ 0 90)'),
                 base.replace('(at -0.8 0 90)', '(at 1e-999999999 0 90)'),
                 base.replace('(at -0.8 0 90)', '(at -0.8 0 90) (at 1 2 90)'),
                 base.replace('(at -0.8 0 90)', '(at -0.8 0 90) (justify mirror)'),
                 base + ' (footprint "extra")', base[:-1]]
        for source in cases:
            with self.subTest(source=source[:80]):
                with self.assertRaises(ValueError):
                    helper.project_library_footprint_angles(source, 90)
        for rotation in [True, 45, 450, float("nan"), 90.1]:
            with self.subTest(rotation=rotation), self.assertRaises(ValueError):
                helper.project_library_footprint_angles(base, rotation)

    def test_renderer_uses_projection_and_new_marker(self):
        server = target.FastMCP("doc11-offline")
        target._register_schematic_sync_tools(server)
        descriptors = [d.model_dump(mode="json", by_alias=True, exclude_none=True) for d in asyncio.run(server.list_tools())]
        descriptor = next(d for d in descriptors if d["name"] == "pcb_sync_from_schematic")
        self.assertEqual(descriptor["_meta"], {
            "evledaQualifiedFootprintIdentitySync": "evleda.kicad-qualified-footprint-identity-sync.v1",
            "evledaQualifiedFootprintPoseSync": "evleda.kicad-qualified-footprint-pose-sync.v1"})
        with tempfile.TemporaryDirectory(dir=ROOT, prefix="offline-render-") as temporary:
            file = Path(temporary) / "fixture.kicad_mod"
            file.write_text(old.GEOMETRY_FOOTPRINT, encoding="utf-8")
            with patch.object(target, "_footprint_file", return_value=file):
                for angle in [0, 90, 180, 270, -90]:
                    output = target._render_board_footprint_block("Example:SharedLeaf", reference="R9", value="exact value", x_mm=25, y_mm=30, rotation=angle, pad_nets={"1": "GND", "2": "3V3"})
                    fp = helper._parse(output)
                    self.assertEqual([pose(p)[2] for p in direct(fp, "pad")], [(90 + angle) % 360, angle % 360])
                    self.assertIn('(property "Reference" "R9"', output)
                    self.assertIn('(property "Value" "exact value"', output)
                    self.assertIn('(net "3V3")', output)
                    self.assertEqual(pose(fp), (25000000, 30000000, angle % 360))

    def test_existing_matching_sync_is_byte_identical_and_does_not_project_again(self):
        server = target.FastMCP("doc11-no-reinterpret-existing")
        target._register_schematic_sync_tools(server)
        sync = server._tool_manager.get_tool("pcb_sync_from_schematic").fn
        with tempfile.TemporaryDirectory(dir=ROOT, prefix="offline-existing-") as temporary:
            file = Path(temporary) / "board.kicad_pcb"
            library = Path(temporary) / "SharedLeaf.kicad_mod"
            library.write_text(old.GEOMETRY_FOOTPRINT, encoding="utf-8")
            for angle in [0, 90, 180, 270]:
                source = '(kicad_pcb (version 20260206)\n(footprint "Example:SharedLeaf"\n(layer "F.Cu")\n(at 25 30 ' + str(angle) + ')\n(property "Reference" "R1")\n(property "Value" "exact")\n(pad "1" smd rect (at -1 0 90) (size 1 2) (layers "F.Cu"))))'
                file.write_text(source, encoding="utf-8")
                before = file.read_bytes()
                component = dict(reference="R1", value="exact", footprint="Example:SharedLeaf", rotation=(angle + 90) % 360, x=10, y=10)
                with ExitStack() as stack:
                    stack.enter_context(patch.object(target, "_board_is_open", return_value=False))
                    stack.enter_context(patch.object(target, "_pcb_sync_gate_failures", return_value=[]))
                    stack.enter_context(patch.object(target, "_collect_schematic_components", return_value=([component], [])))
                    stack.enter_context(patch.object(target, "_get_pcb_file_for_sync", return_value=file))
                    stack.enter_context(patch.object(target, "_footprint_file", return_value=library))
                    for name in ["_render_board_footprint_block", "_transactional_board_write", "_reload_board_after_file_sync", "_auto_place_force_directed_board_file", "get_board", "_run_cli"]:
                        stack.enter_context(patch.object(target, name, side_effect=AssertionError("Unexpected " + name)))
                    result = sync(use_net_names=False, replace_mismatched=False, auto_place=False)
                self.assertIn("already contains", result)
                self.assertEqual(file.read_bytes(), before)

    def test_mixed_sync_projects_only_new_template_and_preserves_existing_block(self):
        server = target.FastMCP("doc11-mixed-existing-new")
        target._register_schematic_sync_tools(server)
        sync = server._tool_manager.get_tool("pcb_sync_from_schematic").fn
        with tempfile.TemporaryDirectory(dir=ROOT, prefix="offline-mixed-") as temporary:
            library = Path(temporary) / "C.kicad_mod"
            library.write_text(old.STOCK_FOOTPRINT, encoding="utf-8")
            file = Path(temporary) / "board.kicad_pcb"
            with patch.object(target, "_footprint_file", return_value=library):
                existing = target._render_board_footprint_block("Example:R_0603_1608Metric", reference="R1", value="10k", x_mm=25, y_mm=30, rotation=90, pad_nets={})
            file.write_text('(kicad_pcb (version 20260206)\n' + existing + '\n)', encoding="utf-8")
            components = [dict(reference="R1", value="10k", footprint="Example:R_0603_1608Metric", rotation=270, x=10, y=10),
                          dict(reference="R2", value="10k", footprint="Example:R_0603_1608Metric", rotation=270, x=20, y=20)]
            def write(mutator):
                file.write_text(mutator(file.read_text()), encoding="utf-8")
                return str(file)
            with ExitStack() as stack:
                stack.enter_context(patch.object(target, "_board_is_open", return_value=False))
                stack.enter_context(patch.object(target, "_pcb_sync_gate_failures", return_value=[]))
                stack.enter_context(patch.object(target, "_collect_schematic_components", return_value=(components, [])))
                stack.enter_context(patch.object(target, "_get_pcb_file_for_sync", return_value=file))
                stack.enter_context(patch.object(target, "_footprint_file", return_value=library))
                stack.enter_context(patch.object(target, "_planned_board_positions", return_value={"R2": (40, 50)}))
                stack.enter_context(patch.object(target, "_transactional_board_write", side_effect=write))
                for name in ["get_board", "_run_cli", "_reload_board_after_file_sync", "_auto_place_force_directed_board_file"]:
                    stack.enter_context(patch.object(target, name, side_effect=AssertionError("Unexpected " + name)))
                result = sync(use_net_names=False, replace_mismatched=False, auto_place=False, allow_open_board=False)
            after = file.read_text()
            self.assertIn(existing, after)
            self.assertIn("New footprints added: 1", result)
            second = next(block for block in target._iter_blocks(after, "footprint") if '(property "Reference" "R2"' in block)
            node = helper._parse(second)
            self.assertEqual(pose(node), (40000000, 50000000, 270))
            self.assertEqual([pose(p)[2] for p in direct(node, "pad")], [270, 270])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PoseTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                      "nativeOracleCasesReplayed": len(manifest["rows"]), "nativeCallsDuringTests": False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
