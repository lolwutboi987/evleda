from __future__ import annotations

import hashlib
import unittest
from pathlib import Path

from backend.kicad_io import (
    DiagnosticDisposition,
    ImportEvidence,
    KiCadInvariantError,
    KiCadSyntaxError,
    PadKind,
    UnsupportedConstructError,
    UnsupportedPolicy,
    canonical_net_id,
    export_board,
    import_board,
    round_trip,
)
from backend.kicad_io.sexpr import ParseLimits, parse

FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad"


class KiCadCodecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.supported = (FIXTURES / "supported_board.kicad_pcb").read_bytes()
        self.unsupported = (FIXTURES / "unsupported_zone.kicad_pcb").read_bytes()

    def test_imports_requested_integer_geometry_and_canonical_net_identity(self) -> None:
        result = import_board(self.supported)
        board = result.board

        self.assertEqual(board.generator_version, "10.0.0")
        self.assertEqual(
            board.outline_vertices,
            (
                board.outline_vertices[0].__class__(0, 0),
                board.outline_vertices[0].__class__(0, 25_000_000),
                board.outline_vertices[0].__class__(40_000_000, 25_000_000),
                board.outline_vertices[0].__class__(40_000_000, 0),
            ),
        )
        self.assertEqual({item.name for item in board.nets}, {"GND", "SIG"})
        self.assertEqual(
            {item.net_id for item in board.nets},
            {canonical_net_id("GND"), canonical_net_id("SIG")},
        )
        self.assertEqual(len(board.footprints), 2)
        pads = tuple(pad for footprint in board.footprints for pad in footprint.pads)
        smd = [item for item in pads if item.kind is PadKind.SMD]
        through_hole = [item for item in pads if item.kind is PadKind.THROUGH_HOLE]
        self.assertEqual({item.drill_x_nm for item in smd}, {0})
        self.assertEqual({item.drill_y_nm for item in smd}, {0})
        self.assertEqual(through_hole[0].drill_x_nm, 900_000)
        self.assertEqual(through_hole[0].drill_y_nm, 900_000)
        self.assertEqual(board.vias[0].layers, ("F.Cu", "B.Cu"))
        self.assertEqual(board.vias[0].net_id, canonical_net_id("SIG"))
        self.assertEqual(board.zones[0].net_id, canonical_net_id("GND"))
        self.assertEqual(board.zones[0].layer, "F.Cu")
        self.assertEqual(board.zones[0].clearance_nm, 200_000)
        self.assertEqual(len(board.zones[0].boundary), 4)
        self.assertTrue(
            all(
                item.disposition is DiagnosticDisposition.PRESERVED
                for item in board.diagnostics.constructs
            )
        )

        self.assertEqual(result.evidence.source_sha256, hashlib.sha256(self.supported).hexdigest())
        self.assertEqual(result.evidence.normalized_ir_sha256, board.normalized_ir_sha256)
        self.assertEqual(
            result.evidence.diagnostics_manifest_sha256,
            board.diagnostics.manifest_sha256,
        )
        self.assertEqual(result.evidence.kicad_execution, "not-run")

    def test_local_net_codes_do_not_change_normalized_ir_identity(self) -> None:
        original = import_board(self.supported).board
        renumbered = self.supported
        replacements = (
            (b'(net 1 "GND")', b'(net 41 "GND")'),
            (b'(net 2 "SIG")', b'(net 9 "SIG")'),
            (b'(net 1)', b'(net 41)'),
            (b'(net 2)', b'(net 9)'),
            (b'(net 1 "GND")', b'(net 41 "GND")'),
            (b'(net 2 "SIG")', b'(net 9 "SIG")'),
        )
        for before, after in replacements:
            renumbered = renumbered.replace(before, after)
        parsed = import_board(renumbered).board
        self.assertEqual(original.normalized_ir_sha256, parsed.normalized_ir_sha256)
        self.assertNotEqual(
            hashlib.sha256(self.supported).hexdigest(),
            hashlib.sha256(renumbered).hexdigest(),
        )

    def test_export_is_deterministic_and_round_trip_has_exact_parity_evidence(self) -> None:
        board = import_board(self.supported).board
        first = export_board(board)
        second = export_board(board)
        self.assertEqual(first.payload, second.payload)
        self.assertEqual(first.evidence, second.evidence)
        self.assertEqual(first.evidence.exported_sha256, hashlib.sha256(first.payload).hexdigest())
        self.assertEqual(first.evidence.kicad_execution, "not-run")

        result = round_trip(self.supported)
        self.assertTrue(result.evidence.semantic_parity)
        self.assertTrue(result.evidence.diagnostics_parity)
        self.assertEqual(result.evidence.kicad_execution, "not-run")
        self.assertEqual(len(result.evidence.evidence_sha256), 64)
        self.assertEqual(
            result.imported.evidence.normalized_ir_sha256,
            result.reparsed.evidence.normalized_ir_sha256,
        )

    def test_zone_hole_fill_and_thermal_spokes_fail_closed_with_manifest(self) -> None:
        with self.assertRaises(UnsupportedConstructError) as caught:
            import_board(self.unsupported)
        self.assertEqual(len(caught.exception.manifest_sha256), 64)
        reasons = " ".join(item.reason for item in caught.exception.diagnostics)
        self.assertIn("thermal-spoke", reasons)
        self.assertIn("hole", reasons)
        self.assertIn("fill", reasons)

        reviewed = import_board(
            self.unsupported, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        self.assertEqual(len(reviewed.board.zones), 1)
        self.assertEqual(len(reviewed.board.zones[0].boundary), 4)
        self.assertGreaterEqual(len(reviewed.board.diagnostics.unsupported), 3)
        with self.assertRaises(UnsupportedConstructError):
            export_board(reviewed.board)

        preserved = export_board(reviewed.board, preserve_unsupported=True)
        self.assertIn(b"thermal_relief", preserved.payload)
        self.assertIn(b"thermal_gap", preserved.payload)
        self.assertEqual(preserved.evidence.preserved_unsupported, True)
        parity = round_trip(
            self.unsupported, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        self.assertTrue(parity.evidence.semantic_parity)
        self.assertTrue(parity.evidence.diagnostics_parity)

    def test_curved_edge_cuts_is_never_flattened(self) -> None:
        curved = self.supported.replace(
            b"(segment\n    (start 11 10)",
            (
                b"(gr_arc (start 1 1) (mid 2 0) (end 3 1) "
                b'(stroke (width 0.05) (type default)) (layer "Edge.Cuts"))\n'
                b"  (segment\n    (start 11 10)"
            ),
            1,
        )
        with self.assertRaises(UnsupportedConstructError) as caught:
            import_board(curved)
        self.assertTrue(
            any(item.head == "gr_arc" for item in caught.exception.diagnostics)
        )
        reviewed = import_board(curved, unsupported_policy=UnsupportedPolicy.MANIFEST)
        self.assertEqual(len(reviewed.board.outline_vertices), 4)
        output = export_board(reviewed.board, preserve_unsupported=True).payload
        self.assertIn(b"(gr_arc", output)

    def test_rejects_sub_nanometre_geometry_and_non_kicad_10_declaration(self) -> None:
        too_precise = self.supported.replace(b"(width 0.25)", b"(width 0.0000001)", 1)
        with self.assertRaises(KiCadInvariantError):
            import_board(too_precise)
        wrong_major = self.supported.replace(b"10.0.0", b"9.0.0", 1)
        with self.assertRaises(KiCadInvariantError):
            import_board(wrong_major)

    def test_rejects_open_or_branched_outline(self) -> None:
        open_outline = self.supported.replace(
            (
                b"(end 0 0)\n    (stroke (width 0.05) (type default))\n"
                b'    (layer "Edge.Cuts")\n'
                b"    (uuid 00000000-0000-4000-8000-000000000304)"
            ),
            (
                b"(end 1 0)\n    (stroke (width 0.05) (type default))\n"
                b'    (layer "Edge.Cuts")\n'
                b"    (uuid 00000000-0000-4000-8000-000000000304)"
            ),
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(open_outline)

    def test_rejects_self_intersecting_zone_and_evidence_cannot_claim_execution(self) -> None:
        bow_tie = self.supported.replace(
            b"(xy 1 1)\n        (xy 39 1)\n        (xy 39 24)\n        (xy 1 24)",
            b"(xy 1 1)\n        (xy 39 24)\n        (xy 39 1)\n        (xy 1 24)",
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(bow_tie)
        with self.assertRaises(KiCadInvariantError):
            ImportEvidence("0" * 64, "1" * 64, "2" * 64, "test", "executed")

    def test_s_expression_parser_enforces_utf8_size_and_nesting_limits(self) -> None:
        with self.assertRaises(KiCadSyntaxError):
            parse(b"\xff")
        with self.assertRaises(KiCadSyntaxError):
            parse(b"(a b c)", limits=ParseLimits(maximum_bytes=4))
        with self.assertRaises(KiCadSyntaxError):
            parse(b"((a))", limits=ParseLimits(maximum_depth=1))


if __name__ == "__main__":
    unittest.main()
