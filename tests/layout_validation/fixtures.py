"""Canonical fixtures and resealing helpers for layout-validation tests."""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import replace

from backend.layout_validation import (
    CandidateManifest,
    DifferentialPairLimit,
    DifferentialPairSkew,
    HardConstraintResult,
    LayoutCandidateValidator,
    LockedObjectState,
    NetRouteLimit,
    NetRouteMetrics,
    ObjectiveDirection,
    ObjectiveValue,
    ReplayRecord,
    ResourceBudget,
    ResourceUsage,
    SolverIdentity,
    TrustedValidationAttestation,
    ValidationContract,
    ValidationResult,
    candidate_artifact_hash,
    canonical_json_bytes,
    contract_hash,
    manifest_hash,
    replay_hash,
    seal_manifest,
    seal_replay,
)

CANDIDATE_ARTIFACT = b'{"board":"canonical-layout-candidate","schemaVersion":1}'
REPLAY_CANDIDATE_ARTIFACT = CANDIDATE_ARTIFACT
_ATTESTATION_SECRET = b"layout-validation-test-authority-key"


class FixtureAttestationVerifier:
    authority_id = "independent-layout-validation-test-authority"
    version = "1.0.0"
    code_hash = "9" * 64

    def verify(self, attestation: TrustedValidationAttestation) -> bool:
        expected = _proof_for(replace(attestation, proof=""))
        return hmac.compare_digest(attestation.proof, expected)


ATTESTATION_VERIFIER = FixtureAttestationVerifier()


def _proof_for(attestation: TrustedValidationAttestation) -> str:
    return hmac.new(
        _ATTESTATION_SECRET,
        canonical_json_bytes(attestation),
        hashlib.sha256,
    ).hexdigest()


def attestation_for(
    contract: ValidationContract,
    manifest: CandidateManifest,
    replay: ReplayRecord,
    *,
    candidate_artifact: bytes = CANDIDATE_ARTIFACT,
    replay_candidate_artifact: bytes = REPLAY_CANDIDATE_ARTIFACT,
) -> TrustedValidationAttestation:
    attestation = TrustedValidationAttestation(
        schema_version=1,
        authority_id=ATTESTATION_VERIFIER.authority_id,
        authority_version=ATTESTATION_VERIFIER.version,
        contract_hash=contract_hash(contract),
        manifest_hash=manifest_hash(manifest),
        replay_hash=replay_hash(replay),
        candidate_artifact_hash=candidate_artifact_hash(candidate_artifact),
        replay_candidate_artifact_hash=candidate_artifact_hash(replay_candidate_artifact),
        proof="",
    )
    return replace(attestation, proof=_proof_for(attestation))


class FixtureLayoutCandidateValidator(LayoutCandidateValidator):
    """Test adapter that provisions the independent trust boundary explicitly."""

    def __init__(self) -> None:
        super().__init__(ATTESTATION_VERIFIER)

    def validate(  # type: ignore[override]
        self,
        contract: ValidationContract,
        manifest: CandidateManifest,
        replay: ReplayRecord,
        *,
        candidate_artifact: bytes | None = CANDIDATE_ARTIFACT,
        replay_candidate_artifact: bytes | None = REPLAY_CANDIDATE_ARTIFACT,
        attestation: TrustedValidationAttestation | None = None,
    ) -> ValidationResult:
        if (
            attestation is None
            and candidate_artifact is not None
            and replay_candidate_artifact is not None
        ):
            try:
                attestation = attestation_for(
                    contract,
                    manifest,
                    replay,
                    candidate_artifact=candidate_artifact,
                    replay_candidate_artifact=replay_candidate_artifact,
                )
            except (TypeError, ValueError):
                # Malformed fixtures deliberately cannot be signed.
                attestation = None
        return super().validate(
            contract,
            manifest,
            replay,
            candidate_artifact=candidate_artifact,
            replay_candidate_artifact=replay_candidate_artifact,
            attestation=attestation,
        )


SOLVER = SolverIdentity(
    solver_id="deterministic-grid-router",
    version="3.4.1",
    code_hash="a" * 64,
    config_hash="b" * 64,
)
BUDGET = ResourceBudget(
    maximum_runtime_ms=10_000,
    maximum_peak_memory_bytes=64_000_000,
    maximum_iterations=50_000,
)
OBJECTIVES = (
    ObjectiveValue("total_route_length_nm", ObjectiveDirection.MINIMIZE, 3_500, "nm"),
    ObjectiveValue("via_count", ObjectiveDirection.MINIMIZE, 3, "count"),
)
LOCKS = (LockedObjectState("footprint:U1", "1" * 64),)


def valid_contract() -> ValidationContract:
    return ValidationContract(
        schema_version=1,
        solver=SOLVER,
        seed=42,
        source_revision="git:4e27f2fd0b7c6e9f",
        constraint_set_hash="c" * 64,
        hard_constraint_rule_ids=("BOARD.OUTLINE.CONTAINMENT", "COPPER.CLEARANCE"),
        locked_object_baseline=LOCKS,
        required_nets=("USB_D+", "USB_D-"),
        net_limits=(
            NetRouteLimit("USB_D+", 1_000, 2_000, 2),
            NetRouteLimit("USB_D-", 1_000, 2_000, 2),
        ),
        differential_pair_limits=(DifferentialPairLimit("USB_D", "USB_D+", "USB_D-", 100),),
        resource_budget=BUDGET,
    )


def valid_manifest() -> CandidateManifest:
    return seal_manifest(
        CandidateManifest(
            schema_version=1,
            solver=SOLVER,
            seed=42,
            source_revision="git:4e27f2fd0b7c6e9f",
            constraint_set_hash="c" * 64,
            candidate_graph_hash=candidate_artifact_hash(CANDIDATE_ARTIFACT),
            objective_vector=OBJECTIVES,
            hard_constraint_check_complete=True,
            hard_constraint_results=(
                HardConstraintResult("BOARD.OUTLINE.CONTAINMENT", True, "2" * 64),
                HardConstraintResult("COPPER.CLEARANCE", True, "3" * 64),
            ),
            drc_check_complete=True,
            drc_report_hash="e" * 64,
            drc_blockers=(),
            routing_check_complete=True,
            required_nets=("USB_D+", "USB_D-"),
            unrouted_required_nets=(),
            route_metrics=(
                # Exact inclusive boundaries are intentional.
                NetRouteMetrics("USB_D+", 2_000, 2),
                NetRouteMetrics("USB_D-", 1_000, 1),
            ),
            differential_pair_skew=(DifferentialPairSkew("USB_D", "USB_D+", "USB_D-", 100),),
            locked_object_baseline=LOCKS,
            locked_objects=LOCKS,
            resource_budget=BUDGET,
            resource_usage=ResourceUsage(9_000, 60_000_000, 49_000),
            manifest_hash="",
        )
    )


def replay_for(manifest: CandidateManifest) -> ReplayRecord:
    return seal_replay(
        ReplayRecord(
            schema_version=1,
            solver=manifest.solver,
            seed=manifest.seed,
            source_revision=manifest.source_revision,
            constraint_set_hash=manifest.constraint_set_hash,
            original_manifest_hash=manifest.manifest_hash,
            candidate_graph_hash=manifest.candidate_graph_hash,
            objective_vector=manifest.objective_vector,
            resource_budget=manifest.resource_budget,
            replay_hash="",
        )
    )


def reseal(manifest: CandidateManifest, **changes: object) -> CandidateManifest:
    """Apply fixture changes and calculate a new manifest integrity hash."""

    return seal_manifest(replace(manifest, **changes))
