"""Focused contracts for the reviewed reference-board route plan."""

from __future__ import annotations

import unittest
from dataclasses import replace
from math import sqrt
from time import perf_counter

from backend.design_kernel import (
    FootprintPad,
    PointNm,
    Track,
    Via,
    revision_to_verification_board,
    stable_hash,
)
from backend.reference_design import build_reference_board
from backend.reference_design.layout import (
    ROUTE_DEFAULT_WIDTHS_NM,
    ROUTE_NET_ORDER,
    build_layout,
    search_candidate_layout,
)
from backend.reference_design.model import ReferenceDesignViolation
from backend.reference_design.router import (
    FROZEN_ROUTE_AUTHORITY,
    FROZEN_ROUTE_INPUT_HASH,
    FROZEN_ROUTE_MANHATTAN_LENGTH_NM,
    FROZEN_ROUTE_PLAN_HASH,
    FROZEN_ROUTE_REVIEW_CONTRACT,
    FROZEN_ROUTE_REVIEW_HASH,
    FROZEN_ROUTE_TRACK_COUNT,
    FROZEN_ROUTE_TREE_COUNT,
    FROZEN_ROUTE_TURN_COUNT,
    FROZEN_ROUTE_VIA_COUNT,
    ROUTE_INPUT_SCHEMA,
    RouteSearchBudget,
    frozen_route_plan,
    route_all,
)
from backend.reference_design.specification import BOARD_HEIGHT_NM, BOARD_WIDTH_NM
from backend.verification import (
    ParameterValue,
    RuleOverride,
    VerificationEngine,
    VerificationPolicy,
    strict_policy,
)


class ReviewedRoutePlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.build = build_reference_board()
        cls.graph = cls.build.graph

    def test_content_addressed_plan_replays_quickly_and_exactly(self) -> None:
        started = perf_counter()
        tracks, vias, zones = build_layout()
        elapsed = perf_counter() - started
        self.assertLess(elapsed, 0.5)
        self.assertEqual((125, 14, 1), (len(tracks), len(vias), len(zones)))
        self.assertEqual(
            FROZEN_ROUTE_PLAN_HASH,
            stable_hash(
                {"tracks": tracks, "vias": vias},
                domain="flux-clone-reference-route-plan-v1",
            ),
        )
        self.assertEqual(
            "reviewed-r2-route-a-output-network-v3",
            FROZEN_ROUTE_AUTHORITY,
        )
        self.assertEqual(
            "reviewed-multi-agent-content-addressed-route-v1",
            ROUTE_INPUT_SCHEMA,
        )
        self.assertEqual(
            "1a33c590fb5bb85301119f358c73e5074aad577fcb431ca9246251c7f478c911",
            FROZEN_ROUTE_INPUT_HASH,
        )
        self.assertEqual(
            "5352788cdbe7ca5cb11e059cefbc4807ebb537fea483d24f0c2776a42117f203",
            FROZEN_ROUTE_PLAN_HASH,
        )
        self.assertEqual(
            "0f7c189617f4855fdf6343767c07fd9616c9d5811d1b7b5da31223ac83335948",
            FROZEN_ROUTE_REVIEW_HASH,
        )
        self.assertEqual(
            (125, 14, 13, 381_190_000, 87),
            (
                FROZEN_ROUTE_TRACK_COUNT,
                FROZEN_ROUTE_VIA_COUNT,
                FROZEN_ROUTE_TREE_COUNT,
                FROZEN_ROUTE_MANHATTAN_LENGTH_NM,
                FROZEN_ROUTE_TURN_COUNT,
            ),
        )
        self.assertIn(
            "exact-0.20mm-route-clearance-with-source-bound-usb-pad-npth-local-exceptions",
            FROZEN_ROUTE_REVIEW_CONTRACT,
        )
        self.assertIn(
            "route-a-ldo-output-network-native-kicad-10.0.6-zero-findings",
            FROZEN_ROUTE_REVIEW_CONTRACT,
        )
        self.assertEqual(ROUTE_NET_ORDER, tuple(item[0] for item in ROUTE_DEFAULT_WIDTHS_NM))
        self.assertEqual(13, len(ROUTE_NET_ORDER))
        with self.assertRaisesRegex(ReferenceDesignViolation, "author, diff, and reapprove"):
            frozen_route_plan("0" * 64)

    def test_candidate_search_is_not_misrepresented_as_frozen_replay(self) -> None:
        documentation = search_candidate_layout.__doc__ or ""
        self.assertIn("does not reproduce the authored plan", documentation)

    def test_u2_tab_uses_two_external_stitches_to_ground_spine(self) -> None:
        expected_centers = {
            PointNm(27_200_000, 14_100_000),
            PointNm(28_800_000, 14_100_000),
        }
        stitch_vias = tuple(
            via
            for via in self.graph.vias
            if via.via_id
            in {
                "minimal-via:10:gnd-u2-left",
                "minimal-via:11:gnd-u2-right",
            }
        )
        self.assertEqual(expected_centers, {via.center for via in stitch_vias})
        self.assertTrue(
            all(
                via.net_id == "net-gnd"
                and via.diameter_nm == 700_000
                and via.drill_nm == 300_000
                and set(via.layers) == {"F.Cu", "B.Cu"}
                for via in stitch_vias
            )
        )
        tab_pad = next(
            pad for pad in self.graph.pads if pad.component_id == "ldo-u2" and pad.pad_number == "5"
        )
        self.assertTrue(
            all(
                max(2 * abs(point.x - tab_pad.center.x) - tab_pad.size_x_nm, 0) ** 2
                + max(2 * abs(point.y - tab_pad.center.y) - tab_pad.size_y_nm, 0) ** 2
                > 700_000**2
                for point in expected_centers
            )
        )
        tracks = {track.track_id: track for track in self.graph.tracks}
        for side, center in zip(("left", "right"), sorted(expected_centers), strict=True):
            front = tracks[f"minimal:11{3 if side == 'left' else 4}:gnd-u2-{side}"]
            back = tracks[f"minimal:0{79 if side == 'left' else 80}:gnd-u2-{side}-spine"]
            self.assertEqual(("F.Cu", 800_000, center), (front.layer, front.width_nm, front.end))
            self.assertEqual(("B.Cu", 800_000, center), (back.layer, back.width_nm, back.start))
            self.assertEqual(25_000_000, back.end.y)

    def test_vias_do_not_overlap_each_other_or_any_smd_land(self) -> None:
        smd_pads = tuple(
            pad for pad in self.graph.pads if pad.drill_x_nm == 0 and pad.drill_y_nm == 0
        )
        for via in self.graph.vias:
            for pad in smd_pads:
                size_x, size_y = (
                    (pad.size_y_nm, pad.size_x_nm)
                    if pad.rotation_udeg % 180_000_000
                    else (pad.size_x_nm, pad.size_y_nm)
                )
                # Twice the exact point-to-rectangle distance is compared to
                # the via diameter, avoiding floating point and proving the
                # complete via land (not only its center) stays outside.
                dx2 = max(2 * abs(via.center.x - pad.center.x) - size_x, 0)
                dy2 = max(2 * abs(via.center.y - pad.center.y) - size_y, 0)
                self.assertGreater(
                    dx2 * dx2 + dy2 * dy2,
                    via.diameter_nm * via.diameter_nm,
                    (via.via_id, pad.pad_id),
                )
        for index, first in enumerate(self.graph.vias):
            for second in self.graph.vias[index + 1 :]:
                distance_squared = (first.center.x - second.center.x) ** 2 + (
                    first.center.y - second.center.y
                ) ** 2
                self.assertGreater(
                    4 * distance_squared,
                    (first.diameter_nm + second.diameter_nm) ** 2,
                    (first.via_id, second.via_id),
                )

    def test_ground_return_spine_and_unfilled_plane_intent_are_truthful(self) -> None:
        tracks = {track.track_id: track for track in self.graph.tracks}
        expected = {
            "minimal:068:gnd-spine:0": ("B.Cu", 800_000, 14_320_000),
            "minimal:069:gnd-spine:1": ("B.Cu", 800_000, 44_400_000),
            "minimal:070:gnd-spine:2": ("B.Cu", 800_000, 8_730_000),
            "minimal:071:gnd-shell-low": ("F.Cu", 800_000, 4_180_000),
            "minimal:092:gnd-tvs:0": ("F.Cu", 400_000, 1_850_000),
            "minimal:093:gnd-tvs:1": ("F.Cu", 400_000, 275_000),
        }
        for track_id, (layer, width, length) in expected.items():
            item = tracks[track_id]
            self.assertEqual((layer, width), (item.layer, item.width_nm))
            self.assertEqual(
                length,
                abs(item.start.x - item.end.x) + abs(item.start.y - item.end.y),
            )
        self.assertEqual(
            PointNm(47_000_000, 25_000_000),
            tracks["minimal:069:gnd-spine:1"].end,
        )
        self.assertEqual(1, len(self.graph.zones))
        zone = self.graph.zones[0]
        self.assertEqual("zone-intent:gnd:bcu-full-board", zone.zone_id)
        self.assertEqual("unfilled-intent", zone.fill_state.value)
        self.assertIsNone(zone.fill_evidence)
        warnings = tuple(
            finding
            for finding in self.build.native_report.findings
            if finding.rule_id == "GEO.ZONE.FILL_UNVERIFIED"
        )
        self.assertEqual(1, len(warnings))
        self.assertEqual("warning", warnings[0].severity.value)

    def test_routed_copper_has_no_redundant_overlap_finding(self) -> None:
        self.assertFalse(
            any(
                finding.rule_id == "ALG.ROUTING.REDUNDANT_COPPER"
                for finding in self.build.native_report.findings
            )
        )

    def test_authored_copper_meets_020_except_exact_usb_source_geometry(self) -> None:
        policy = VerificationPolicy(
            overrides=(
                RuleOverride(
                    "GEO.COPPER.MIN_CLEARANCE",
                    parameters=(ParameterValue("minimum_clearance_nm", 200_000),),
                ),
            ),
            gates=strict_policy().gates,
        )
        board = revision_to_verification_board(self.build.revision)
        board = replace(
            board,
            nets=tuple(
                replace(net, external_source=net.net_id == "net-en-uvlo") for net in board.nets
            ),
        ).normalized()
        report = VerificationEngine().verify(board, policy)
        findings = tuple(
            finding for finding in report.findings if finding.rule_id == "GEO.COPPER.MIN_CLEARANCE"
        )
        self.assertEqual(
            {
                "Copper clearance violation between pad:pad:usb-j1:A1:0 "
                "and NPTH hole:usb-j1:locating:0",
                "Copper clearance violation between pad:pad:usb-j1:A12:0 "
                "and NPTH hole:usb-j1:locating:1",
            },
            {finding.message for finding in findings},
        )
        self.assertTrue(
            all(
                {entity.kind for entity in finding.entities} == {"pad", "hole"}
                for finding in findings
            )
        )
        for finding in findings:
            evidence = {item.name: item.value for item in finding.evidence}
            self.assertEqual(250_100_000_000, evidence["core_distance_squared_numerator"])
            self.assertEqual(1, evidence["core_distance_squared_denominator"])
            exact_boundary_clearance = sqrt(250_100_000_000) - 325_000
            self.assertGreater(exact_boundary_clearance, 175_000)
            self.assertLess(exact_boundary_clearance, 176_000)

        pads = {pad.pad_id: pad for pad in self.graph.pads}
        vias = {via.via_id: via for via in self.graph.vias}
        tracks = {track.track_id: track for track in self.graph.tracks}
        usb_ground = pads["pad:usb-j1:A12:0"]
        high_via = vias["minimal-via:05:vbus-usb-high"]
        size_x_nm, size_y_nm = usb_ground.size_y_nm, usb_ground.size_x_nm
        dx2_nm = max(2 * abs(high_via.center.x - usb_ground.center.x) - size_x_nm, 0)
        dy2_nm = max(2 * abs(high_via.center.y - usb_ground.center.y) - size_y_nm, 0)
        self.assertGreater(
            dx2_nm * dx2_nm + dy2_nm * dy2_nm,
            (high_via.diameter_nm + 400_000) ** 2,
        )
        spine = tracks["minimal:045:vbus-spine"]
        ground_via = vias["minimal-via:09:gnd-r1"]
        self.assertEqual(
            250_000,
            abs(ground_via.center.x - spine.start.x)
            - spine.width_nm // 2
            - ground_via.diameter_nm // 2,
        )


class BoundedCandidateRouterTests(unittest.TestCase):
    _START = PointNm(525_000, 525_000)
    _GOAL = PointNm(1_025_000, 525_000)

    @classmethod
    def _route(cls, budget: RouteSearchBudget) -> tuple[tuple[Track, ...], tuple[Via, ...]]:
        return route_all(
            {"net-test": (cls._START, cls._GOAL)},
            (),
            (),
            {"net-test": 250_000},
            ("net-test",),
            budget=budget,
        )

    def test_expansion_budget_is_exact_and_fails_one_below(self) -> None:
        exact = RouteSearchBudget(
            max_expansions_per_pair=2,
            max_total_expansions=2,
            max_pair_runtime_ms=1_000,
            max_total_runtime_ms=1_000,
        )
        tracks, vias = self._route(exact)
        self.assertEqual((1, 0), (len(tracks), len(vias)))
        below = replace(exact, max_expansions_per_pair=1, max_total_expansions=1)
        with self.assertRaisesRegex(ReferenceDesignViolation, "expansion budget exceeded"):
            self._route(below)

    def test_visibility_state_budget_is_exact_and_fails_one_below(self) -> None:
        margin = 200_000 + 125_000
        xs = set(range(200_000 + margin, BOARD_WIDTH_NM - 200_000 - margin + 1, 500_000))
        ys = set(range(200_000 + margin, BOARD_HEIGHT_NM - 200_000 - margin + 1, 500_000))
        xs.update((self._START.x, self._GOAL.x))
        ys.update((self._START.y, self._GOAL.y))
        state_count = 2 * len(xs) * len(ys)
        exact = RouteSearchBudget(
            max_visibility_states=state_count,
            max_expansions_per_pair=2,
            max_total_expansions=2,
            max_pair_runtime_ms=1_000,
            max_total_runtime_ms=1_000,
        )
        self._route(exact)
        with self.assertRaisesRegex(ReferenceDesignViolation, "visibility-state budget exceeded"):
            self._route(replace(exact, max_visibility_states=state_count - 1))

    def test_no_path_fails_closed_with_subject_coordinates(self) -> None:
        wall = FootprintPad(
            "pad:blocker:1",
            "blocker",
            "1",
            PointNm(25_000_000, 15_000_000),
            1_000_000,
            29_000_000,
            "rect",
            0,
            ("F.Cu", "B.Cu"),
            net_id="net-blocker",
        )
        with self.assertRaisesRegex(ReferenceDesignViolation, "found no path for net-test"):
            route_all(
                {"net-test": (PointNm(5_000_000, 15_000_000), PointNm(45_000_000, 15_000_000))},
                (wall,),
                (),
                {"net-test": 250_000},
                ("net-test",),
            )

    def test_budget_values_reject_bool_zero_and_negative_aliases(self) -> None:
        for value in (True, 0, -1):
            with self.assertRaises(ReferenceDesignViolation):
                RouteSearchBudget(max_visibility_states=value)


if __name__ == "__main__":
    unittest.main()
