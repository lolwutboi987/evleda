from __future__ import annotations

import unittest
from dataclasses import replace

from backend.verification import (
    BoardGraph,
    Finding,
    Hole,
    Net,
    NetConnection,
    PadShape,
    PhysicalPad,
    PointNm,
    RuleExecutionOutcome,
    Track,
    VerificationEngine,
    VerificationInputError,
    VerificationReport,
)
from tests.verification.fixtures import MM, safe_board


def _pad(
    pad_id: str,
    component_id: str,
    net_id: str | None,
    center: PointNm,
    size_x_nm: int,
    size_y_nm: int,
    shape: PadShape,
    *,
    rotation_udeg: int = 0,
    drill_nm: int = 0,
    drill_x_nm: int = 0,
    drill_y_nm: int = 0,
    drill_rotation_udeg: int = 0,
    shared_land_group_id: str | None = None,
) -> PhysicalPad:
    return PhysicalPad(
        pad_id=pad_id,
        component_id=component_id,
        pad_number="1",
        net_id=net_id,
        center=center,
        size_x_nm=size_x_nm,
        size_y_nm=size_y_nm,
        shape=shape,
        rotation_udeg=rotation_udeg,
        layers=("F.Cu", "B.Cu") if drill_nm or drill_x_nm else ("F.Cu",),
        drill_nm=drill_nm,
        drill_x_nm=drill_x_nm,
        drill_y_nm=drill_y_nm,
        drill_rotation_udeg=drill_rotation_udeg,
        shared_land_group_id=shared_land_group_id,
    )


def _two_net_board(first: PhysicalPad, second: PhysicalPad) -> BoardGraph:
    base = safe_board()
    return replace(
        base,
        nets=(
            Net("net-a", "A", (NetConnection("cmp-driver", "1"),)),
            Net("net-b", "B", (NetConnection("cmp-sink", "1"),)),
        ),
        tracks=(),
        pads=(first, second),
    )


def _findings(report: VerificationReport, rule_id: str) -> tuple[Finding, ...]:
    return tuple(finding for finding in report.findings if finding.rule_id == rule_id)


class RealisticPadGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = VerificationEngine()

    def test_long_rect_clearance_and_edge_do_not_collapse_to_minor_circle(self) -> None:
        long_rect = _pad(
            "pad-long",
            "cmp-driver",
            "net-a",
            PointNm(4 * MM, 5 * MM),
            1_200_000,
            600_000,
            PadShape.RECT,
        )
        circle = _pad(
            "pad-circle",
            "cmp-sink",
            "net-b",
            PointNm(4_900_000, 5 * MM),
            400_000,
            400_000,
            PadShape.CIRCLE,
        )
        clearance = self.engine.verify(_two_net_board(long_rect, circle))
        violations = _findings(clearance, "GEO.COPPER.MIN_CLEARANCE")
        self.assertTrue(
            any(
                {entity.entity_id for entity in finding.entities} == {"pad-long", "pad-circle"}
                for finding in violations
            )
        )

        near_edge = replace(long_rect, center=PointNm(800_000, 5 * MM))
        far_circle = replace(circle, center=PointNm(8 * MM, 5 * MM))
        edge = self.engine.verify(_two_net_board(near_edge, far_circle))
        self.assertTrue(
            any(
                "pad-long" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(edge, "GEO.COPPER.BOARD_EDGE_CLEARANCE")
            )
        )

    def test_quadrant_rotated_oval_and_rect_connect_exactly(self) -> None:
        base = safe_board()
        oval = _pad(
            "pad-oval",
            "cmp-driver",
            "net-signal",
            PointNm(4 * MM, 5 * MM),
            600_000,
            1_200_000,
            PadShape.OVAL,
            rotation_udeg=90_000_000,
        )
        rectangle = _pad(
            "pad-rect",
            "cmp-sink",
            "net-signal",
            PointNm(8 * MM, 5 * MM),
            600_000,
            1_200_000,
            PadShape.RECT,
            rotation_udeg=270_000_000,
        )
        board = replace(
            base,
            pads=(oval, rectangle),
            tracks=(
                Track(
                    "track-exact",
                    "net-signal",
                    "F.Cu",
                    PointNm(4_550_000, 5 * MM),
                    PointNm(7_450_000, 5 * MM),
                    100_000,
                ),
            ),
        )
        report = self.engine.verify(board)
        self.assertFalse(_findings(report, "ALG.ROUTING.CONNECTIVITY"))
        self.assertIs(
            next(
                execution
                for execution in report.executions
                if execution.rule_id == "ALG.ROUTING.CONNECTIVITY"
            ).outcome,
            RuleExecutionOutcome.PASS,
        )

    def test_unnetted_usb_contact_remains_clearance_and_edge_obstacle(self) -> None:
        no_connect = _pad(
            "pad-nc",
            "cmp-driver",
            None,
            PointNm(800_000, 5 * MM),
            1_200_000,
            600_000,
            PadShape.RECT,
        )
        vbus = _pad(
            "pad-vbus",
            "cmp-sink",
            "net-b",
            PointNm(1_650_000, 5 * MM),
            400_000,
            400_000,
            PadShape.CIRCLE,
        )
        report = self.engine.verify(_two_net_board(no_connect, vbus))
        self.assertTrue(
            any(
                "pad-nc" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.MIN_CLEARANCE")
            )
        )
        self.assertTrue(
            any(
                "pad-nc" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.BOARD_EDGE_CLEARANCE")
            )
        )

    def test_multiple_physical_shell_pads_can_share_one_logical_pad_number(self) -> None:
        base = safe_board()
        first = _pad(
            "stake-1",
            "cmp-driver",
            "net-signal",
            PointNm(4 * MM, 4 * MM),
            1_100_000,
            1_700_000,
            PadShape.OVAL,
            drill_nm=700_000,
        )
        second = replace(first, pad_id="stake-2", center=PointNm(4 * MM, 7 * MM))
        report = self.engine.verify(replace(base, pads=(first, second), tracks=()))
        topology = _findings(report, "ALG.ROUTING.TOPOLOGY")
        self.assertFalse(any("duplicate_pad_id" in str(finding.evidence) for finding in topology))

    def test_npth_blocks_copper_and_board_edge_without_a_net(self) -> None:
        base = safe_board()
        close_to_track = Hole(
            "hole-near-copper",
            "cmp-driver",
            PointNm(4 * MM, 5_700_000),
            500_000,
        )
        close_to_edge = Hole(
            "hole-near-edge",
            "cmp-driver",
            PointNm(400_000, 3 * MM),
            400_000,
        )
        report = self.engine.verify(replace(base, holes=(close_to_track, close_to_edge)))
        self.assertTrue(
            any(
                "hole-near-copper" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.MIN_CLEARANCE")
            )
        )
        self.assertTrue(
            any(
                "hole-near-edge" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.BOARD_EDGE_CLEARANCE")
            )
        )

    def test_quadrant_slotted_npth_uses_exact_capsule_clearance_and_edge(self) -> None:
        base = safe_board()
        near_copper = Hole(
            hole_id="slot-near-copper",
            component_id="cmp-driver",
            center=PointNm(3_300_000, 5 * MM),
            diameter_nm=1_100_000,
            drill_x_nm=1_100_000,
            drill_y_nm=1_700_000,
            drill_rotation_udeg=0,
        )
        near_edge = replace(
            near_copper,
            hole_id="slot-near-edge",
            center=PointNm(1 * MM, 3 * MM),
            drill_rotation_udeg=90_000_000,
        )
        report = self.engine.verify(replace(base, holes=(near_copper, near_edge)))
        self.assertTrue(
            any(
                "slot-near-copper" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.MIN_CLEARANCE")
            )
        )
        self.assertTrue(
            any(
                "slot-near-edge" in {entity.entity_id for entity in finding.entities}
                for finding in _findings(report, "GEO.COPPER.BOARD_EDGE_CLEARANCE")
            )
        )
        self.assertFalse(
            any(
                execution.outcome is RuleExecutionOutcome.NOT_RUN for execution in report.executions
            )
        )

    def test_exact_shared_land_deduplicates_and_mismatch_blocks(self) -> None:
        base = safe_board()
        driver = base.components[0]
        pin_two = replace(driver.pins[0], number="2", name="IO2", pad_number="2")
        driver = replace(driver, pins=(driver.pins[0], pin_two))
        signal = replace(
            base.nets[0],
            connections=base.nets[0].connections
            + (NetConnection("cmp-driver", "2"),),
        )
        base = replace(base, components=(driver, base.components[1]), nets=(signal,))
        first = _pad(
            "shared-a",
            "cmp-driver",
            "net-signal",
            PointNm(4 * MM, 5 * MM),
            600_000,
            1_200_000,
            PadShape.OVAL,
            shared_land_group_id="usb-shared-land",
        )
        second = replace(first, pad_id="shared-b", pad_number="2")
        exact = self.engine.verify(replace(base, pads=(first, second)))
        self.assertFalse(any("Shared land group" in finding.message for finding in exact.findings))
        connectivity = next(
            execution
            for execution in exact.executions
            if execution.rule_id == "ALG.ROUTING.CONNECTIVITY"
        )
        self.assertIs(connectivity.outcome, RuleExecutionOutcome.PASS)
        self.assertNotIn("shared-land-group-mismatch:usb-shared-land", connectivity.blocker_ids)

        shifted = replace(second, center=PointNm(4_000_001, 5 * MM))
        blocked = self.engine.verify(replace(base, pads=(first, shifted)))
        self.assertTrue(any("Shared land group" in finding.message for finding in blocked.findings))
        shape_executions = (
            execution
            for execution in blocked.executions
            if execution.rule_id == "GEO.COPPER.MIN_CLEARANCE"
        )
        execution = next(shape_executions)
        self.assertIs(execution.outcome, RuleExecutionOutcome.NOT_RUN)
        self.assertIn("shared-land-group-mismatch:usb-shared-land", execution.blocker_ids)

    def test_nonquadrant_and_unbound_roundrect_are_named_not_run_blockers(self) -> None:
        base = safe_board()
        angled = _pad(
            "pad-angled",
            "cmp-driver",
            "net-signal",
            PointNm(4 * MM, 5 * MM),
            1_200_000,
            600_000,
            PadShape.RECT,
            rotation_udeg=45_000_000,
        )
        roundrect = replace(
            angled,
            pad_id="pad-roundrect",
            rotation_udeg=0,
            shape=PadShape.ROUNDRECT,
        )
        angled_slot = Hole(
            hole_id="stake-slot-1",
            component_id="cmp-driver",
            center=PointNm(2 * MM, 2 * MM),
            diameter_nm=1_100_000,
            drill_x_nm=1_100_000,
            drill_y_nm=1_700_000,
            drill_rotation_udeg=45_000_000,
        )
        board = replace(
            base,
            pads=(angled, roundrect),
            holes=(angled_slot,),
        )
        report = self.engine.verify(board)
        expected = {
            "exact-pad-rotation-not-supported:pad-angled:45000000",
            "exact-pad-roundrect-radius-not-represented:pad-roundrect",
            "exact-drill-rotation-not-supported:hole:stake-slot-1:45000000",
        }
        executions = {
            execution.rule_id: execution
            for execution in report.executions
            if execution.rule_id
            in {
                "ALG.ROUTING.CONNECTIVITY",
                "ALG.VIA.NET_CONNECTIVITY",
                "GEO.COPPER.MIN_CLEARANCE",
                "GEO.COPPER.BOARD_EDGE_CLEARANCE",
            }
        }
        self.assertTrue(executions)
        self.assertTrue(
            all(
                execution.outcome is RuleExecutionOutcome.NOT_RUN
                for execution in executions.values()
            )
        )
        self.assertTrue(
            all(set(execution.blocker_ids) == expected for execution in executions.values())
        )
        self.assertFalse(next(gate for gate in report.gates if gate.gate_id == "commit").passed)

    def test_duplicate_ids_bool_aliases_and_subclasses_fail_closed(self) -> None:
        first = _pad(
            "pad-duplicate",
            "cmp-driver",
            "net-a",
            PointNm(4 * MM, 5 * MM),
            600_000,
            600_000,
            PadShape.CIRCLE,
        )
        second = replace(first, component_id="cmp-sink", net_id="net-b")
        board = _two_net_board(first, second)
        duplicate_hole = Hole("hole-duplicate", "cmp-driver", PointNm(2 * MM, 2 * MM), 300_000)
        report = self.engine.verify(replace(board, holes=(duplicate_hole, duplicate_hole)))
        topology = _findings(report, "ALG.ROUTING.TOPOLOGY")
        self.assertTrue(any("duplicate_pad_id" in str(item.evidence) for item in topology))
        self.assertTrue(any("duplicate_hole_id" in str(item.evidence) for item in topology))

        with self.assertRaises(VerificationInputError):
            self.engine.verify(replace(board, pads=(replace(first, rotation_udeg=True),)))  # type: ignore[arg-type]

        class ForgedPad(PhysicalPad):
            pass

        forged = ForgedPad(
            first.pad_id,
            first.component_id,
            first.pad_number,
            first.net_id,
            first.center,
            first.size_x_nm,
            first.size_y_nm,
            first.shape,
            first.rotation_udeg,
            first.layers,
            first.drill_nm,
        )
        with self.assertRaises(VerificationInputError):
            self.engine.verify(replace(board, pads=(forged,)))


if __name__ == "__main__":
    unittest.main()
