from __future__ import annotations

import unittest
from dataclasses import replace

from backend.layout_validation import (
    DifferentialPairSkew,
    DrcBlocker,
    HardConstraintResult,
    LayoutCandidateValidator,
    LockedObjectState,
    NetRouteMetrics,
    ResourceUsage,
    SolverIdentity,
    TrustedValidationAttestation,
    ValidationState,
    seal_replay,
)
from tests.layout_validation.fixtures import (
    ATTESTATION_VERIFIER,
    CANDIDATE_ARTIFACT,
    FixtureLayoutCandidateValidator,
    attestation_for,
    replay_for,
    reseal,
    valid_contract,
    valid_manifest,
)


def rule_ids(result: object) -> set[str]:
    return {item.rule_id for item in result.findings}  # type: ignore[attr-defined]


class LayoutCandidateValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.validator = FixtureLayoutCandidateValidator()
        self.contract = valid_contract()
        self.manifest = valid_manifest()
        self.replay = replay_for(self.manifest)

    def test_exact_boundary_candidate_and_replay_are_accepted_and_stable(self) -> None:
        first = self.validator.validate(self.contract, self.manifest, self.replay)
        second = self.validator.validate(self.contract, self.manifest, self.replay)

        self.assertEqual(first, second)
        self.assertIs(first.state, ValidationState.ACCEPTED)
        self.assertTrue(first.accepted)
        self.assertEqual((), first.findings)
        for digest in (
            first.contract_hash,
            first.calculated_manifest_hash,
            first.calculated_replay_hash,
            first.result_hash,
        ):
            self.assertEqual(64, len(digest))

    def test_tampered_seed_fails_contract_manifest_and_replay_bindings(self) -> None:
        tampered = replace(self.manifest, seed=43)
        result = self.validator.validate(self.contract, tampered, self.replay)

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertFalse(result.accepted)
        self.assertTrue(
            {
                "LAYOUT.MANIFEST.INTEGRITY",
                "LAYOUT.SEED.EXACT",
                "LAYOUT.REPLAY.INPUT_EXACT",
            }.issubset(rule_ids(result))
        )

    def test_resealed_manifest_tamper_is_detected_by_replay_candidate_hash(self) -> None:
        tampered = reseal(self.manifest, candidate_graph_hash="4" * 64)
        result = self.validator.validate(self.contract, tampered, self.replay)

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.REPLAY.CANDIDATE_HASH_MATCH", rule_ids(result))
        self.assertIn("LAYOUT.REPLAY.INPUT_EXACT", rule_ids(result))

    def test_resealed_replay_tamper_still_fails_exact_input_binding(self) -> None:
        tampered = seal_replay(replace(self.replay, seed=99))
        result = self.validator.validate(self.contract, self.manifest, tampered)

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertNotIn("LAYOUT.REPLAY.INTEGRITY", rule_ids(result))
        self.assertIn("LAYOUT.REPLAY.INPUT_EXACT", rule_ids(result))

    def test_unsealed_replay_tamper_fails_integrity(self) -> None:
        tampered = replace(self.replay, candidate_graph_hash="5" * 64)
        result = self.validator.validate(self.contract, self.manifest, tampered)

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.REPLAY.INTEGRITY", rule_ids(result))
        self.assertIn("LAYOUT.REPLAY.CANDIDATE_HASH_MATCH", rule_ids(result))

    def test_moved_locked_object_is_a_deterministic_rejection(self) -> None:
        moved = reseal(
            self.manifest,
            locked_objects=(LockedObjectState("footprint:U1", "6" * 64),),
        )
        result = self.validator.validate(self.contract, moved, replay_for(moved))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.LOCKED.UNCHANGED"}, rule_ids(result))

    def test_missing_required_net_and_metric_fail_closed(self) -> None:
        missing = reseal(
            self.manifest,
            required_nets=("USB_D+",),
            route_metrics=(NetRouteMetrics("USB_D+", 2_000, 2),),
        )
        result = self.validator.validate(self.contract, missing, replay_for(missing))

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertTrue(
            {
                "LAYOUT.ROUTING.REQUIRED_NET_SET_EXACT",
                "LAYOUT.ROUTING.METRICS_COMPLETE",
            }.issubset(rule_ids(result))
        )

    def test_length_one_nanometre_above_maximum_is_rejected(self) -> None:
        over = reseal(
            self.manifest,
            route_metrics=(
                NetRouteMetrics("USB_D+", 2_001, 2),
                NetRouteMetrics("USB_D-", 1_000, 1),
            ),
        )
        result = self.validator.validate(self.contract, over, replay_for(over))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.ROUTE.LENGTH_LIMIT"}, rule_ids(result))

    def test_length_one_nanometre_below_minimum_is_rejected(self) -> None:
        under = reseal(
            self.manifest,
            route_metrics=(
                NetRouteMetrics("USB_D+", 2_000, 2),
                NetRouteMetrics("USB_D-", 999, 1),
            ),
        )
        result = self.validator.validate(self.contract, under, replay_for(under))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.ROUTE.LENGTH_LIMIT"}, rule_ids(result))

    def test_via_count_one_above_inclusive_limit_is_rejected(self) -> None:
        over = reseal(
            self.manifest,
            route_metrics=(
                NetRouteMetrics("USB_D+", 2_000, 3),
                NetRouteMetrics("USB_D-", 1_000, 1),
            ),
        )
        result = self.validator.validate(self.contract, over, replay_for(over))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.ROUTE.VIA_LIMIT"}, rule_ids(result))

    def test_skew_one_nanometre_above_inclusive_limit_is_rejected(self) -> None:
        over = reseal(
            self.manifest,
            differential_pair_skew=(DifferentialPairSkew("USB_D", "USB_D+", "USB_D-", 101),),
        )
        result = self.validator.validate(self.contract, over, replay_for(over))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.DIFF_PAIR.SKEW_LIMIT"}, rule_ids(result))

    def test_failed_hard_constraint_drc_blocker_and_unrouted_net_all_block(self) -> None:
        hard_results = tuple(
            replace(item, passed=False) if item.rule_id == "COPPER.CLEARANCE" else item
            for item in self.manifest.hard_constraint_results
        )
        bad = reseal(
            self.manifest,
            hard_constraint_results=hard_results,
            drc_blockers=(DrcBlocker("clearance", ("track:T1",), "7" * 64),),
            unrouted_required_nets=("USB_D-",),
        )
        result = self.validator.validate(self.contract, bad, replay_for(bad))

        self.assertIs(result.state, ValidationState.REJECTED)
        self.assertEqual(
            {
                "LAYOUT.HARD_CONSTRAINTS.ALL_PASS",
                "LAYOUT.DRC.ZERO_BLOCKERS",
                "LAYOUT.ROUTING.ZERO_UNROUTED",
            },
            rule_ids(result),
        )

    def test_exact_source_revision_is_required_even_with_resealed_evidence(self) -> None:
        stale = reseal(self.manifest, source_revision="git:stale")
        result = self.validator.validate(self.contract, stale, replay_for(stale))

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertEqual(
            {"LAYOUT.SOURCE_REVISION.EXACT", "LAYOUT.REPLAY.INPUT_EXACT"},
            rule_ids(result),
        )

    def test_resource_budget_is_inclusive_and_one_unit_over_rejects(self) -> None:
        exact = reseal(
            self.manifest,
            resource_usage=ResourceUsage(10_000, 64_000_000, 50_000),
        )
        accepted = self.validator.validate(self.contract, exact, replay_for(exact))
        self.assertIs(accepted.state, ValidationState.ACCEPTED)

        over = reseal(
            exact,
            resource_usage=ResourceUsage(10_001, 64_000_000, 50_000),
        )
        rejected = self.validator.validate(self.contract, over, replay_for(over))
        self.assertIs(rejected.state, ValidationState.REJECTED)
        self.assertEqual({"LAYOUT.RESOURCE.WITHIN_BUDGET"}, rule_ids(rejected))

    def test_schema_float_is_invalid_and_does_not_raise(self) -> None:
        malformed_objective = replace(self.manifest.objective_vector[0], value=1.5)  # type: ignore[arg-type]
        malformed = replace(
            self.manifest,
            objective_vector=(malformed_objective, self.manifest.objective_vector[1]),
        )
        result = self.validator.validate(self.contract, malformed, self.replay)

        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))
        self.assertTrue(all(len(item.evidence_hash) == 64 for item in result.findings))

    def test_default_validator_cannot_accept_self_sealed_claims_without_trust_inputs(self) -> None:
        result = LayoutCandidateValidator().validate(
            self.contract,
            self.manifest,
            self.replay,
        )
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertTrue(
            {
                "LAYOUT.CANDIDATE.ARTIFACT_EXACT",
                "LAYOUT.REPLAY.ARTIFACT_EXACT",
                "LAYOUT.ATTESTATION.TRUSTED",
            }.issubset(rule_ids(result))
        )

    def test_all_zero_self_sealed_claims_are_invalid_even_with_matching_replay(self) -> None:
        zero = "0" * 64
        results = tuple(
            HardConstraintResult(item.rule_id, True, zero)
            for item in self.manifest.hard_constraint_results
        )
        forged = reseal(
            self.manifest,
            candidate_graph_hash=zero,
            drc_report_hash=zero,
            hard_constraint_results=results,
        )
        result = self.validator.validate(self.contract, forged, replay_for(forged))
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))

    def test_solver_subclass_cannot_override_equality_at_the_trust_boundary(self) -> None:
        class ForgivingSolver(SolverIdentity):
            def __eq__(self, other: object) -> bool:
                del other
                return True

            __hash__ = SolverIdentity.__hash__

        forged_solver = ForgivingSolver(
            "evil-solver",
            "999.0.0",
            "f" * 64,
            "8" * 64,
        )
        forged_manifest = reseal(self.manifest, solver=forged_solver)
        forged_replay = seal_replay(replace(replay_for(forged_manifest), solver=forged_solver))
        result = self.validator.validate(self.contract, forged_manifest, forged_replay)
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))

    def test_bool_schema_version_and_revision_subclass_are_invalid(self) -> None:
        class Revision(str):
            pass

        bool_schema = replace(self.contract, schema_version=True)  # type: ignore[arg-type]
        result = self.validator.validate(bool_schema, self.manifest, self.replay)
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))

        forged_manifest = reseal(
            self.manifest,
            source_revision=Revision(self.manifest.source_revision),
        )
        forged_replay = seal_replay(
            replace(
                replay_for(forged_manifest),
                source_revision=Revision(self.replay.source_revision),
            )
        )
        result = self.validator.validate(self.contract, forged_manifest, forged_replay)
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))

    def test_exact_candidate_bytes_override_self_declared_graph_hash(self) -> None:
        result = self.validator.validate(
            self.contract,
            self.manifest,
            self.replay,
            candidate_artifact=b'{"board":"different"}',
        )
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.CANDIDATE.ARTIFACT_EXACT", rule_ids(result))

    def test_forged_attestation_proof_is_rejected(self) -> None:
        trusted = attestation_for(self.contract, self.manifest, self.replay)
        forged: TrustedValidationAttestation = replace(trusted, proof="f" * 64)
        result = self.validator.validate(
            self.contract,
            self.manifest,
            self.replay,
            candidate_artifact=CANDIDATE_ARTIFACT,
            replay_candidate_artifact=CANDIDATE_ARTIFACT,
            attestation=forged,
        )
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.ATTESTATION.TRUSTED", rule_ids(result))

    def test_alternate_trust_root_with_reused_declared_strings_has_distinct_identity(self) -> None:
        class AlwaysAcceptVerifier:
            authority_id = ATTESTATION_VERIFIER.authority_id
            version = ATTESTATION_VERIFIER.version
            code_hash = ATTESTATION_VERIFIER.code_hash

            @staticmethod
            def verify(attestation: TrustedValidationAttestation) -> bool:
                del attestation
                return True

        trusted = self.validator.validate(self.contract, self.manifest, self.replay)
        alternate = LayoutCandidateValidator(AlwaysAcceptVerifier()).validate(
            self.contract,
            self.manifest,
            self.replay,
            candidate_artifact=CANDIDATE_ARTIFACT,
            replay_candidate_artifact=CANDIDATE_ARTIFACT,
            attestation=attestation_for(self.contract, self.manifest, self.replay),
        )
        self.assertIs(trusted.state, ValidationState.ACCEPTED)
        self.assertIs(alternate.state, ValidationState.ACCEPTED)
        self.assertNotEqual(
            trusted.verifier_identity_hash,
            alternate.verifier_identity_hash,
        )

    def test_duplicate_hard_constraint_evidence_is_invalid(self) -> None:
        duplicate = reseal(
            self.manifest,
            hard_constraint_results=(
                self.manifest.hard_constraint_results[0],
                self.manifest.hard_constraint_results[0],
            ),
        )
        result = self.validator.validate(self.contract, duplicate, replay_for(duplicate))
        self.assertIs(result.state, ValidationState.INVALID)
        self.assertIn("LAYOUT.SCHEMA.VALID", rule_ids(result))


if __name__ == "__main__":
    unittest.main()
