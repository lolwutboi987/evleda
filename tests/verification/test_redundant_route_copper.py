from __future__ import annotations

import unittest
from dataclasses import replace

from backend.verification import (
    BoardGraph,
    Finding,
    Net,
    PointNm,
    Track,
    VerificationEngine,
    Via,
    default_evaluators,
)
from tests.verification.fixtures import MM, safe_board

RULE_ID = "ALG.ROUTING.REDUNDANT_COPPER"


def _findings(board: BoardGraph) -> tuple[Finding, ...]:
    report = VerificationEngine().verify(board)
    return tuple(item for item in report.findings if item.rule_id == RULE_ID)


class RedundantRouteCopperTests(unittest.TestCase):
    def test_safe_reference_fixture_has_no_redundant_route_copper(self) -> None:
        self.assertEqual((), _findings(safe_board()))

    def test_identical_reversed_track_is_rejected_with_canonical_interval(self) -> None:
        board = safe_board()
        original = board.tracks[0]
        duplicate = replace(
            original,
            track_id="track-duplicate",
            start=original.end,
            end=original.start,
        )
        findings = _findings(replace(board, tracks=(duplicate, original)))
        self.assertEqual(
            findings,
            _findings(replace(board, tracks=(original, duplicate))),
        )
        self.assertEqual(1, len(findings))
        finding = findings[0]
        evidence = {item.name: item.value for item in finding.evidence}
        self.assertEqual(("track-duplicate", "track-signal"), evidence["entity_ids"])
        self.assertEqual("identical", evidence["overlap_kind"])
        self.assertEqual(4 * MM, evidence["overlap_start_x_nm"])
        self.assertEqual(8 * MM, evidence["overlap_end_x_nm"])
        self.assertFalse(
            next(
                g
                for g in VerificationEngine()
                .verify(replace(board, tracks=(duplicate, original)))
                .gates
                if g.gate_id == "commit"
            ).passed
        )

    def test_contained_and_partial_diagonal_overlaps_use_exact_integer_endpoints(self) -> None:
        board = safe_board()
        base = Track(
            "track-base",
            "net-signal",
            "F.Cu",
            PointNm(1 * MM, 5 * MM),
            PointNm(7 * MM, -1 * MM),
            200_000,
        )
        contained = replace(
            base,
            track_id="track-contained",
            start=PointNm(2 * MM, 4 * MM),
            end=PointNm(4 * MM, 2 * MM),
        )
        partial = replace(
            base,
            track_id="track-partial",
            start=PointNm(5 * MM, 1 * MM),
            end=PointNm(9 * MM, -3 * MM),
        )
        findings = _findings(replace(board, tracks=(base, contained, partial)))
        by_kind = {
            {item.name: item.value for item in finding.evidence}["overlap_kind"]: finding
            for finding in findings
        }
        self.assertEqual({"contained", "partial"}, set(by_kind))
        partial_evidence = {item.name: item.value for item in by_kind["partial"].evidence}
        self.assertEqual(5 * MM, partial_evidence["overlap_start_x_nm"])
        self.assertEqual(1 * MM, partial_evidence["overlap_start_y_nm"])
        self.assertEqual(7 * MM, partial_evidence["overlap_end_x_nm"])
        self.assertEqual(-1 * MM, partial_evidence["overlap_end_y_nm"])

    def test_endpoint_only_and_noncollinear_crossings_are_not_redundant(self) -> None:
        board = safe_board()
        first = Track(
            "track-a",
            "net-signal",
            "F.Cu",
            PointNm(2 * MM, 2 * MM),
            PointNm(4 * MM, 2 * MM),
            200_000,
        )
        endpoint = replace(
            first,
            track_id="track-b",
            start=first.end,
            end=PointNm(6 * MM, 2 * MM),
        )
        crossing = replace(
            first,
            track_id="track-c",
            start=PointNm(3 * MM, 1 * MM),
            end=PointNm(3 * MM, 3 * MM),
        )
        self.assertEqual((), _findings(replace(board, tracks=(first, endpoint, crossing))))

    def test_one_nm_positive_overlap_is_rejected_but_equality_is_allowed(self) -> None:
        board = safe_board()
        first = Track(
            "track-a",
            "net-signal",
            "F.Cu",
            PointNm(1 * MM, 1 * MM),
            PointNm(3 * MM, 1 * MM),
            200_000,
        )
        equality = replace(
            first,
            track_id="track-b",
            start=PointNm(3 * MM, 1 * MM),
            end=PointNm(5 * MM, 1 * MM),
        )
        one_nm = replace(
            equality,
            start=PointNm(3 * MM - 1, 1 * MM),
        )
        self.assertEqual((), _findings(replace(board, tracks=(first, equality))))
        findings = _findings(replace(board, tracks=(first, one_nm)))
        self.assertEqual(1, len(findings))
        evidence = {item.name: item.value for item in findings[0].evidence}
        self.assertEqual(3 * MM - 1, evidence["overlap_start_x_nm"])
        self.assertEqual(3 * MM, evidence["overlap_end_x_nm"])

    def test_different_net_or_layer_overlap_stays_outside_this_rule(self) -> None:
        board = safe_board()
        first = board.tracks[0]
        other_net = replace(first, track_id="track-other-net", net_id="net-other")
        other_layer = replace(first, track_id="track-other-layer", layer="B.Cu")
        candidate = replace(
            board,
            nets=board.nets + (Net("net-other", "OTHER", ()),),
            tracks=(first, other_net, other_layer),
        )
        report = VerificationEngine().verify(candidate)
        self.assertFalse(any(item.rule_id == RULE_ID for item in report.findings))
        self.assertTrue(any(item.rule_id == "GEO.COPPER.MIN_CLEARANCE" for item in report.findings))

    def test_duplicate_vias_require_same_net_center_and_exact_layer_span(self) -> None:
        board = safe_board()
        first = Via(
            "via-a",
            "net-signal",
            PointNm(6 * MM, 5 * MM),
            600_000,
            300_000,
            ("F.Cu", "B.Cu"),
        )
        duplicate = replace(
            first,
            via_id="via-b",
            diameter_nm=700_000,
            drill_nm=350_000,
            layers=("B.Cu", "F.Cu"),
        )
        findings = _findings(replace(board, vias=(duplicate, first)))
        self.assertEqual(1, len(findings))
        evidence = {item.name: item.value for item in findings[0].evidence}
        self.assertEqual(("via-a", "via-b"), evidence["entity_ids"])
        self.assertEqual(("B.Cu", "F.Cu"), evidence["layers"])

        different_span = replace(duplicate, layers=("F.Cu",))
        different_net = replace(duplicate, net_id="other-net")
        self.assertEqual((), _findings(replace(board, vias=(first, different_span))))
        self.assertEqual((), _findings(replace(board, vias=(first, different_net))))

    def test_rule_set_hash_changes_when_new_rule_is_removed(self) -> None:
        native = VerificationEngine().verify(safe_board())
        without_rule = VerificationEngine(
            evaluators=tuple(
                item for item in default_evaluators() if item.definition.rule_id != RULE_ID
            )
        ).verify(safe_board())
        self.assertNotEqual(native.rule_set_hash, without_rule.rule_set_hash)


if __name__ == "__main__":
    unittest.main()
