from __future__ import annotations

import unittest
from dataclasses import replace

from backend.verification import (
    GateDefinition,
    ParameterValue,
    RuleConfigurationError,
    RuleDefinition,
    RuleDomain,
    RuleExecutionOutcome,
    RuleOverride,
    Severity,
    VerificationEngine,
    VerificationExecutionError,
    VerificationInputError,
    VerificationPolicy,
    canonical_data,
    default_evaluators,
    strict_policy,
)
from backend.verification.algorithms import RoutingConnectivityRule
from backend.verification.canonical import CanonicalizationError
from backend.verification.geometric import MinimumTrackWidthRule
from backend.verification.model import BoardGraph
from backend.verification.rule import FindingDraft, RuleContext
from tests.verification.fixtures import (
    broken_board,
    disconnected_board,
    invalid_outline_board,
    reordered_safe_board,
    safe_board,
    zone_pad_clearance_board,
)


class VerificationEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = VerificationEngine()

    def test_safe_fixture_passes_every_strict_gate(self) -> None:
        report = self.engine.verify(safe_board())
        self.assertEqual((), report.findings)
        self.assertTrue(next(gate for gate in report.gates if gate.gate_id == "preview").passed)
        self.assertTrue(next(gate for gate in report.gates if gate.gate_id == "commit").passed)
        manufacturing = next(
            gate for gate in report.gates if gate.gate_id == "manufacturing-release"
        )
        self.assertFalse(manufacturing.passed)
        self.assertEqual(("trusted-kicad-drc-v1",), manufacturing.unavailable_evidence_ids)
        self.assertEqual(64, len(report.input_hash))
        self.assertEqual(64, len(report.rule_set_hash))
        self.assertEqual(64, len(report.report_hash))

    def test_reordering_equivalent_input_is_bitwise_stable(self) -> None:
        first = self.engine.verify(safe_board())
        second = self.engine.verify(reordered_safe_board())
        self.assertEqual(first, second)

    def test_broken_fixture_returns_stable_typed_rule_ids(self) -> None:
        first = self.engine.verify(broken_board())
        second = self.engine.verify(broken_board())
        self.assertEqual(first, second)
        rule_ids = {finding.rule_id for finding in first.findings}
        self.assertTrue(
            {
                "ELEC.COMPONENT.FOOTPRINT_REQUIRED",
                "ELEC.COMPONENT.PART_PROVENANCE_REQUIRED",
                "ELEC.NET.INPUT_DRIVEN",
                "ELEC.NET.OUTPUT_CONTENTION",
                "ELEC.NET.SINGLE_CONNECTION",
                "GEO.TRACK.MIN_WIDTH",
                "GEO.VIA.MIN_ANNULAR_RING",
                "ALG.ROUTING.CONNECTIVITY",
            }.issubset(rule_ids)
        )
        self.assertTrue(all(len(item.evidence_hash) == 64 for item in first.findings))
        self.assertFalse(next(gate for gate in first.gates if gate.gate_id == "commit").passed)

    def test_routing_algorithm_rejects_disconnected_pad(self) -> None:
        report = self.engine.verify(disconnected_board())
        connectivity = [
            item for item in report.findings if item.rule_id == "ALG.ROUTING.CONNECTIVITY"
        ]
        self.assertEqual(1, len(connectivity))
        self.assertIn("not one connected copper component", connectivity[0].message)

    def test_invalid_outline_fails_mandatory_geometry_rule(self) -> None:
        report = self.engine.verify(invalid_outline_board())
        outline_findings = [item for item in report.findings if item.rule_id == "GEO.OUTLINE.VALID"]
        self.assertTrue(outline_findings)
        self.assertTrue(all(item.severity is Severity.FATAL for item in outline_findings))
        self.assertFalse(next(gate for gate in report.gates if gate.gate_id == "preview").passed)

    def test_policy_severity_changes_are_hashed_and_gate_specific(self) -> None:
        narrow = replace(
            safe_board(),
            tracks=(replace(safe_board().tracks[0], width_nm=100_000),),
        )
        base = strict_policy()
        policy = VerificationPolicy(
            overrides=(RuleOverride("GEO.TRACK.MIN_WIDTH", True, Severity.WARNING),),
            gates=base.gates,
        )
        report = self.engine.verify(narrow, policy)
        finding = next(item for item in report.findings if item.rule_id == "GEO.TRACK.MIN_WIDTH")
        self.assertIs(finding.severity, Severity.WARNING)
        self.assertTrue(next(gate for gate in report.gates if gate.gate_id == "commit").passed)
        self.assertFalse(
            next(gate for gate in report.gates if gate.gate_id == "manufacturing-release").passed
        )
        self.assertNotEqual(self.engine.verify(narrow).rule_set_hash, report.rule_set_hash)

    def test_rule_parameter_override_changes_result_at_exact_boundary(self) -> None:
        narrow = replace(
            safe_board(),
            tracks=(replace(safe_board().tracks[0], width_nm=100_000),),
        )
        policy = VerificationPolicy(
            overrides=(
                RuleOverride(
                    "GEO.TRACK.MIN_WIDTH",
                    parameters=(ParameterValue("minimum_width_nm", 100_000),),
                ),
            ),
            gates=strict_policy().gates,
        )
        report = self.engine.verify(narrow, policy)
        self.assertFalse(any(item.rule_id == "GEO.TRACK.MIN_WIDTH" for item in report.findings))

    def test_mandatory_rules_cannot_be_disabled(self) -> None:
        policy = VerificationPolicy(
            overrides=(RuleOverride("SYS.GRAPH.REFERENCE_INTEGRITY", enabled=False),),
            gates=strict_policy().gates,
        )
        with self.assertRaises(RuleConfigurationError):
            self.engine.verify(safe_board(), policy)

    def test_mandatory_fatal_rule_cannot_be_downgraded(self) -> None:
        policy = VerificationPolicy(
            overrides=(RuleOverride("GEO.OUTLINE.VALID", severity=Severity.INFO),),
            gates=strict_policy().gates,
        )
        with self.assertRaises(RuleConfigurationError):
            self.engine.verify(invalid_outline_board(), policy)

    def test_required_gate_cannot_exempt_mandatory_fatal_rule(self) -> None:
        gates = tuple(
            replace(gate, exempt_rule_ids=("GEO.OUTLINE.VALID",))
            if gate.gate_id == "commit"
            else gate
            for gate in strict_policy().gates
        )
        policy = VerificationPolicy(gates=gates)
        with self.assertRaises(RuleConfigurationError):
            self.engine.verify(invalid_outline_board(), policy)

    def test_policy_must_contain_every_required_gate(self) -> None:
        with self.assertRaisesRegex(RuleConfigurationError, "missing required gates"):
            self.engine.verify(safe_board(), VerificationPolicy())

    def test_required_gate_threshold_cannot_be_weaker_than_strict_policy(self) -> None:
        gates = tuple(
            replace(gate, block_at_or_above=Severity.FATAL) if gate.gate_id == "commit" else gate
            for gate in strict_policy().gates
        )
        with self.assertRaisesRegex(RuleConfigurationError, "threshold cannot be weaker"):
            self.engine.verify(safe_board(), VerificationPolicy(gates=gates))

    def test_disabled_nonmandatory_rule_is_not_run_and_blocks_commit(self) -> None:
        policy = VerificationPolicy(
            overrides=(RuleOverride("ALG.ROUTING.CONNECTIVITY", enabled=False),),
            gates=strict_policy().gates,
        )
        report = self.engine.verify(disconnected_board(), policy)
        execution = next(
            item for item in report.executions if item.rule_id == "ALG.ROUTING.CONNECTIVITY"
        )
        commit = next(gate for gate in report.gates if gate.gate_id == "commit")
        self.assertIs(execution.outcome, RuleExecutionOutcome.NOT_RUN)
        self.assertEqual((), execution.finding_ids)
        self.assertFalse(commit.passed)
        self.assertIn("ALG.ROUTING.CONNECTIVITY", commit.blocking_rule_ids)

    def test_rule_set_hash_binds_nested_algorithm_implementation(self) -> None:
        class EmptyRoutingValidator:
            algorithm_id = "different-router"
            version = "999.0.0"

            @staticmethod
            def validate(board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
                del board, context
                return ()

        evaluators = tuple(
            RoutingConnectivityRule(EmptyRoutingValidator())
            if type(item) is RoutingConnectivityRule
            else item
            for item in default_evaluators()
        )
        native = self.engine.verify(disconnected_board())
        substituted = VerificationEngine(evaluators=evaluators).verify(disconnected_board())
        self.assertNotEqual(native.rule_set_hash, substituted.rule_set_hash)
        self.assertFalse(next(g for g in native.gates if g.gate_id == "commit").passed)
        self.assertTrue(next(g for g in substituted.gates if g.gate_id == "commit").passed)

    def test_rule_set_hash_binds_live_evaluator_method_code(self) -> None:
        narrow = replace(
            safe_board(),
            tracks=(replace(safe_board().tracks[0], width_nm=100_000),),
        )
        native = self.engine.verify(narrow)
        original = MinimumTrackWidthRule.evaluate

        def always_pass(
            self: MinimumTrackWidthRule,
            board: BoardGraph,
            context: RuleContext,
        ) -> tuple[FindingDraft, ...]:
            del self, board, context
            return ()

        MinimumTrackWidthRule.evaluate = always_pass
        try:
            substituted = VerificationEngine().verify(narrow)
        finally:
            MinimumTrackWidthRule.evaluate = original

        self.assertNotEqual(native.rule_set_hash, substituted.rule_set_hash)
        self.assertNotEqual(native.run_id, substituted.run_id)
        self.assertTrue(any(item.rule_id == "GEO.TRACK.MIN_WIDTH" for item in native.findings))
        self.assertFalse(
            any(item.rule_id == "GEO.TRACK.MIN_WIDTH" for item in substituted.findings)
        )

    def test_evaluator_live_identity_drift_during_run_fails_closed(self) -> None:
        class DriftingEvaluator:
            definition = RuleDefinition(
                rule_id="TEST.IDENTITY.DRIFT",
                version="1.0.0",
                domain=RuleDomain.SYSTEM,
                title="Identity drift",
                description="Mutates its live evaluator implementation.",
                default_severity=Severity.ERROR,
            )

            def evaluate(
                self,
                board: BoardGraph,
                context: RuleContext,
            ) -> tuple[FindingDraft, ...]:
                del board, context

                def replacement(
                    self: DriftingEvaluator,
                    board: BoardGraph,
                    context: RuleContext,
                ) -> tuple[FindingDraft, ...]:
                    del self, board, context
                    return ()

                type(self).evaluate = replacement
                return ()

        with self.assertRaisesRegex(VerificationExecutionError, "identity drifted"):
            VerificationEngine(evaluators=(DriftingEvaluator(),)).verify(safe_board())

    def test_bool_schema_version_and_string_subclass_revision_fail_closed(self) -> None:
        class RevisionString(str):
            pass

        with self.assertRaises(VerificationInputError):
            self.engine.verify(replace(safe_board(), schema_version=True))  # type: ignore[arg-type]
        with self.assertRaises(VerificationInputError):
            self.engine.verify(replace(safe_board(), revision=RevisionString("git:forged")))

    def test_bool_alias_in_policy_and_duplicate_zone_id_fail_closed(self) -> None:
        malformed_policy = VerificationPolicy(
            overrides=(
                RuleOverride("ALG.ROUTING.CONNECTIVITY", enabled=1),  # type: ignore[arg-type]
            ),
            gates=strict_policy().gates,
        )
        with self.assertRaises(RuleConfigurationError):
            self.engine.verify(safe_board(), malformed_policy)

        board = zone_pad_clearance_board(500_000)
        duplicated = replace(board, zones=(board.zones[0], board.zones[0]))
        report = self.engine.verify(duplicated)
        findings = [
            item for item in report.findings if item.rule_id == "SYS.GRAPH.REFERENCE_INTEGRITY"
        ]
        self.assertTrue(findings)
        self.assertTrue(any("Duplicate zone identifier" in item.message for item in findings))
        self.assertFalse(next(gate for gate in report.gates if gate.gate_id == "commit").passed)

    def test_unknown_rule_override_is_rejected(self) -> None:
        with self.assertRaises(RuleConfigurationError):
            self.engine.verify(
                safe_board(),
                VerificationPolicy(overrides=(RuleOverride("ELEC.UNKNOWN.RULE"),)),
            )

    def test_gate_can_scope_to_a_deterministic_rule(self) -> None:
        advisory = GateDefinition(
            "track-width-only",
            "Only track width blocks this workflow",
            Severity.WARNING,
            rule_ids=("GEO.TRACK.MIN_WIDTH",),
        )
        policy = VerificationPolicy(gates=strict_policy().gates + (advisory,))
        report = self.engine.verify(broken_board(), policy)
        gate = next(item for item in report.gates if item.gate_id == "track-width-only")
        self.assertFalse(gate.passed)
        self.assertEqual(
            {"GEO.TRACK.MIN_WIDTH"},
            {
                finding.rule_id
                for finding in report.findings
                if finding.finding_id in gate.blocking_finding_ids
            },
        )

    def test_canonical_boundary_rejects_floats(self) -> None:
        with self.assertRaises(CanonicalizationError):
            canonical_data({"not_allowed": 0.1})


if __name__ == "__main__":
    unittest.main()
