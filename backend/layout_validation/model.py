"""Immutable data contracts for deterministic layout candidate validation."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ObjectiveDirection(str, Enum):
    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"


class ValidationState(str, Enum):
    """Terminal result states.  Only ``ACCEPTED`` permits downstream use."""

    ACCEPTED = "accepted"
    REJECTED = "rejected"
    INVALID = "invalid"


@dataclass(frozen=True, slots=True)
class SolverIdentity:
    solver_id: str
    version: str
    code_hash: str
    config_hash: str


@dataclass(frozen=True, slots=True, order=True)
class ObjectiveValue:
    objective_id: str
    direction: ObjectiveDirection
    value: int
    unit: str


@dataclass(frozen=True, slots=True, order=True)
class LockedObjectState:
    object_id: str
    state_hash: str


@dataclass(frozen=True, slots=True, order=True)
class HardConstraintResult:
    rule_id: str
    passed: bool
    evidence_hash: str


@dataclass(frozen=True, slots=True, order=True)
class DrcBlocker:
    rule_id: str
    object_ids: tuple[str, ...]
    evidence_hash: str


@dataclass(frozen=True, slots=True, order=True)
class NetRouteMetrics:
    net_id: str
    length_nm: int
    via_count: int


@dataclass(frozen=True, slots=True, order=True)
class DifferentialPairSkew:
    pair_id: str
    positive_net_id: str
    negative_net_id: str
    skew_nm: int


@dataclass(frozen=True, slots=True, order=True)
class NetRouteLimit:
    net_id: str
    minimum_length_nm: int
    maximum_length_nm: int
    maximum_via_count: int


@dataclass(frozen=True, slots=True, order=True)
class DifferentialPairLimit:
    pair_id: str
    positive_net_id: str
    negative_net_id: str
    maximum_skew_nm: int


@dataclass(frozen=True, slots=True)
class ResourceBudget:
    maximum_runtime_ms: int
    maximum_peak_memory_bytes: int
    maximum_iterations: int


@dataclass(frozen=True, slots=True)
class ResourceUsage:
    runtime_ms: int
    peak_memory_bytes: int
    iterations: int


@dataclass(frozen=True, slots=True)
class ValidationContract:
    """Trusted inputs captured before the solver process starts."""

    schema_version: int
    solver: SolverIdentity
    seed: int
    source_revision: str
    constraint_set_hash: str
    hard_constraint_rule_ids: tuple[str, ...]
    locked_object_baseline: tuple[LockedObjectState, ...]
    required_nets: tuple[str, ...]
    net_limits: tuple[NetRouteLimit, ...]
    differential_pair_limits: tuple[DifferentialPairLimit, ...]
    resource_budget: ResourceBudget


@dataclass(frozen=True, slots=True)
class CandidateManifest:
    """Solver output plus attestations from deterministic checking engines."""

    schema_version: int
    solver: SolverIdentity
    seed: int
    source_revision: str
    constraint_set_hash: str
    candidate_graph_hash: str
    objective_vector: tuple[ObjectiveValue, ...]
    hard_constraint_check_complete: bool
    hard_constraint_results: tuple[HardConstraintResult, ...]
    drc_check_complete: bool
    drc_report_hash: str
    drc_blockers: tuple[DrcBlocker, ...]
    routing_check_complete: bool
    required_nets: tuple[str, ...]
    unrouted_required_nets: tuple[str, ...]
    route_metrics: tuple[NetRouteMetrics, ...]
    differential_pair_skew: tuple[DifferentialPairSkew, ...]
    locked_object_baseline: tuple[LockedObjectState, ...]
    locked_objects: tuple[LockedObjectState, ...]
    resource_budget: ResourceBudget
    resource_usage: ResourceUsage
    manifest_hash: str


@dataclass(frozen=True, slots=True)
class ReplayRecord:
    """Independent rerun record bound to the original invocation and result."""

    schema_version: int
    solver: SolverIdentity
    seed: int
    source_revision: str
    constraint_set_hash: str
    original_manifest_hash: str
    candidate_graph_hash: str
    objective_vector: tuple[ObjectiveValue, ...]
    resource_budget: ResourceBudget
    replay_hash: str


@dataclass(frozen=True, slots=True)
class TrustedValidationAttestation:
    """Opaque proof produced by a separately trusted validation authority."""

    schema_version: int
    authority_id: str
    authority_version: str
    contract_hash: str
    manifest_hash: str
    replay_hash: str
    candidate_artifact_hash: str
    replay_candidate_artifact_hash: str
    proof: str


@dataclass(frozen=True, slots=True, order=True)
class ValidationFinding:
    rule_id: str
    message: str
    evidence_hash: str


@dataclass(frozen=True, slots=True)
class ValidationResult:
    schema_version: int
    validator_version: str
    state: ValidationState
    contract_hash: str
    calculated_manifest_hash: str
    calculated_replay_hash: str
    candidate_artifact_hash: str
    replay_candidate_artifact_hash: str
    attestation_hash: str
    attestation_authority_id: str
    verifier_identity_hash: str
    findings: tuple[ValidationFinding, ...]
    result_hash: str

    @property
    def accepted(self) -> bool:
        return self.state is ValidationState.ACCEPTED
