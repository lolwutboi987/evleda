"""DOC9 pure-memory ARC and retained J1/J2 field-planner qualification.

Run only under the pinned runtime Python with -I -s -E -B -X utf8. The baseline
is a replay of retained input, not a recovered original native MCP response.
No native editor, MCP loop, IPC, subprocess, network or source write is used.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

FIXTURE = Path(__file__).resolve().parent / "fixtures/usb-c-mechanical-probe.kicad_sch"
FIXTURE_SHA = "55e2d56e6d65e5bab705a891f8d7360ad21f84a47d26b6a7d1bb933f2a93d68d"
target = None


def arc(start=(1, 0), mid=(0, 1), end=(-1, 0), width=0.2, fill="none"):
    def p(name, xy):
        return f"({name} {xy[0]:.12f} {xy[1]:.12f})"
    return f"(arc {p('start', start)} {p('mid', mid)} {p('end', end)} (stroke (width {width}) (type default)) (fill (type {fill})))"


def point(angle, radius=5, center=(0, 0)):
    radians = math.radians(angle)
    return (center[0] + radius * math.cos(radians), center[1] + radius * math.sin(radians))


def arc_library(value):
    return '(symbol "Test:Arc" (symbol "Arc_0_1" ' + value + '))'


def usb_arcs(source):
    cache = target.child(source, "lib_symbols")
    library = next(lib for lib in target.children(cache)
                   if target.quoted_head(lib, "symbol")[0] == "Connector:USB_C_Receptacle_USB2.0_16P")
    parts = target.children("(selected " + target.selected_graphics(library, 1) + ")")
    return [item for part in parts for item in target.children(part) if target.tag(item) == "arc"]


class ArcFieldLayoutTests(unittest.TestCase):
    def assert_box(self, actual, expected, delta=0.000002):
        for name, value in zip(("x_min", "y_min", "x_max", "y_max"), expected, strict=True):
            self.assertAlmostEqual(getattr(actual, name), value, delta=delta)

    def assert_contains(self, box, xy):
        self.assertLessEqual(box.x_min, xy[0])
        self.assertLessEqual(box.y_min, xy[1])
        self.assertGreaterEqual(box.x_max, xy[0])
        self.assertGreaterEqual(box.y_max, xy[1])

    def test_semicircle_directions(self):
        self.assert_box(target.arc_bounds(arc()), (-1.1, -0.1, 1.1, 1.1))
        self.assert_box(target.arc_bounds(arc((1, 0), (0, -1), (-1, 0))), (-1.1, -1.1, 1.1, 0.1))

    def test_all_quadrants_both_directions_and_major_sweeps(self):
        for start in (5, 85, 175, 265, 355):
            for sweep in (20, 100, 179, 181, 270, 340, -20, -100, -181, -270, -340):
                with self.subTest(start=start, sweep=sweep):
                    shape = arc(point(start), point(start + sweep / 2), point(start + sweep), width=0.4)
                    box = target.arc_bounds(shape)
                    for index in range(1001):
                        xy = point(start + sweep * index / 1000)
                        for dx, dy in ((0.2, 0), (-0.2, 0), (0, 0.2), (0, -0.2)):
                            self.assert_contains(box, (xy[0] + dx, xy[1] + dy))
                    # Independently chosen analytic cardinal points bound every
                    # extrema; dense samples exercise every intervening stroke.
                    points = [point(start), point(start + sweep)]
                    for cardinal in (0, 90, 180, 270):
                        progress = ((cardinal - start) * (1 if sweep > 0 else -1)) % 360
                        if progress <= abs(sweep):
                            points.append(point(cardinal))
                    self.assert_box(box, (min(p[0] for p in points) - .2,
                                          min(p[1] for p in points) - .2,
                                          max(p[0] for p in points) + .2,
                                          max(p[1] for p in points) + .2))

    def test_major_sweep_does_not_collapse_to_endpoint_chord(self):
        box = target.arc_bounds(arc((5, 0), (-5, 0), (0, -5)))
        self.assert_box(box, (-5.1, -5.1, 5.1, 5.1))

    def test_translated_circle(self):
        box = target.arc_bounds(arc((103, -50), (100, -47), (97, -50), width=2))
        self.assert_box(box, (96, -51, 104, -46))

    def test_filled_arc_conservatively_includes_center(self):
        for fill in ("outline", "background"):
            box = target.arc_bounds(arc(point(10), point(20), point(30), fill=fill))
            self.assert_contains(box, (0, 0))

    def test_stroke_radius_and_roundoff_guard(self):
        box = target.arc_bounds(arc(width=2))
        self.assertLess(box.x_min, -2)
        self.assertLess(box.y_min, -1)
        self.assertGreater(box.x_max, 2)
        self.assertGreater(box.y_max, 2)

    def test_ill_conditioned_collinear_coincident_and_full_circle_reject(self):
        for points in (((0, 0), (1, 0), (2, 0)), ((1, 0), (1, 0), (-1, 0)),
                       ((1, 0), (-1, 0), (1, 0)), ((0, 0), (1, 0.000000001), (2, 0)),
                       ((0, 0), (0.00000001, 0), (0, 0.00000001))):
            with self.subTest(points=points), self.assertRaises(ValueError):
                target.arc_bounds(arc(*points))

    def test_nonfinite_overflow_and_bounded_coordinates_reject(self):
        for value in ("nan", "inf", "-inf", "1e309", "9" * 400, "10001"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                target.arc_bounds(arc().replace("(start 1.000000000000", "(start " + value))

    def test_missing_duplicate_extra_and_bare_forms_reject(self):
        shape = arc()
        cases = (shape.replace("(mid 0.000000000000 1.000000000000)", ""),
                 shape[:-1] + " (start 2 0))", shape[:-1] + " (radius 1))",
                 shape.replace("(arc ", "(arc bare "),
                 shape.replace("(width 0.2)", "(width 0.2) (width 0.2)"),
                 shape.replace("(type none)", "(type none) (type none)"),
                 shape.replace("(start 1.000000000000 0.000000000000)", "(start 1 0 trailing)"),
                 shape.replace("(stroke ", "(stroke (color 0 0 0 1) "))
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                target.arc_bounds(value)

    def test_unknown_default_or_invalid_strokes_and_fill_reject(self):
        for value in (0, -1, "nan", "inf", "1e309", 10001):
            with self.subTest(width=value), self.assertRaises(ValueError):
                target.arc_bounds(arc(width=value))
        for value in (arc().replace("type default", "type dash"), arc(fill="mystery")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                target.arc_bounds(value)

    def test_bezier_and_library_text_stay_unsupported(self):
        for kind in ("bezier", "text", "text_box"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "Unsupported"):
                target.body_and_pins(arc_library(f"({kind})"), "Test:Arc", 1, 0, 0, 0)

    def test_arc_only_symbols_and_cardinal_transforms(self):
        shape = arc((6, 3), (3, 6), (0, 3), width=.4)
        library = arc_library(shape)
        local = target.arc_bounds(shape)
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                box, pins = target.body_and_pins(library, "Test:Arc", 1, 50, 75, rotation)
                self.assertEqual(pins, [])
                for index in range(1001):
                    xy = point(180 * index / 1000, 3, (3, 3))
                    for dx, dy in ((.2, 0), (-.2, 0), (0, .2), (0, -.2)):
                        px, py = target._rotate_local(xy[0] + dx, xy[1] + dy, rotation)
                        self.assert_contains(box, (50 + px, 75 + py))
                self.assertEqual(library, arc_library(shape))
                self.assertIn(shape, target.selected_graphics(library, 1))
                self.assertGreater(local.width, 6)

    def test_nonselected_unit_arcs_are_not_interpreted(self):
        library = '(symbol "Test:Arc" (symbol "Arc_0_1" ' + arc() + ') (symbol "Arc_2_1" (arc unsupported)))'
        self.assertNotIn("unsupported", target.selected_graphics(library, 1))
        target.body_and_pins(library, "Test:Arc", 1, 0, 0, 0)
        with self.assertRaises(ValueError):
            target.body_and_pins(library, "Test:Arc", 2, 0, 0, 0)

    def test_six_actual_retained_usb_arcs_preserved_and_bounded(self):
        arcs = usb_arcs(self.source)
        self.assertEqual(len(arcs), 6)
        expected = [(-7.747, 3.683, -6.223, 4.5693),
                    (-7.747, 3.680294, -6.223, 4.5693),
                    (-9.144, 3.556, -4.826, 5.9607),
                    (-9.144, -5.9607, -4.826, -3.556),
                    (-7.747, -4.5693, -6.223, -3.683),
                    (-7.747, -4.5693, -6.223, -3.680294)]
        for index, (shape, bound) in enumerate(zip(arcs, expected, strict=True)):
            with self.subTest(index=index):
                self.assert_box(target.arc_bounds(shape), bound, delta=0.00002)
                self.assertIn(shape, self.source)

    def test_retained_full_model_and_sequential_J1_J2_mutator(self):
        from kicad_mcp.tools import schematic
        model = target.presentation_model(self.source)
        self.assertIn("J1", [s.reference for s in model.symbols])
        self.assertIn("J2", [s.reference for s in model.symbols])
        # Exercise the actual existing native tool's pure planner/mutator only.
        mutator, targets, updated = schematic._build_autoplace_fields_mutator(FIXTURE, ["J1", "J2"])
        after = mutator(self.source)
        self.assertEqual(targets, ["J1", "J2"])
        self.assertEqual(updated, ["J1"])  # J2's existing fields already match its clear plan.
        self.assertNotEqual(after, self.source)
        self.assertEqual(target.presentation_signature(after), target.presentation_signature(self.source))
        self.assertEqual(target.child(after, "lib_symbols"), target.child(self.source, "lib_symbols"))
        self.assertEqual(usb_arcs(after), usb_arcs(self.source))
        after_model = target.presentation_model(after)
        for reference in ("J1", "J2"):
            symbol = next(s for s in after_model.symbols if s.reference == reference)
            boxes = [f.box() for f in symbol.fields if f.name in ("Reference", "Value") and not f.hidden]
            self.assertFalse(any(b.overlaps(o) for b in boxes for o in target.obstacles_for(after_model, symbol)))
            self.assertFalse(boxes[0].overlaps(boxes[1]))
        self.__class__.plan_evidence = {
            "targets": targets, "updated": list(updated), "sourceUnchanged": True,
            "inputTextSha256": hashlib.sha256(self.source.encode()).hexdigest(),
            "inputTextDecoding": "UTF-8 universal newlines, matching the existing native mutator read_text call",
            "inMemoryOutputSha256": hashlib.sha256(after.encode()).hexdigest(),
            "presentationSignatureEqual": True, "embeddedLibrariesByteEqual": True,
            "after": target.model_evidence(after),
        }

    def test_mutator_rejects_stale_source_and_duplicate_references(self):
        from kicad_mcp.tools import schematic
        mutator, _, _ = schematic._build_autoplace_fields_mutator(FIXTURE, ["J1", "J2"])
        with self.assertRaisesRegex(ValueError, "source changed"):
            mutator(self.source + "\n")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            schematic._build_autoplace_fields_mutator(FIXTURE, ["J1", "J1"])

    def test_mutation_fence_still_detects_arc_and_other_source_changes(self):
        shape = usb_arcs(self.source)[0]
        changed = self.source.replace(shape, shape.replace("0.254", "0.255"), 1)
        self.assertNotEqual(target.presentation_signature(changed), target.presentation_signature(self.source))
        self.assertNotEqual(target.presentation_signature(self.source.replace('"J1"', '"J9"')),
                            target.presentation_signature(self.source))


def main():
    global target
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--candidate", type=Path)
    args = parser.parse_args()
    before = FIXTURE.read_bytes()
    assert hashlib.sha256(before).hexdigest() == FIXTURE_SHA
    assert sys.flags.isolated == sys.flags.no_user_site == sys.flags.ignore_environment == sys.flags.dont_write_bytecode == sys.flags.utf8_mode == 1
    captured = io.StringIO()
    with redirect_stdout(captured), \
         patch.object(subprocess, "Popen", side_effect=AssertionError("Offline test attempted subprocess")), \
         patch.object(socket, "create_connection", side_effect=AssertionError("Offline test attempted connection")), \
         patch.object(socket.socket, "connect", side_effect=AssertionError("Offline test attempted socket connect")):
        from kicad_mcp.utils import field_layout
        target = field_layout
        if args.candidate:
            spec = importlib.util.spec_from_file_location("kicad_mcp.utils.field_layout", args.candidate.resolve(strict=True))
            target = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = target
            spec.loader.exec_module(target)
        module = Path(target.__file__).resolve()
        source = FIXTURE.read_text(encoding="utf-8")
        if args.baseline:
            try:
                target.presentation_model(source)
                raise AssertionError("DOC7 unexpectedly accepted retained ARC geometry")
            except ValueError as error:
                assert str(error) == "Unsupported arc/Bezier/library text geometry for presentation planning"
                outcome = {"success": True, "baselineRejected": True, "exceptionType": type(error).__name__,
                           "exceptionMessage": str(error), "testsRun": 1,
                           "evidenceKind": "pure-memory replay, not original native MCP error text"}
        else:
            ArcFieldLayoutTests.source = source
            details = io.StringIO()
            result = unittest.TextTestRunner(stream=details, verbosity=2).run(
                unittest.defaultTestLoader.loadTestsFromTestCase(ArcFieldLayoutTests))
            outcome = {"success": result.wasSuccessful(), "testsRun": result.testsRun,
                       "details": details.getvalue(), "planEvidence": getattr(ArcFieldLayoutTests, "plan_evidence", None)}
    assert FIXTURE.read_bytes() == before
    report = {**outcome, "module": {"path": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest(),
                                    "sizeBytes": module.stat().st_size},
              "fixture": {"path": str(FIXTURE), "sha256": FIXTURE_SHA, "sizeBytes": len(before)},
              "fixtureUnchanged": True, "pythonExecutable": sys.executable,
              "pythonFlags": {"isolated": sys.flags.isolated, "no_user_site": sys.flags.no_user_site,
                              "ignore_environment": sys.flags.ignore_environment,
                              "dont_write_bytecode": sys.flags.dont_write_bytecode, "utf8_mode": sys.flags.utf8_mode},
              "capturedStdout": captured.getvalue(), "nativeApiCalls": 0}
    print(json.dumps(report, indent=2))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
