"""Fail-closed validation of placement/routing candidate manifests.

This module does not place or route a board.  It validates that a solver result
is bound to the approved invocation, satisfies deterministic hard gates, and is
reproduced byte-for-byte (at the candidate graph boundary) by an independent
replay.
"""

from __future__ import annotations

import hashlib
import inspect
import re
from dataclasses import replace
from enum import Enum
from pathlib import Path
from types import CodeType, FunctionType, MethodType
from typing import Any, Iterable, Mapping, Protocol, cast

from .canonical import CanonicalizationError, stable_hash
from .hashing import (
    attestation_hash,
    candidate_artifact_hash,
    contract_hash,
    manifest_hash,
    replay_hash,
)
from .model import (
    CandidateManifest,
    DifferentialPairLimit,
    DifferentialPairSkew,
    DrcBlocker,
    HardConstraintResult,
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
    ValidationFinding,
    ValidationResult,
    ValidationState,
)

VALIDATOR_VERSION = "1.1.0"
SCHEMA_VERSION = 1
_ZERO_HASH = "0" * 64
_HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")

# These indicate missing, malformed, stale, or tampered evidence.  They are
# distinguished from a well-formed candidate that simply violates a design
# constraint; both terminal states block downstream use.
_INVALID_RULE_IDS = frozenset(
    {
        "LAYOUT.SCHEMA.VALID",
        "LAYOUT.MANIFEST.INTEGRITY",
        "LAYOUT.CANDIDATE.ARTIFACT_EXACT",
        "LAYOUT.SOLVER.IDENTITY_EXACT",
        "LAYOUT.SEED.EXACT",
        "LAYOUT.SOURCE_REVISION.EXACT",
        "LAYOUT.CONSTRAINT_SET.EXACT",
        "LAYOUT.HARD_CONSTRAINTS.COMPLETE",
        "LAYOUT.DRC.COMPLETE",
        "LAYOUT.ROUTING.COMPLETE",
        "LAYOUT.ROUTING.REQUIRED_NET_SET_EXACT",
        "LAYOUT.ROUTING.METRICS_COMPLETE",
        "LAYOUT.LOCKED.BASELINE_EXACT",
        "LAYOUT.RESOURCE.BUDGET_EXACT",
        "LAYOUT.REPLAY.INTEGRITY",
        "LAYOUT.REPLAY.INPUT_EXACT",
        "LAYOUT.REPLAY.CANDIDATE_HASH_MATCH",
        "LAYOUT.REPLAY.ARTIFACT_EXACT",
        "LAYOUT.ATTESTATION.TRUSTED",
    }
)

_MESSAGES = {
    "LAYOUT.SCHEMA.VALID": "Validation input violates the canonical schema.",
    "LAYOUT.MANIFEST.INTEGRITY": "Candidate manifest integrity hash does not match.",
    "LAYOUT.CANDIDATE.ARTIFACT_EXACT": (
        "Candidate graph hash is not bound to the supplied artifact."
    ),
    "LAYOUT.SOLVER.IDENTITY_EXACT": "Solver identity differs from the approved invocation.",
    "LAYOUT.SEED.EXACT": "Solver seed differs from the approved invocation.",
    "LAYOUT.SOURCE_REVISION.EXACT": "Source revision differs from the approved invocation.",
    "LAYOUT.CONSTRAINT_SET.EXACT": "Constraint-set hash differs from the approved invocation.",
    "LAYOUT.HARD_CONSTRAINTS.COMPLETE": "Hard-constraint evidence is incomplete.",
    "LAYOUT.HARD_CONSTRAINTS.ALL_PASS": "At least one hard constraint failed.",
    "LAYOUT.DRC.COMPLETE": "The declared DRC run is incomplete.",
    "LAYOUT.DRC.ZERO_BLOCKERS": "The deterministic DRC report contains blockers.",
    "LAYOUT.ROUTING.COMPLETE": "The declared connectivity run is incomplete.",
    "LAYOUT.ROUTING.REQUIRED_NET_SET_EXACT": "Required-net declaration is not exact.",
    "LAYOUT.ROUTING.ZERO_UNROUTED": "At least one required net is unrouted.",
    "LAYOUT.ROUTING.METRICS_COMPLETE": "Per-net or differential-pair metrics are incomplete.",
    "LAYOUT.LOCKED.BASELINE_EXACT": "Locked-object baseline is not the approved baseline.",
    "LAYOUT.LOCKED.UNCHANGED": "A locked object changed or disappeared.",
    "LAYOUT.ROUTE.LENGTH_LIMIT": "A route length is outside its configured inclusive limits.",
    "LAYOUT.ROUTE.VIA_LIMIT": "A route exceeds its configured via-count limit.",
    "LAYOUT.DIFF_PAIR.SKEW_LIMIT": "A differential pair exceeds its configured skew limit.",
    "LAYOUT.RESOURCE.BUDGET_EXACT": "Resource budget differs from the approved budget.",
    "LAYOUT.RESOURCE.WITHIN_BUDGET": "Solver resource usage exceeds its approved budget.",
    "LAYOUT.REPLAY.INTEGRITY": "Replay record integrity hash does not match.",
    "LAYOUT.REPLAY.INPUT_EXACT": "Replay inputs differ from the original approved invocation.",
    "LAYOUT.REPLAY.CANDIDATE_HASH_MATCH": "Replay did not reproduce the candidate graph hash.",
    "LAYOUT.REPLAY.ARTIFACT_EXACT": (
        "Replay graph hash is not bound to the supplied replay artifact."
    ),
    "LAYOUT.ATTESTATION.TRUSTED": (
        "Independent validation attestation is missing, mismatched, or untrusted."
    ),
}


class AttestationVerifier(Protocol):
    """Application-provisioned trust root for independent validation proofs."""

    authority_id: str
    version: str
    code_hash: str

    def verify(self, attestation: TrustedValidationAttestation) -> bool: ...


class LayoutCandidateValidator:
    """Validate one solver candidate and its independent deterministic replay."""

    def __init__(self, attestation_verifier: AttestationVerifier | None = None) -> None:
        self._attestation_verifier = attestation_verifier

    def validate(
        self,
        contract: ValidationContract,
        manifest: CandidateManifest,
        replay: ReplayRecord,
        *,
        candidate_artifact: bytes | None = None,
        replay_candidate_artifact: bytes | None = None,
        attestation: TrustedValidationAttestation | None = None,
    ) -> ValidationResult:
        findings: list[ValidationFinding] = []

        def add(rule_id: str, evidence: Mapping[str, Any]) -> None:
            findings.append(
                ValidationFinding(
                    rule_id=rule_id,
                    message=_MESSAGES[rule_id],
                    evidence_hash=stable_hash(
                        evidence,
                        domain=f"layout-validation/evidence/{rule_id}/v1",
                    ),
                )
            )

        schema_issues = _schema_issues(contract, manifest, replay)
        for location, reason in schema_issues:
            add("LAYOUT.SCHEMA.VALID", {"location": location, "reason": reason})

        calculated_contract_hash = _ZERO_HASH
        calculated_manifest_hash = _ZERO_HASH
        calculated_replay_hash = _ZERO_HASH
        calculated_candidate_artifact_hash = _ZERO_HASH
        calculated_replay_candidate_artifact_hash = _ZERO_HASH
        calculated_attestation_hash = _ZERO_HASH
        attestation_authority_id = ""
        verifier_identity_hash = _ZERO_HASH
        try:
            calculated_contract_hash = contract_hash(contract)
            calculated_manifest_hash = manifest_hash(manifest)
            calculated_replay_hash = replay_hash(replay)
        except (CanonicalizationError, TypeError, ValueError) as error:
            add(
                "LAYOUT.SCHEMA.VALID",
                {"location": "canonical-hash", "reason": type(error).__name__},
            )

        for rule_id, location, artifact in (
            (
                "LAYOUT.CANDIDATE.ARTIFACT_EXACT",
                "candidate_artifact",
                candidate_artifact,
            ),
            (
                "LAYOUT.REPLAY.ARTIFACT_EXACT",
                "replay_candidate_artifact",
                replay_candidate_artifact,
            ),
        ):
            if type(artifact) is not bytes or not artifact:
                add(rule_id, {"location": location, "reason": "non-empty exact bytes required"})
                continue
            calculated = candidate_artifact_hash(artifact)
            if rule_id == "LAYOUT.CANDIDATE.ARTIFACT_EXACT":
                calculated_candidate_artifact_hash = calculated
            else:
                calculated_replay_candidate_artifact_hash = calculated

        verifier_issues, verifier_identity_hash = _verifier_identity(self._attestation_verifier)
        for reason in verifier_issues:
            add("LAYOUT.ATTESTATION.TRUSTED", {"reason": reason})

        attestation_issues = _attestation_issues(attestation)
        for location, reason in attestation_issues:
            add(
                "LAYOUT.ATTESTATION.TRUSTED",
                {"location": location, "reason": reason},
            )
        if type(attestation) is TrustedValidationAttestation and not attestation_issues:
            calculated_attestation_hash = attestation_hash(attestation)
            attestation_authority_id = attestation.authority_id

        # Structural violations make subsequent field access unsafe and their
        # result is necessarily INVALID.  Return a stable, fail-closed report.
        if schema_issues or calculated_contract_hash == _ZERO_HASH:
            return _finish(
                findings,
                calculated_contract_hash,
                calculated_manifest_hash,
                calculated_replay_hash,
                calculated_candidate_artifact_hash,
                calculated_replay_candidate_artifact_hash,
                calculated_attestation_hash,
                attestation_authority_id,
                verifier_identity_hash,
            )

        if manifest.manifest_hash != calculated_manifest_hash:
            add(
                "LAYOUT.MANIFEST.INTEGRITY",
                {
                    "declared": manifest.manifest_hash,
                    "calculated": calculated_manifest_hash,
                },
            )

        if manifest.candidate_graph_hash != calculated_candidate_artifact_hash:
            add(
                "LAYOUT.CANDIDATE.ARTIFACT_EXACT",
                {
                    "declared": manifest.candidate_graph_hash,
                    "calculated": calculated_candidate_artifact_hash,
                },
            )
        if replay.candidate_graph_hash != calculated_replay_candidate_artifact_hash:
            add(
                "LAYOUT.REPLAY.ARTIFACT_EXACT",
                {
                    "declared": replay.candidate_graph_hash,
                    "calculated": calculated_replay_candidate_artifact_hash,
                },
            )

        if manifest.solver != contract.solver:
            add(
                "LAYOUT.SOLVER.IDENTITY_EXACT",
                {"approved": contract.solver, "candidate": manifest.solver},
            )
        if manifest.seed != contract.seed:
            add("LAYOUT.SEED.EXACT", {"approved": contract.seed, "candidate": manifest.seed})
        if manifest.source_revision != contract.source_revision:
            add(
                "LAYOUT.SOURCE_REVISION.EXACT",
                {"approved": contract.source_revision, "candidate": manifest.source_revision},
            )
        if manifest.constraint_set_hash != contract.constraint_set_hash:
            add(
                "LAYOUT.CONSTRAINT_SET.EXACT",
                {
                    "approved": contract.constraint_set_hash,
                    "candidate": manifest.constraint_set_hash,
                },
            )

        self._validate_hard_constraints(contract, manifest, add)
        self._validate_drc(manifest, add)
        self._validate_routing(contract, manifest, add)
        self._validate_locks(contract, manifest, add)
        self._validate_resource_budget(contract, manifest, add)
        self._validate_replay(
            contract,
            manifest,
            replay,
            calculated_manifest_hash,
            calculated_replay_hash,
            add,
        )
        self._validate_attestation(
            contract,
            manifest,
            replay,
            attestation,
            calculated_contract_hash,
            calculated_manifest_hash,
            calculated_replay_hash,
            calculated_candidate_artifact_hash,
            calculated_replay_candidate_artifact_hash,
            add,
        )
        post_verifier_issues, post_verifier_identity_hash = _verifier_identity(
            self._attestation_verifier
        )
        if not verifier_issues and (
            post_verifier_issues or post_verifier_identity_hash != verifier_identity_hash
        ):
            add(
                "LAYOUT.ATTESTATION.TRUSTED",
                {
                    "reason": "verifier_identity_drift",
                    "post_issues": post_verifier_issues,
                },
            )

        return _finish(
            findings,
            calculated_contract_hash,
            calculated_manifest_hash,
            calculated_replay_hash,
            calculated_candidate_artifact_hash,
            calculated_replay_candidate_artifact_hash,
            calculated_attestation_hash,
            attestation_authority_id,
            verifier_identity_hash,
        )

    def _validate_attestation(
        self,
        contract: ValidationContract,
        manifest: CandidateManifest,
        replay: ReplayRecord,
        attestation: TrustedValidationAttestation | None,
        calculated_contract_hash: str,
        calculated_manifest_hash: str,
        calculated_replay_hash: str,
        calculated_candidate_artifact_hash: str,
        calculated_replay_candidate_artifact_hash: str,
        add: Any,
    ) -> None:
        verifier = self._attestation_verifier
        if verifier is None or type(attestation) is not TrustedValidationAttestation:
            return
        if _attestation_issues(attestation) or _verifier_identity(verifier)[0]:
            return

        mismatches: list[str] = []
        if attestation.authority_id != verifier.authority_id:
            mismatches.append("authority_id")
        if attestation.authority_version != verifier.version:
            mismatches.append("authority_version")
        if attestation.authority_id == contract.solver.solver_id:
            mismatches.append("authority_not_independent")
        expected = (
            ("contract_hash", calculated_contract_hash),
            ("manifest_hash", calculated_manifest_hash),
            ("replay_hash", calculated_replay_hash),
            ("candidate_artifact_hash", calculated_candidate_artifact_hash),
            (
                "replay_candidate_artifact_hash",
                calculated_replay_candidate_artifact_hash,
            ),
        )
        for field_name, value in expected:
            if getattr(attestation, field_name) != value:
                mismatches.append(field_name)
        if attestation.manifest_hash != manifest.manifest_hash:
            mismatches.append("declared_manifest_hash")
        if attestation.replay_hash != replay.replay_hash:
            mismatches.append("declared_replay_hash")
        if mismatches:
            add(
                "LAYOUT.ATTESTATION.TRUSTED",
                {"mismatched_fields": tuple(sorted(set(mismatches)))},
            )

        try:
            verified = verifier.verify(attestation)
        except Exception as error:  # fail closed at the external trust boundary
            add(
                "LAYOUT.ATTESTATION.TRUSTED",
                {"reason": "verifier_exception", "error_type": type(error).__name__},
            )
            return
        if verified is not True:
            add("LAYOUT.ATTESTATION.TRUSTED", {"reason": "proof_rejected"})

    @staticmethod
    def _validate_hard_constraints(
        contract: ValidationContract,
        manifest: CandidateManifest,
        add: Any,
    ) -> None:
        expected = tuple(sorted(contract.hard_constraint_rule_ids))
        actual = tuple(sorted(item.rule_id for item in manifest.hard_constraint_results))
        if not manifest.hard_constraint_check_complete or actual != expected:
            add(
                "LAYOUT.HARD_CONSTRAINTS.COMPLETE",
                {
                    "check_complete": manifest.hard_constraint_check_complete,
                    "expected_rule_ids": expected,
                    "actual_rule_ids": actual,
                },
            )
        failed = tuple(
            sorted(item.rule_id for item in manifest.hard_constraint_results if not item.passed)
        )
        if failed:
            add("LAYOUT.HARD_CONSTRAINTS.ALL_PASS", {"failed_rule_ids": failed})

    @staticmethod
    def _validate_drc(manifest: CandidateManifest, add: Any) -> None:
        if not manifest.drc_check_complete:
            add(
                "LAYOUT.DRC.COMPLETE",
                {"check_complete": manifest.drc_check_complete},
            )
        if manifest.drc_blockers:
            add(
                "LAYOUT.DRC.ZERO_BLOCKERS",
                {
                    "blockers": tuple(
                        (item.rule_id, item.object_ids, item.evidence_hash)
                        for item in sorted(manifest.drc_blockers)
                    )
                },
            )

    @staticmethod
    def _validate_routing(
        contract: ValidationContract,
        manifest: CandidateManifest,
        add: Any,
    ) -> None:
        if not manifest.routing_check_complete:
            add(
                "LAYOUT.ROUTING.COMPLETE",
                {"check_complete": manifest.routing_check_complete},
            )

        expected_nets = tuple(sorted(contract.required_nets))
        actual_nets = tuple(sorted(manifest.required_nets))
        if actual_nets != expected_nets:
            add(
                "LAYOUT.ROUTING.REQUIRED_NET_SET_EXACT",
                {"approved": expected_nets, "candidate": actual_nets},
            )

        if manifest.unrouted_required_nets:
            add(
                "LAYOUT.ROUTING.ZERO_UNROUTED",
                {"net_ids": tuple(sorted(manifest.unrouted_required_nets))},
            )

        metric_by_net = {item.net_id: item for item in manifest.route_metrics}
        expected_pairs = tuple(sorted(item.pair_id for item in contract.differential_pair_limits))
        actual_pairs = tuple(sorted(item.pair_id for item in manifest.differential_pair_skew))
        if tuple(sorted(metric_by_net)) != expected_nets or actual_pairs != expected_pairs:
            add(
                "LAYOUT.ROUTING.METRICS_COMPLETE",
                {
                    "expected_net_ids": expected_nets,
                    "actual_net_ids": tuple(sorted(metric_by_net)),
                    "expected_pair_ids": expected_pairs,
                    "actual_pair_ids": actual_pairs,
                },
            )

        for limit in sorted(contract.net_limits):
            metric = metric_by_net.get(limit.net_id)
            if metric is None:
                continue
            if not (limit.minimum_length_nm <= metric.length_nm <= limit.maximum_length_nm):
                add(
                    "LAYOUT.ROUTE.LENGTH_LIMIT",
                    {
                        "net_id": limit.net_id,
                        "actual_nm": metric.length_nm,
                        "minimum_nm": limit.minimum_length_nm,
                        "maximum_nm": limit.maximum_length_nm,
                    },
                )
            if metric.via_count > limit.maximum_via_count:
                add(
                    "LAYOUT.ROUTE.VIA_LIMIT",
                    {
                        "net_id": limit.net_id,
                        "actual": metric.via_count,
                        "maximum": limit.maximum_via_count,
                    },
                )

        skew_by_pair = {item.pair_id: item for item in manifest.differential_pair_skew}
        for limit in sorted(contract.differential_pair_limits):
            skew = skew_by_pair.get(limit.pair_id)
            if skew is None:
                continue
            if (
                skew.positive_net_id != limit.positive_net_id
                or skew.negative_net_id != limit.negative_net_id
            ):
                add(
                    "LAYOUT.ROUTING.METRICS_COMPLETE",
                    {
                        "pair_id": limit.pair_id,
                        "approved_nets": (limit.positive_net_id, limit.negative_net_id),
                        "candidate_nets": (skew.positive_net_id, skew.negative_net_id),
                    },
                )
            if skew.skew_nm > limit.maximum_skew_nm:
                add(
                    "LAYOUT.DIFF_PAIR.SKEW_LIMIT",
                    {
                        "pair_id": limit.pair_id,
                        "actual_nm": skew.skew_nm,
                        "maximum_nm": limit.maximum_skew_nm,
                    },
                )

    @staticmethod
    def _validate_locks(
        contract: ValidationContract,
        manifest: CandidateManifest,
        add: Any,
    ) -> None:
        approved = tuple(sorted(contract.locked_object_baseline))
        declared = tuple(sorted(manifest.locked_object_baseline))
        if declared != approved:
            add(
                "LAYOUT.LOCKED.BASELINE_EXACT",
                {"approved": approved, "candidate": declared},
            )

        observed = {item.object_id: item.state_hash for item in manifest.locked_objects}
        approved_by_id = {item.object_id: item.state_hash for item in approved}
        changed = tuple(
            sorted(
                (object_id, state_hash, observed.get(object_id, "<missing>"))
                for object_id, state_hash in approved_by_id.items()
                if observed.get(object_id) != state_hash
            )
        )
        unexpected = tuple(sorted(set(observed).difference(approved_by_id)))
        if changed or unexpected:
            add(
                "LAYOUT.LOCKED.UNCHANGED",
                {"changed_or_missing": changed, "unexpected": unexpected},
            )

    @staticmethod
    def _validate_resource_budget(
        contract: ValidationContract,
        manifest: CandidateManifest,
        add: Any,
    ) -> None:
        if manifest.resource_budget != contract.resource_budget:
            add(
                "LAYOUT.RESOURCE.BUDGET_EXACT",
                {"approved": contract.resource_budget, "candidate": manifest.resource_budget},
            )
        usage = manifest.resource_usage
        budget = contract.resource_budget
        exceeded: list[tuple[str, int, int]] = []
        for name, actual, maximum in (
            ("runtime_ms", usage.runtime_ms, budget.maximum_runtime_ms),
            ("peak_memory_bytes", usage.peak_memory_bytes, budget.maximum_peak_memory_bytes),
            ("iterations", usage.iterations, budget.maximum_iterations),
        ):
            if actual > maximum:
                exceeded.append((name, actual, maximum))
        if exceeded:
            add("LAYOUT.RESOURCE.WITHIN_BUDGET", {"exceeded": tuple(exceeded)})

    @staticmethod
    def _validate_replay(
        contract: ValidationContract,
        manifest: CandidateManifest,
        replay: ReplayRecord,
        calculated_manifest_hash: str,
        calculated_replay_hash: str,
        add: Any,
    ) -> None:
        if replay.replay_hash != calculated_replay_hash:
            add(
                "LAYOUT.REPLAY.INTEGRITY",
                {"declared": replay.replay_hash, "calculated": calculated_replay_hash},
            )

        mismatches: list[str] = []
        if replay.solver != contract.solver:
            mismatches.append("solver")
        if replay.seed != contract.seed:
            mismatches.append("seed")
        if replay.source_revision != contract.source_revision:
            mismatches.append("source_revision")
        if replay.constraint_set_hash != contract.constraint_set_hash:
            mismatches.append("constraint_set_hash")
        if replay.resource_budget != contract.resource_budget:
            mismatches.append("resource_budget")
        if replay.original_manifest_hash != manifest.manifest_hash:
            mismatches.append("original_manifest_hash")
        if replay.original_manifest_hash != calculated_manifest_hash:
            mismatches.append("calculated_manifest_hash")
        if replay.objective_vector != manifest.objective_vector:
            mismatches.append("objective_vector")
        if mismatches:
            add("LAYOUT.REPLAY.INPUT_EXACT", {"mismatched_fields": tuple(sorted(mismatches))})

        if replay.candidate_graph_hash != manifest.candidate_graph_hash:
            add(
                "LAYOUT.REPLAY.CANDIDATE_HASH_MATCH",
                {
                    "candidate": manifest.candidate_graph_hash,
                    "replay": replay.candidate_graph_hash,
                },
            )


def _attestation_issues(
    attestation: TrustedValidationAttestation | None,
) -> tuple[tuple[str, str], ...]:
    if type(attestation) is not TrustedValidationAttestation:
        return (("attestation", "must be exact TrustedValidationAttestation"),)
    issues: list[tuple[str, str]] = []
    if type(attestation.schema_version) is not int or attestation.schema_version != SCHEMA_VERSION:
        issues.append(("attestation.schema_version", f"must equal {SCHEMA_VERSION}"))
    for field_name in ("authority_id", "authority_version"):
        value = getattr(attestation, field_name)
        if type(value) is not str or not value.strip():
            issues.append((f"attestation.{field_name}", "must be a non-empty string"))
    for field_name in (
        "contract_hash",
        "manifest_hash",
        "replay_hash",
        "candidate_artifact_hash",
        "replay_candidate_artifact_hash",
        "proof",
    ):
        if not _is_hash(getattr(attestation, field_name)):
            issues.append(
                (f"attestation.{field_name}", "must be a nonzero lowercase SHA-256 digest")
            )
    return tuple(issues)


def _verifier_code_constant(value: object) -> object:
    if value is None or type(value) in {str, int, bool}:
        return value
    if type(value) is bytes:
        return {"bytes": value.hex()}
    if type(value) is float:
        return {"float_hex": value.hex()}
    if type(value) is complex:
        complex_value = value
        return {"complex": (complex_value.real.hex(), complex_value.imag.hex())}
    if type(value) is tuple:
        return {
            "tuple": tuple(
                _verifier_code_constant(item) for item in cast(tuple[object, ...], value)
            )
        }
    if type(value) is frozenset:
        values = tuple(_verifier_code_constant(item) for item in cast(frozenset[object], value))
        return {
            "frozenset": tuple(
                sorted(
                    values,
                    key=lambda item: stable_hash(
                        item,
                        domain="layout-validation/code-constant-order/v1",
                    ),
                )
            )
        }
    if type(value) is CodeType:
        return {"code": _verifier_code_identity(value)}
    if value is Ellipsis:
        return {"ellipsis": True}
    raise ValueError(
        f"unsupported verifier code constant: {type(value).__module__}.{type(value).__qualname__}"
    )


def _verifier_code_identity(code: CodeType) -> dict[str, object]:
    return {
        "bytecode": code.co_code.hex(),
        "constants": tuple(_verifier_code_constant(item) for item in code.co_consts),
        "names": code.co_names,
        "varnames": code.co_varnames,
        "freevars": code.co_freevars,
        "cellvars": code.co_cellvars,
        "argcount": code.co_argcount,
        "posonlyargcount": code.co_posonlyargcount,
        "kwonlyargcount": code.co_kwonlyargcount,
        "nlocals": code.co_nlocals,
        "stacksize": code.co_stacksize,
        "flags": code.co_flags,
        "exceptiontable": code.co_exceptiontable.hex(),
    }


def _verifier_callable_literal(value: object) -> object:
    if value is None or type(value) in {str, int, bool}:
        return value
    if type(value) in {bytes, float, complex, tuple, frozenset, CodeType} or value is Ellipsis:
        return _verifier_code_constant(value)
    if isinstance(value, Enum):
        return {
            "enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": value.value,
        }
    raise ValueError(
        f"unsupported verifier closure/default: {type(value).__module__}.{type(value).__qualname__}"
    )


def _verifier_callable_identity(value: object) -> dict[str, object]:
    function_object = value.__func__ if type(value) is MethodType else value
    if type(function_object) is not FunctionType:
        raise ValueError("verifier verify implementation must be a Python function")
    function = cast(FunctionType, function_object)
    closure: list[object] = []
    for cell in function.__closure__ or ():
        try:
            cell_value = cell.cell_contents
        except ValueError:
            closure.append({"empty_cell": True})
        else:
            closure.append(_verifier_callable_literal(cell_value))
    defaults = function.__defaults__ or ()
    keyword_defaults = function.__kwdefaults__ or {}
    return {
        "module": function.__module__,
        "qualname": function.__qualname__,
        "code": _verifier_code_identity(function.__code__),
        "defaults": tuple(_verifier_callable_literal(item) for item in defaults),
        "keyword_defaults": tuple(
            (name, _verifier_callable_literal(keyword_defaults[name]))
            for name in sorted(keyword_defaults)
        ),
        "closure": tuple(closure),
    }


def _verifier_identity(
    verifier: AttestationVerifier | None,
) -> tuple[tuple[str, ...], str]:
    if verifier is None:
        return (("trusted attestation verifier is not configured",), _ZERO_HASH)
    issues: list[str] = []
    declared: dict[str, str] = {}
    for field_name in ("authority_id", "version", "code_hash"):
        try:
            value = getattr(verifier, field_name)
        except Exception as error:  # pragma: no cover - defensive trust-adapter guard
            issues.append(f"verifier {field_name} raised {type(error).__name__}")
            continue
        if field_name == "code_hash":
            valid = _is_hash(value)
        else:
            valid = type(value) is str and bool(value.strip())
        if not valid:
            issues.append(f"verifier {field_name} is invalid")
            continue
        declared[field_name] = value
    source_hash = _ZERO_HASH
    try:
        source_file = inspect.getsourcefile(type(verifier))
        if source_file is None:
            issues.append("verifier class source file is unavailable")
        else:
            source_hash = hashlib.sha256(Path(source_file).read_bytes()).hexdigest()
    except OSError as error:
        issues.append(f"verifier class source read failed: {type(error).__name__}")
    live_verify: dict[str, object] = {}
    try:
        live_verify = _verifier_callable_identity(verifier.verify)
    except (AttributeError, TypeError, ValueError) as error:
        issues.append(f"verifier live implementation is invalid: {type(error).__name__}")
    if issues:
        return (tuple(issues), _ZERO_HASH)
    identity = {
        "class": f"{type(verifier).__module__}.{type(verifier).__qualname__}",
        "module_source_sha256": source_hash,
        "declared": declared,
        "live_verify": live_verify,
    }
    return (
        (),
        stable_hash(identity, domain="layout-validation/attestation-verifier-identity/v2"),
    )


def _finish(
    findings: Iterable[ValidationFinding],
    calculated_contract_hash: str,
    calculated_manifest_hash: str,
    calculated_replay_hash: str,
    calculated_candidate_artifact_hash: str,
    calculated_replay_candidate_artifact_hash: str,
    calculated_attestation_hash: str,
    attestation_authority_id: str,
    verifier_identity_hash: str,
) -> ValidationResult:
    unique = {(finding.rule_id, finding.evidence_hash): finding for finding in findings}
    ordered = tuple(sorted(unique.values()))
    if any(item.rule_id in _INVALID_RULE_IDS for item in ordered):
        state = ValidationState.INVALID
    elif ordered:
        state = ValidationState.REJECTED
    else:
        state = ValidationState.ACCEPTED
    result = ValidationResult(
        schema_version=SCHEMA_VERSION,
        validator_version=VALIDATOR_VERSION,
        state=state,
        contract_hash=calculated_contract_hash,
        calculated_manifest_hash=calculated_manifest_hash,
        calculated_replay_hash=calculated_replay_hash,
        candidate_artifact_hash=calculated_candidate_artifact_hash,
        replay_candidate_artifact_hash=calculated_replay_candidate_artifact_hash,
        attestation_hash=calculated_attestation_hash,
        attestation_authority_id=attestation_authority_id,
        verifier_identity_hash=verifier_identity_hash,
        findings=ordered,
        result_hash="",
    )
    return replace(
        result,
        result_hash=stable_hash(result, domain="layout-validation/result/v1"),
    )


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_hash(value: Any) -> bool:
    return type(value) is str and value != _ZERO_HASH and _HASH_PATTERN.fullmatch(value) is not None


def _is_nonempty(value: Any) -> bool:
    return type(value) is str and bool(value.strip())


def _duplicates(values: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    duplicate: set[str] = set()
    for value in values:
        if value in seen:
            duplicate.add(value)
        seen.add(value)
    return tuple(sorted(duplicate))


def _schema_issues(
    contract: ValidationContract,
    manifest: CandidateManifest,
    replay: ReplayRecord,
) -> tuple[tuple[str, str], ...]:
    issues: list[tuple[str, str]] = []

    def issue(location: str, reason: str) -> None:
        issues.append((location, reason))

    def integer(location: str, value: Any, *, minimum: int = 0) -> None:
        if not _is_int(value) or value < minimum:
            issue(location, f"must be an integer >= {minimum}")

    def text(location: str, value: Any) -> None:
        if not _is_nonempty(value):
            issue(location, "must be a non-empty string")

    def digest(location: str, value: Any) -> None:
        if not _is_hash(value):
            issue(location, "must be a lowercase SHA-256 digest")

    def tuple_field(location: str, value: Any) -> bool:
        if type(value) is not tuple:
            issue(location, "must be a tuple")
            return False
        return True

    def unique(location: str, values: Iterable[str]) -> None:
        duplicates = _duplicates(values)
        if duplicates:
            issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")

    def solver(location: str, value: Any) -> None:
        if type(value) is not SolverIdentity:
            issue(location, "must be SolverIdentity")
            return
        text(f"{location}.solver_id", value.solver_id)
        text(f"{location}.version", value.version)
        digest(f"{location}.code_hash", value.code_hash)
        digest(f"{location}.config_hash", value.config_hash)

    def budget(location: str, value: Any) -> None:
        if type(value) is not ResourceBudget:
            issue(location, "must be ResourceBudget")
            return
        integer(f"{location}.maximum_runtime_ms", value.maximum_runtime_ms, minimum=1)
        integer(
            f"{location}.maximum_peak_memory_bytes",
            value.maximum_peak_memory_bytes,
            minimum=1,
        )
        integer(f"{location}.maximum_iterations", value.maximum_iterations, minimum=1)

    if type(contract) is not ValidationContract:
        issue("contract", "must be ValidationContract")
        return tuple(issues)
    if type(manifest) is not CandidateManifest:
        issue("manifest", "must be CandidateManifest")
        return tuple(issues)
    if type(replay) is not ReplayRecord:
        issue("replay", "must be ReplayRecord")
        return tuple(issues)

    for location, version in (
        ("contract.schema_version", contract.schema_version),
        ("manifest.schema_version", manifest.schema_version),
        ("replay.schema_version", replay.schema_version),
    ):
        if type(version) is not int or version != SCHEMA_VERSION:
            issue(location, f"must equal {SCHEMA_VERSION}")

    solver("contract.solver", contract.solver)
    solver("manifest.solver", manifest.solver)
    solver("replay.solver", replay.solver)
    integer("contract.seed", contract.seed)
    integer("manifest.seed", manifest.seed)
    integer("replay.seed", replay.seed)
    text("contract.source_revision", contract.source_revision)
    text("manifest.source_revision", manifest.source_revision)
    text("replay.source_revision", replay.source_revision)

    for location, value in (
        ("contract.constraint_set_hash", contract.constraint_set_hash),
        ("manifest.constraint_set_hash", manifest.constraint_set_hash),
        ("manifest.candidate_graph_hash", manifest.candidate_graph_hash),
        ("manifest.drc_report_hash", manifest.drc_report_hash),
        ("manifest.manifest_hash", manifest.manifest_hash),
        ("replay.constraint_set_hash", replay.constraint_set_hash),
        ("replay.original_manifest_hash", replay.original_manifest_hash),
        ("replay.candidate_graph_hash", replay.candidate_graph_hash),
        ("replay.replay_hash", replay.replay_hash),
    ):
        digest(location, value)

    if tuple_field("contract.hard_constraint_rule_ids", contract.hard_constraint_rule_ids):
        if not contract.hard_constraint_rule_ids:
            issue("contract.hard_constraint_rule_ids", "must not be empty")
        for index, rule_id in enumerate(contract.hard_constraint_rule_ids):
            text(f"contract.hard_constraint_rule_ids[{index}]", rule_id)
        unique("contract.hard_constraint_rule_ids", contract.hard_constraint_rule_ids)

    if tuple_field("contract.required_nets", contract.required_nets):
        if not contract.required_nets:
            issue("contract.required_nets", "must not be empty")
        for index, net_id in enumerate(contract.required_nets):
            text(f"contract.required_nets[{index}]", net_id)
        unique("contract.required_nets", contract.required_nets)

    if tuple_field("contract.locked_object_baseline", contract.locked_object_baseline):
        _check_locks("contract.locked_object_baseline", contract.locked_object_baseline, issue)
    if tuple_field("manifest.locked_object_baseline", manifest.locked_object_baseline):
        _check_locks("manifest.locked_object_baseline", manifest.locked_object_baseline, issue)
    if tuple_field("manifest.locked_objects", manifest.locked_objects):
        _check_locks("manifest.locked_objects", manifest.locked_objects, issue)

    if tuple_field("contract.net_limits", contract.net_limits):
        _check_net_limits("contract.net_limits", contract.net_limits, issue)
        if type(contract.required_nets) is tuple:
            limit_ids = tuple(
                item.net_id for item in contract.net_limits if type(item) is NetRouteLimit
            )
            if tuple(sorted(limit_ids)) != tuple(sorted(contract.required_nets)):
                issue("contract.net_limits", "must cover every required net exactly")

    if tuple_field("contract.differential_pair_limits", contract.differential_pair_limits):
        _check_pair_limits(
            "contract.differential_pair_limits",
            contract.differential_pair_limits,
            set(contract.required_nets) if type(contract.required_nets) is tuple else set(),
            issue,
        )

    budget("contract.resource_budget", contract.resource_budget)
    budget("manifest.resource_budget", manifest.resource_budget)
    budget("replay.resource_budget", replay.resource_budget)
    if type(manifest.resource_usage) is not ResourceUsage:
        issue("manifest.resource_usage", "must be ResourceUsage")
    else:
        integer("manifest.resource_usage.runtime_ms", manifest.resource_usage.runtime_ms)
        integer(
            "manifest.resource_usage.peak_memory_bytes",
            manifest.resource_usage.peak_memory_bytes,
        )
        integer("manifest.resource_usage.iterations", manifest.resource_usage.iterations)

    for location, value in (
        ("manifest.hard_constraint_check_complete", manifest.hard_constraint_check_complete),
        ("manifest.drc_check_complete", manifest.drc_check_complete),
        ("manifest.routing_check_complete", manifest.routing_check_complete),
    ):
        if type(value) is not bool:
            issue(location, "must be bool")

    if tuple_field("manifest.objective_vector", manifest.objective_vector):
        _check_objectives("manifest.objective_vector", manifest.objective_vector, issue)
    if tuple_field("replay.objective_vector", replay.objective_vector):
        _check_objectives("replay.objective_vector", replay.objective_vector, issue)

    if tuple_field("manifest.hard_constraint_results", manifest.hard_constraint_results):
        identifiers: list[str] = []
        for index, item in enumerate(manifest.hard_constraint_results):
            location = f"manifest.hard_constraint_results[{index}]"
            if type(item) is not HardConstraintResult:
                issue(location, "must be HardConstraintResult")
                continue
            text(f"{location}.rule_id", item.rule_id)
            if type(item.passed) is not bool:
                issue(f"{location}.passed", "must be bool")
            digest(f"{location}.evidence_hash", item.evidence_hash)
            identifiers.append(item.rule_id)
        unique("manifest.hard_constraint_results", identifiers)

    if tuple_field("manifest.drc_blockers", manifest.drc_blockers):
        for index, item in enumerate(manifest.drc_blockers):
            location = f"manifest.drc_blockers[{index}]"
            if type(item) is not DrcBlocker:
                issue(location, "must be DrcBlocker")
                continue
            text(f"{location}.rule_id", item.rule_id)
            digest(f"{location}.evidence_hash", item.evidence_hash)
            if tuple_field(f"{location}.object_ids", item.object_ids):
                for object_index, object_id in enumerate(item.object_ids):
                    text(f"{location}.object_ids[{object_index}]", object_id)
                unique(f"{location}.object_ids", item.object_ids)

    for location, values in (
        ("manifest.required_nets", manifest.required_nets),
        ("manifest.unrouted_required_nets", manifest.unrouted_required_nets),
    ):
        if tuple_field(location, values):
            for index, value in enumerate(values):
                text(f"{location}[{index}]", value)
            unique(location, values)
    if type(manifest.unrouted_required_nets) is tuple and type(manifest.required_nets) is tuple:
        unknown = sorted(set(manifest.unrouted_required_nets).difference(manifest.required_nets))
        if unknown:
            issue("manifest.unrouted_required_nets", "contains nets not declared as required")

    if tuple_field("manifest.route_metrics", manifest.route_metrics):
        _check_route_metrics("manifest.route_metrics", manifest.route_metrics, issue)
    if tuple_field("manifest.differential_pair_skew", manifest.differential_pair_skew):
        _check_pair_skew(
            "manifest.differential_pair_skew",
            manifest.differential_pair_skew,
            issue,
        )

    return tuple(sorted(set(issues)))


def _check_locks(location: str, values: tuple[Any, ...], issue: Any) -> None:
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not LockedObjectState:
            issue(item_location, "must be LockedObjectState")
            continue
        if not _is_nonempty(item.object_id):
            issue(f"{item_location}.object_id", "must be a non-empty string")
        if not _is_hash(item.state_hash):
            issue(f"{item_location}.state_hash", "must be a lowercase SHA-256 digest")
        identifiers.append(item.object_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")


def _check_net_limits(location: str, values: tuple[Any, ...], issue: Any) -> None:
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not NetRouteLimit:
            issue(item_location, "must be NetRouteLimit")
            continue
        if not _is_nonempty(item.net_id):
            issue(f"{item_location}.net_id", "must be a non-empty string")
        for field_name, value in (
            ("minimum_length_nm", item.minimum_length_nm),
            ("maximum_length_nm", item.maximum_length_nm),
            ("maximum_via_count", item.maximum_via_count),
        ):
            if not _is_int(value) or value < 0:
                issue(f"{item_location}.{field_name}", "must be a non-negative integer")
        if (
            _is_int(item.minimum_length_nm)
            and _is_int(item.maximum_length_nm)
            and item.minimum_length_nm > item.maximum_length_nm
        ):
            issue(item_location, "minimum length exceeds maximum length")
        identifiers.append(item.net_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")


def _check_pair_limits(
    location: str,
    values: tuple[Any, ...],
    required_nets: set[str],
    issue: Any,
) -> None:
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not DifferentialPairLimit:
            issue(item_location, "must be DifferentialPairLimit")
            continue
        for field_name, value in (
            ("pair_id", item.pair_id),
            ("positive_net_id", item.positive_net_id),
            ("negative_net_id", item.negative_net_id),
        ):
            if not _is_nonempty(value):
                issue(f"{item_location}.{field_name}", "must be a non-empty string")
        if item.positive_net_id == item.negative_net_id:
            issue(item_location, "positive and negative net IDs must differ")
        if not {item.positive_net_id, item.negative_net_id}.issubset(required_nets):
            issue(item_location, "pair nets must both be required nets")
        if not _is_int(item.maximum_skew_nm) or item.maximum_skew_nm < 0:
            issue(f"{item_location}.maximum_skew_nm", "must be a non-negative integer")
        identifiers.append(item.pair_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")


def _check_objectives(location: str, values: tuple[Any, ...], issue: Any) -> None:
    if not values:
        issue(location, "must not be empty")
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not ObjectiveValue:
            issue(item_location, "must be ObjectiveValue")
            continue
        if not _is_nonempty(item.objective_id):
            issue(f"{item_location}.objective_id", "must be a non-empty string")
        if type(item.direction) is not ObjectiveDirection:
            issue(f"{item_location}.direction", "must be ObjectiveDirection")
        if not _is_int(item.value):
            issue(f"{item_location}.value", "must be an integer")
        if not _is_nonempty(item.unit):
            issue(f"{item_location}.unit", "must be a non-empty string")
        identifiers.append(item.objective_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")


def _check_route_metrics(location: str, values: tuple[Any, ...], issue: Any) -> None:
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not NetRouteMetrics:
            issue(item_location, "must be NetRouteMetrics")
            continue
        if not _is_nonempty(item.net_id):
            issue(f"{item_location}.net_id", "must be a non-empty string")
        if not _is_int(item.length_nm) or item.length_nm < 0:
            issue(f"{item_location}.length_nm", "must be a non-negative integer")
        if not _is_int(item.via_count) or item.via_count < 0:
            issue(f"{item_location}.via_count", "must be a non-negative integer")
        identifiers.append(item.net_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")


def _check_pair_skew(location: str, values: tuple[Any, ...], issue: Any) -> None:
    identifiers: list[str] = []
    for index, item in enumerate(values):
        item_location = f"{location}[{index}]"
        if type(item) is not DifferentialPairSkew:
            issue(item_location, "must be DifferentialPairSkew")
            continue
        for field_name, value in (
            ("pair_id", item.pair_id),
            ("positive_net_id", item.positive_net_id),
            ("negative_net_id", item.negative_net_id),
        ):
            if not _is_nonempty(value):
                issue(f"{item_location}.{field_name}", "must be a non-empty string")
        if item.positive_net_id == item.negative_net_id:
            issue(item_location, "positive and negative net IDs must differ")
        if not _is_int(item.skew_nm) or item.skew_nm < 0:
            issue(f"{item_location}.skew_nm", "must be a non-negative integer")
        identifiers.append(item.pair_id)
    duplicates = _duplicates(identifiers)
    if duplicates:
        issue(location, f"contains duplicate identifiers: {','.join(duplicates)}")
