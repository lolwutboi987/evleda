from __future__ import annotations

from fractions import Fraction
import unittest

from backend.verification import VerificationEngine
from backend.verification.geometry import ExactGeometryKernel
from backend.verification.model import PointNm

from tests.verification.fixtures import clearance_board


class ExactGeometryTests(unittest.TestCase):
    def test_fractional_projection_distance_is_exact(self) -> None:
        kernel = ExactGeometryKernel()
        distance = kernel.point_segment_distance_squared(
            PointNm(1, 1), PointNm(0, 0), PointNm(2, 1)
        )
        self.assertEqual(Fraction(1, 5), distance)

    def test_crossing_segments_have_zero_distance(self) -> None:
        kernel = ExactGeometryKernel()
        distance = kernel.segment_distance_squared(
            PointNm(0, 0), PointNm(10, 10), PointNm(0, 10), PointNm(10, 0)
        )
        self.assertEqual(Fraction(0), distance)

    def test_clearance_equality_passes_and_one_nm_below_fails(self) -> None:
        engine = VerificationEngine()
        at_limit = engine.verify(clearance_board(350_000))
        below_limit = engine.verify(clearance_board(349_999))
        self.assertFalse(
            any(item.rule_id == "GEO.COPPER.MIN_CLEARANCE" for item in at_limit.findings)
        )
        violations = [
            item
            for item in below_limit.findings
            if item.rule_id == "GEO.COPPER.MIN_CLEARANCE"
        ]
        self.assertEqual(1, len(violations))
        evidence = {item.name: item.value for item in violations[0].evidence}
        self.assertEqual(349_999**2, evidence["center_distance_squared_numerator"])
        self.assertEqual(1, evidence["center_distance_squared_denominator"])


if __name__ == "__main__":
    unittest.main()

