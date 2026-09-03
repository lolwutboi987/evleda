from __future__ import annotations

import unittest
from dataclasses import replace

from backend.verification import (
    BoardGraph,
    BoardOutline,
    Finding,
    PointNm,
    Severity,
    VerificationEngine,
    VerificationReport,
    Via,
    ZoneFillState,
)
from tests.verification.fixtures import (
    MM,
    drilled_pad_board,
    safe_board,
    via_attachment_board,
    zone_edge_clearance_board,
    zone_pad_clearance_board,
    zone_pair_clearance_board,
)


def findings_for(report: VerificationReport, rule_id: str) -> list[Finding]:
    return [item for item in report.findings if item.rule_id == rule_id]


class RealisticCopperRelationshipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = VerificationEngine()

    def test_drilled_pad_annular_ring_equality_passes_and_one_nm_diameter_fails(self) -> None:
        at_limit = self.engine.verify(drilled_pad_board(400_000, 200_000))
        below = self.engine.verify(drilled_pad_board(399_999, 200_000))

        self.assertFalse(findings_for(at_limit, "GEO.PAD.MIN_ANNULAR_RING"))
        violation = findings_for(below, "GEO.PAD.MIN_ANNULAR_RING")
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(199_999, evidence["actual_annular_ring_numerator_nm"])
        self.assertEqual(2, evidence["actual_annular_ring_denominator"])

    def test_pad_and_via_drills_must_be_strictly_inside_copper(self) -> None:
        board = drilled_pad_board(200_000, 200_000)
        board = replace(
            board,
            vias=(
                Via(
                    "via-invalid",
                    "net-signal",
                    PointNm(6 * MM, 5 * MM),
                    200_000,
                    200_000,
                    ("F.Cu", "B.Cu"),
                ),
            ),
        )
        findings = findings_for(self.engine.verify(board), "ALG.ROUTING.TOPOLOGY")

        self.assertEqual({"pin", "via"}, {item.entities[0].kind for item in findings})
        self.assertTrue(all(len(item.evidence_hash) == 64 for item in findings))
        issue_sets = {
            item.entities[0].kind: next(
                evidence.value for evidence in item.evidence if evidence.name == "issues"
            )
            for item in findings
        }
        self.assertIn("drill_not_smaller_than_copper", issue_sets["pin"])
        self.assertIn("drill_not_smaller_than_diameter", issue_sets["via"])

    def test_via_annular_ring_equality_passes_and_one_nm_diameter_fails(self) -> None:
        at_limit = via_attachment_board(attached=True)
        below = replace(
            at_limit,
            vias=(replace(at_limit.vias[0], diameter_nm=399_999),),
        )
        self.assertFalse(
            findings_for(self.engine.verify(at_limit), "GEO.VIA.MIN_ANNULAR_RING")
        )
        violation = findings_for(
            self.engine.verify(below), "GEO.VIA.MIN_ANNULAR_RING"
        )
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(199_999, evidence["actual_annular_ring_numerator_nm"])
        self.assertEqual(2, evidence["actual_annular_ring_denominator"])

    def test_via_must_touch_copper_on_its_declared_net(self) -> None:
        attached = self.engine.verify(via_attachment_board(attached=True))
        detached_board = via_attachment_board(attached=False)
        first = self.engine.verify(detached_board)
        second = self.engine.verify(detached_board)

        self.assertFalse(findings_for(attached, "ALG.VIA.NET_CONNECTIVITY"))
        violations = findings_for(first, "ALG.VIA.NET_CONNECTIVITY")
        self.assertEqual(1, len(violations))
        self.assertEqual(first, second)
        self.assertEqual(64, len(violations[0].evidence_hash))

    def test_zone_to_pad_clearance_equality_passes_and_one_nm_below_fails(self) -> None:
        at_limit = self.engine.verify(zone_pad_clearance_board(550_000))
        below = self.engine.verify(zone_pad_clearance_board(549_999))

        self.assertFalse(findings_for(at_limit, "GEO.COPPER.MIN_CLEARANCE"))
        violation = findings_for(below, "GEO.COPPER.MIN_CLEARANCE")
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(549_999**2, evidence["boundary_distance_squared_numerator"])
        self.assertEqual(1, evidence["boundary_distance_squared_denominator"])
        self.assertEqual(1_100_000, evidence["required_center_distance_doubled_nm"])

    def test_zone_to_zone_clearance_is_exact_and_reordering_is_canonical(self) -> None:
        at_limit = self.engine.verify(zone_pair_clearance_board(150_000))
        reordered = self.engine.verify(
            zone_pair_clearance_board(150_000, reverse=True)
        )
        below = self.engine.verify(zone_pair_clearance_board(149_999))

        self.assertEqual(at_limit, reordered)
        self.assertFalse(findings_for(at_limit, "GEO.COPPER.MIN_CLEARANCE"))
        violation = findings_for(below, "GEO.COPPER.MIN_CLEARANCE")
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(149_999**2, evidence["boundary_distance_squared_numerator"])
        self.assertEqual(150_000, evidence["required_clearance_nm"])

    def test_zone_to_board_edge_clearance_equality_passes_and_one_nm_below_fails(self) -> None:
        at_limit = self.engine.verify(zone_edge_clearance_board(250_000))
        below = self.engine.verify(zone_edge_clearance_board(249_999))

        self.assertFalse(findings_for(at_limit, "GEO.COPPER.BOARD_EDGE_CLEARANCE"))
        violation = findings_for(below, "GEO.COPPER.BOARD_EDGE_CLEARANCE")
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(249_999**2, evidence["boundary_distance_squared_numerator"])
        self.assertEqual(250_000, evidence["required_boundary_clearance_nm"])

    def test_self_intersecting_zone_outline_fails_mandatory_rule(self) -> None:
        board = zone_pair_clearance_board(150_000)
        invalid = replace(
            board.zones[0],
            outline=BoardOutline(
                (
                    PointNm(2 * MM, 2 * MM),
                    PointNm(4 * MM, 4 * MM),
                    PointNm(2 * MM, 4 * MM),
                    PointNm(4 * MM, 2 * MM),
                )
            ),
            fill_state=ZoneFillState.UNFILLED_INTENT,
            fill_evidence=None,
        )
        report = self.engine.verify(replace(board, zones=(invalid, board.zones[1])))
        violations = findings_for(report, "GEO.ZONE.OUTLINE_VALID")

        self.assertTrue(violations)
        self.assertTrue(all(item.severity is Severity.FATAL for item in violations))
        self.assertFalse(next(gate for gate in report.gates if gate.gate_id == "preview").passed)

    def test_pad_via_and_zone_layers_must_belong_to_board_stack(self) -> None:
        board = safe_board()
        component = board.components[0]
        bad_pin = replace(component.pins[0], layers=("In99.Cu",))
        bad_component = replace(component, pins=(bad_pin,))
        bad_zone = replace(
            zone_edge_clearance_board(1 * MM).zones[0],
            net_id="net-signal",
            layer="In99.Cu",
            fill_state=ZoneFillState.UNFILLED_INTENT,
            fill_evidence=None,
        )
        invalid = replace(
            board,
            components=(bad_component, board.components[1]),
            vias=(
                Via(
                    "via-layer",
                    "net-signal",
                    PointNm(6 * MM, 5 * MM),
                    400_000,
                    200_000,
                    ("F.Cu", "In99.Cu"),
                ),
            ),
            zones=(bad_zone,),
        )
        findings = findings_for(self.engine.verify(invalid), "ALG.ROUTING.TOPOLOGY")

        self.assertEqual({"pin", "via", "zone"}, {item.entities[0].kind for item in findings})
        self.assertTrue(
            all(
                "unknown_layer"
                in next(item.value for item in finding.evidence if item.name == "issues")
                for finding in findings
            )
        )

    def test_cross_net_pad_via_clearance_uses_exact_radii(self) -> None:
        base = zone_pad_clearance_board(550_000)
        pin_center = base.components[0].pins[0].pad_center
        assert pin_center is not None

        def with_via(center_distance_nm: int) -> BoardGraph:
            return replace(
                base,
                zones=(),
                vias=(
                    Via(
                        "via-other-net",
                        "net-zone",
                        PointNm(pin_center.x + center_distance_nm, pin_center.y),
                        400_000,
                        200_000,
                        ("F.Cu", "B.Cu"),
                    ),
                ),
            )

        at_limit = self.engine.verify(with_via(750_000))
        below = self.engine.verify(with_via(749_999))
        self.assertFalse(findings_for(at_limit, "GEO.COPPER.MIN_CLEARANCE"))
        violation = findings_for(below, "GEO.COPPER.MIN_CLEARANCE")
        self.assertEqual(1, len(violation))
        evidence = {item.name: item.value for item in violation[0].evidence}
        self.assertEqual(749_999**2, evidence["center_distance_squared_numerator"])
        self.assertEqual(1_500_000, evidence["required_center_distance_doubled_nm"])


if __name__ == "__main__":
    unittest.main()
