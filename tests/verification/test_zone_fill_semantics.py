from __future__ import annotations

import unittest
from dataclasses import replace

from backend.verification import (
    BoardGraph,
    BoardOutline,
    Net,
    PointNm,
    RuleConfigurationError,
    RuleOverride,
    Severity,
    VerificationEngine,
    VerificationInputError,
    Zone,
    ZoneFillEvidence,
    ZoneFillState,
    strict_policy,
    zone_fill_evidence_hash,
    zone_filled_geometry_hash,
)
from tests.verification.fixtures import safe_board

MM = 1_000_000


def _intent_board() -> BoardGraph:
    base = safe_board()
    components = tuple(
        replace(
            component,
            pins=tuple(replace(pin, layers=("B.Cu",)) for pin in component.pins),
        )
        for component in base.components
    )
    return replace(
        base,
        design_id="zone-intent-board",
        revision="c" * 64,
        components=components,
        nets=base.nets + (Net("net-gnd", "GND", (), external_source=True),),
        tracks=(replace(base.tracks[0], layer="B.Cu"),),
        zones=(
            Zone(
                "zone-gnd",
                "net-gnd",
                "B.Cu",
                BoardOutline(
                    (
                        PointNm(1 * MM, 1 * MM),
                        PointNm(11 * MM, 1 * MM),
                        PointNm(11 * MM, 9 * MM),
                        PointNm(1 * MM, 9 * MM),
                    )
                ),
                200_000,
            ),
        ),
    )


def _verified(zone: Zone) -> Zone:
    provisional = ZoneFillEvidence(
        source_graph_hash="d" * 64,
        source_revision="e" * 64,
        fill_engine_id="kicad-zone-fill",
        fill_engine_revision="10.0.0",
        filled_geometry_hash=zone_filled_geometry_hash(zone),
        evidence_hash="0" * 64,
    )
    evidence = replace(provisional, evidence_hash=zone_fill_evidence_hash(provisional))
    return replace(
        zone,
        fill_state=ZoneFillState.VERIFIED_FILLED,
        fill_evidence=evidence,
    )


class ZoneFillSemanticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = VerificationEngine()

    def test_full_board_intent_warns_without_becoming_false_copper(self) -> None:
        report = self.engine.verify(_intent_board())

        warnings = [
            finding
            for finding in report.findings
            if finding.rule_id == "GEO.ZONE.FILL_UNVERIFIED"
        ]
        self.assertEqual(1, len(warnings))
        self.assertFalse(
            any(finding.rule_id == "GEO.COPPER.MIN_CLEARANCE" for finding in report.findings)
        )
        self.assertTrue(next(gate for gate in report.gates if gate.gate_id == "preview").passed)
        self.assertTrue(next(gate for gate in report.gates if gate.gate_id == "commit").passed)
        manufacturing = next(
            gate for gate in report.gates if gate.gate_id == "manufacturing-release"
        )
        self.assertFalse(manufacturing.passed)
        self.assertIn(warnings[0].finding_id, manufacturing.blocking_finding_ids)

    def test_verified_fill_participates_in_exact_copper_clearance(self) -> None:
        board = _intent_board()
        report = self.engine.verify(replace(board, zones=(_verified(board.zones[0]),)))

        self.assertFalse(
            any(finding.rule_id == "GEO.ZONE.FILL_UNVERIFIED" for finding in report.findings)
        )
        self.assertTrue(
            any(finding.rule_id == "GEO.COPPER.MIN_CLEARANCE" for finding in report.findings)
        )

    def test_verified_state_cannot_be_self_asserted_or_tampered(self) -> None:
        board = _intent_board()
        fake = replace(board.zones[0], fill_state=ZoneFillState.VERIFIED_FILLED)
        with self.assertRaisesRegex(VerificationInputError, "must be exact ZoneFillEvidence"):
            self.engine.verify(replace(board, zones=(fake,)))

        verified = _verified(board.zones[0])
        assert verified.fill_evidence is not None
        forged = replace(
            verified,
            fill_evidence=replace(verified.fill_evidence, source_graph_hash="f" * 64),
        )
        with self.assertRaisesRegex(VerificationInputError, "does not bind its provenance"):
            self.engine.verify(replace(board, zones=(forged,)))

    def test_bool_and_subclass_fill_shapes_fail_closed(self) -> None:
        board = _intent_board()
        bool_state = replace(board.zones[0], fill_state=True)  # type: ignore[arg-type]
        with self.assertRaisesRegex(VerificationInputError, "fill_state must be exact"):
            self.engine.verify(replace(board, zones=(bool_state,)))

        class EvidenceSubclass(ZoneFillEvidence):
            pass

        verified = _verified(board.zones[0])
        assert verified.fill_evidence is not None
        subclassed = EvidenceSubclass(
            **{
                field: getattr(verified.fill_evidence, field)
                for field in (
                    "source_graph_hash",
                    "source_revision",
                    "fill_engine_id",
                    "fill_engine_revision",
                    "filled_geometry_hash",
                    "evidence_hash",
                )
            }
        )
        with self.assertRaisesRegex(VerificationInputError, "fill_evidence must be exact"):
            self.engine.verify(replace(board, zones=(replace(verified, fill_evidence=subclassed),)))

    def test_unverified_fill_warning_cannot_be_disabled_or_downgraded(self) -> None:
        disabled = replace(
            strict_policy(),
            overrides=(RuleOverride("GEO.ZONE.FILL_UNVERIFIED", enabled=False),),
        )
        with self.assertRaisesRegex(RuleConfigurationError, "mandatory rule cannot be disabled"):
            self.engine.verify(_intent_board(), disabled)

        downgraded = replace(
            strict_policy(),
            overrides=(
                RuleOverride(
                    "GEO.ZONE.FILL_UNVERIFIED",
                    severity=Severity.INFO,
                ),
            ),
        )
        with self.assertRaisesRegex(RuleConfigurationError, "cannot be weaker than warning"):
            self.engine.verify(_intent_board(), downgraded)


if __name__ == "__main__":
    unittest.main()
