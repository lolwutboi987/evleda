"""Mandatory external trust contracts for the import-stage journal.

The journal cannot generically inspect a deployment's project store, candidate
store, approval ledger, process liveness, or rollback-resistant storage.  It
therefore refuses to operate without explicit server-owned adapters for each
of those boundaries.  Request payloads must never implement these protocols.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from contextlib import AbstractContextManager
from dataclasses import dataclass, fields
from datetime import UTC, datetime
from enum import Enum
from typing import TYPE_CHECKING, Protocol, cast, runtime_checkable

from backend.design_kernel import stable_hash
from backend.import_approval import AuthorizedImportStagingInput

if TYPE_CHECKING:
    from .models import StageOperationBinding, StageOperationState


_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


class StageTrustError(RuntimeError):
    code = "import_stage_trust_error"


class InvalidStageAttestation(StageTrustError, ValueError):
    code = "invalid_import_stage_attestation"


def _id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or _PUBLIC_ID.fullmatch(value) is None
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise InvalidStageAttestation(f"{label} must be a canonical public identifier")
    return value


def _sha(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise InvalidStageAttestation(f"{label} must be a lowercase SHA-256 digest")
    return value


def _integer(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise InvalidStageAttestation(f"{label} must be a non-negative integer")
    return value


def _time(value: object, label: str) -> datetime:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise InvalidStageAttestation(f"{label} must be timezone-aware")
    return value


def _time_text(value: datetime) -> str:
    _time(value, "attestation timestamp")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _object_attestation_digest(value: object, *, domain: str) -> str:
    material: dict[str, object] = {}
    for field in fields(value):  # type: ignore[arg-type]
        name = field.name
        if name == "attestation_sha256":
            continue
        item = getattr(value, name)
        if type(item) is datetime:
            item = _time_text(item)
        elif type(item) in {
            LeaseMode,
            TransactionDisposition,
            CandidateDisposition,
            RecoveryCause,
        }:
            item = item.value
        material[name] = item
    return stable_hash(material, domain=domain)


class LeaseMode(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    EXECUTION = "execution"
    RECOVERY = "recovery"


class TransactionDisposition(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    OPEN = "open"
    ABSENT = "absent"
    ROLLED_BACK = "rolled_back"


class CandidateDisposition(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    RESOLVED = "resolved"
    STAGED = "staged"
    INVALIDATED = "invalidated"


class RecoveryCause(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    PROCESS_RESTART = "process_restart"
    INCOMPLETE_EXECUTION_GUARD = "incomplete_execution_guard"
    SIDE_EFFECT_FAILURE = "side_effect_failure"
    AUTHORIZATION_EXPIRED = "authorization_expired"
    STALE_AUTHORITY = "stale_authority"
    OPERATOR_REQUESTED = "operator_requested"


@dataclass(frozen=True, slots=True)
class AuthorizationVerification:
    verifier_id: str
    verifier_incarnation: str
    authorization_id: str
    authorization_digest: str
    authorization_issuer_seal: str
    service_actor: str
    service_principal_sha256: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    consumption_fence_id: str
    consumption_fence_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> AuthorizationVerification:
        material = dict(values)
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material,
                domain="flux-clone-import-stage-authorization-verification-v1",
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.verifier_id, "authorization verifier ID"),
            (self.verifier_incarnation, "authorization verifier incarnation"),
            (self.authorization_id, "verified authorization ID"),
            (self.service_actor, "verified service actor"),
            (self.consumption_fence_id, "authorization consumption fence ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "verified authorization digest"),
            (self.authorization_issuer_seal, "verified authorization seal"),
            (self.service_principal_sha256, "verified service principal"),
            (self.authority_snapshot_sha256, "verified authority snapshot"),
            (
                self.principal_authority_snapshot_sha256,
                "verified principal-authority snapshot",
            ),
            (self.consumption_fence_sha256, "authorization consumption fence"),
            (self.attestation_sha256, "authorization verification attestation"),
        ):
            _sha(value, label)
        _time(self.observed_at, "authorization verification time")
        expected = _object_attestation_digest(
            self,
            domain="flux-clone-import-stage-authorization-verification-v1",
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("authorization verification digest is invalid")


@dataclass(frozen=True, slots=True)
class LiveAuthorityEvidence:
    provider_id: str
    provider_incarnation: str
    authorization_digest: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    project_id: str
    project_head: str
    project_event_head_sha256: str
    run_id: str
    run_revision: int
    run_incarnation: str
    run_event_head_sha256: str
    coordination_context_digest: str
    coordination_incarnation: str
    coordination_event_head_sha256: str
    target_store_id: str
    target_store_incarnation: str
    candidate_id: str
    candidate_sha256: str
    candidate_generation: int
    candidate_last_event_sha256: str
    candidate_disposition: CandidateDisposition
    mapping_evidence_id: str
    mapping_evidence_sha256: str
    mapping_evidence_generation: int
    mapping_evidence_last_event_sha256: str
    mapping_active: bool
    service_actor: str
    service_principal_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> LiveAuthorityEvidence:
        material = dict(values)
        for key in ("candidate_disposition",):
            value = material.get(key)
            if type(value) is CandidateDisposition:
                material[key] = value.value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-live-authority-v1"
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.provider_id, "evidence provider ID"),
            (self.provider_incarnation, "evidence provider incarnation"),
            (self.project_id, "authority project ID"),
            (self.run_id, "authority run ID"),
            (self.run_incarnation, "authority run incarnation"),
            (self.coordination_incarnation, "authority coordination incarnation"),
            (self.target_store_id, "authority target store ID"),
            (self.target_store_incarnation, "authority target store incarnation"),
            (self.candidate_id, "authority candidate ID"),
            (self.mapping_evidence_id, "authority mapping evidence ID"),
            (self.service_actor, "authority service actor"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "authority authorization digest"),
            (self.authority_snapshot_sha256, "authority snapshot digest"),
            (
                self.principal_authority_snapshot_sha256,
                "principal-authority snapshot digest",
            ),
            (self.project_head, "authority project head"),
            (self.project_event_head_sha256, "authority project event head"),
            (self.run_event_head_sha256, "authority run event head"),
            (self.coordination_context_digest, "authority coordination context"),
            (self.coordination_event_head_sha256, "authority coordination event head"),
            (self.candidate_sha256, "authority candidate digest"),
            (self.candidate_last_event_sha256, "authority candidate event"),
            (self.mapping_evidence_sha256, "authority mapping digest"),
            (self.mapping_evidence_last_event_sha256, "authority mapping event"),
            (self.service_principal_sha256, "authority service principal"),
            (self.attestation_sha256, "authority attestation digest"),
        ):
            _sha(value, label)
        _integer(self.run_revision, "authority run revision")
        _integer(self.candidate_generation, "authority candidate generation")
        _integer(self.mapping_evidence_generation, "authority mapping generation")
        if type(self.candidate_disposition) is not CandidateDisposition:
            raise InvalidStageAttestation("authority candidate disposition is invalid")
        if type(self.mapping_active) is not bool:
            raise InvalidStageAttestation("authority mapping-active fact must be boolean")
        _time(self.observed_at, "authority observation time")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-live-authority-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("live authority attestation is invalid")


@dataclass(frozen=True, slots=True)
class TransactionPreflightEvidence:
    """Trusted current transaction state queried before any callback."""

    provider_id: str
    provider_incarnation: str
    authorization_digest: str
    project_id: str
    project_head: str
    target_store_id: str
    target_store_incarnation: str
    transaction_id: str
    disposition: TransactionDisposition
    transaction_generation: int
    command_hashes: tuple[str, ...]
    commands_sha256: str
    prospective_graph_sha256: str
    preview_digest: str
    transaction_snapshot_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> TransactionPreflightEvidence:
        material = dict(values)
        disposition = material.get("disposition")
        if type(disposition) is TransactionDisposition:
            material["disposition"] = disposition.value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material,
                domain="flux-clone-import-stage-transaction-preflight-v1",
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.provider_id, "transaction-preflight provider ID"),
            (self.provider_incarnation, "transaction-preflight provider incarnation"),
            (self.project_id, "transaction-preflight project ID"),
            (self.target_store_id, "transaction-preflight target store ID"),
            (
                self.target_store_incarnation,
                "transaction-preflight target store incarnation",
            ),
            (self.transaction_id, "transaction-preflight transaction ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "transaction-preflight authorization"),
            (self.project_head, "transaction-preflight project head"),
            (self.commands_sha256, "transaction-preflight commands"),
            (self.prospective_graph_sha256, "transaction-preflight graph"),
            (self.preview_digest, "transaction-preflight preview"),
            (self.transaction_snapshot_sha256, "transaction-preflight snapshot"),
            (self.attestation_sha256, "transaction-preflight attestation"),
        ):
            _sha(value, label)
        if type(self.disposition) is not TransactionDisposition:
            raise InvalidStageAttestation("transaction-preflight disposition is invalid")
        _integer(self.transaction_generation, "transaction-preflight generation")
        if type(self.command_hashes) is not tuple or not self.command_hashes:
            raise InvalidStageAttestation("transaction-preflight commands are invalid")
        for digest in self.command_hashes:
            _sha(digest, "transaction-preflight command hash")
        if (
            self.disposition is TransactionDisposition.ABSENT
            and self.transaction_snapshot_sha256 != "0" * 64
        ):
            raise InvalidStageAttestation(
                "absent transaction preflight must use the zero snapshot"
            )
        _time(self.observed_at, "transaction-preflight observation time")
        if self.attestation_sha256 != _object_attestation_digest(
            self,
            domain="flux-clone-import-stage-transaction-preflight-v1",
        ):
            raise InvalidStageAttestation("transaction-preflight attestation is invalid")


@dataclass(frozen=True, slots=True)
class CandidatePreflightEvidence:
    """Trusted current candidate state queried before any staging callback."""

    provider_id: str
    provider_incarnation: str
    authorization_digest: str
    candidate_id: str
    candidate_sha256: str
    candidate_generation: int
    candidate_last_event_sha256: str
    disposition: CandidateDisposition
    stage_receipt_sha256: str | None
    transaction_id: str
    transaction_snapshot_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> CandidatePreflightEvidence:
        material = dict(values)
        disposition = material.get("disposition")
        if type(disposition) is CandidateDisposition:
            material["disposition"] = disposition.value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material,
                domain="flux-clone-import-stage-candidate-preflight-v1",
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.provider_id, "candidate-preflight provider ID"),
            (self.provider_incarnation, "candidate-preflight provider incarnation"),
            (self.candidate_id, "candidate-preflight candidate ID"),
            (self.transaction_id, "candidate-preflight transaction ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "candidate-preflight authorization"),
            (self.candidate_sha256, "candidate-preflight candidate digest"),
            (self.candidate_last_event_sha256, "candidate-preflight event"),
            (self.transaction_snapshot_sha256, "candidate-preflight transaction"),
            (self.attestation_sha256, "candidate-preflight attestation"),
        ):
            _sha(value, label)
        _integer(self.candidate_generation, "candidate-preflight generation")
        if type(self.disposition) is not CandidateDisposition:
            raise InvalidStageAttestation("candidate-preflight disposition is invalid")
        if self.stage_receipt_sha256 is not None:
            _sha(self.stage_receipt_sha256, "candidate-preflight stage receipt")
        if (
            self.disposition is CandidateDisposition.STAGED
        ) != (self.stage_receipt_sha256 is not None):
            raise InvalidStageAttestation(
                "candidate-preflight staged state/receipt is inconsistent"
            )
        _time(self.observed_at, "candidate-preflight observation time")
        if self.attestation_sha256 != _object_attestation_digest(
            self,
            domain="flux-clone-import-stage-candidate-preflight-v1",
        ):
            raise InvalidStageAttestation("candidate-preflight attestation is invalid")


@dataclass(frozen=True, slots=True)
class TransactionOpenEvidence:
    provider_id: str
    provider_incarnation: str
    authorization_digest: str
    project_id: str
    project_head: str
    target_store_id: str
    target_store_incarnation: str
    transaction_id: str
    transaction_generation: int
    command_hashes: tuple[str, ...]
    commands_sha256: str
    prospective_graph_sha256: str
    preview_digest: str
    transaction_snapshot_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> TransactionOpenEvidence:
        material = dict(values)
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-open-transaction-evidence-v1"
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.provider_id, "transaction provider ID"),
            (self.provider_incarnation, "transaction provider incarnation"),
            (self.project_id, "transaction project ID"),
            (self.target_store_id, "transaction target store ID"),
            (self.target_store_incarnation, "transaction target store incarnation"),
            (self.transaction_id, "transaction ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "transaction authorization digest"),
            (self.project_head, "transaction project head"),
            (self.commands_sha256, "transaction commands digest"),
            (self.prospective_graph_sha256, "transaction graph digest"),
            (self.preview_digest, "transaction preview digest"),
            (self.transaction_snapshot_sha256, "transaction snapshot digest"),
            (self.attestation_sha256, "transaction attestation digest"),
        ):
            _sha(value, label)
        _integer(self.transaction_generation, "transaction generation")
        if type(self.command_hashes) is not tuple or not self.command_hashes:
            raise InvalidStageAttestation("transaction command hashes must be non-empty")
        for digest in self.command_hashes:
            _sha(digest, "transaction command hash")
        _time(self.observed_at, "transaction observation time")
        expected = _object_attestation_digest(
            self,
            domain="flux-clone-import-stage-open-transaction-evidence-v1",
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("transaction attestation is invalid")


@dataclass(frozen=True, slots=True)
class CandidateStagedEvidence:
    provider_id: str
    provider_incarnation: str
    authorization_digest: str
    candidate_id: str
    prior_candidate_sha256: str
    prior_candidate_generation: int
    prior_candidate_last_event_sha256: str
    staged_candidate_generation: int
    staged_candidate_last_event_sha256: str
    staged_candidate_snapshot_sha256: str
    candidate_stage_receipt_sha256: str
    transaction_id: str
    transaction_snapshot_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> CandidateStagedEvidence:
        material = dict(values)
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-candidate-evidence-v1"
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.provider_id, "candidate provider ID"),
            (self.provider_incarnation, "candidate provider incarnation"),
            (self.candidate_id, "staged candidate ID"),
            (self.transaction_id, "staged candidate transaction ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "candidate authorization digest"),
            (self.prior_candidate_sha256, "prior candidate digest"),
            (self.prior_candidate_last_event_sha256, "prior candidate event"),
            (self.staged_candidate_last_event_sha256, "staged candidate event"),
            (self.staged_candidate_snapshot_sha256, "staged candidate snapshot"),
            (self.candidate_stage_receipt_sha256, "candidate stage receipt"),
            (self.transaction_snapshot_sha256, "candidate transaction snapshot"),
            (self.attestation_sha256, "candidate attestation digest"),
        ):
            _sha(value, label)
        _integer(self.prior_candidate_generation, "prior candidate generation")
        _integer(self.staged_candidate_generation, "staged candidate generation")
        _time(self.observed_at, "candidate observation time")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-candidate-evidence-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("candidate attestation is invalid")


@dataclass(frozen=True, slots=True)
class RecoveryEvidence:
    provider_id: str
    provider_incarnation: str
    operation_id: str
    authorization_digest: str
    cause: RecoveryCause
    transaction_disposition: TransactionDisposition
    candidate_disposition: CandidateDisposition
    transaction_evidence_sha256: str
    candidate_evidence_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> RecoveryEvidence:
        material = dict(values)
        for key in ("cause", "transaction_disposition", "candidate_disposition"):
            value = material.get(key)
            if type(value) in {
                RecoveryCause,
                TransactionDisposition,
                CandidateDisposition,
            }:
                material[key] = cast(
                    RecoveryCause | TransactionDisposition | CandidateDisposition,
                    value,
                ).value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-recovery-evidence-v1"
            ),
        )

    def __post_init__(self) -> None:
        _id(self.provider_id, "recovery provider ID")
        _id(self.provider_incarnation, "recovery provider incarnation")
        _id(self.operation_id, "recovery operation ID")
        for value, label in (
            (self.authorization_digest, "recovery authorization digest"),
            (self.transaction_evidence_sha256, "recovery transaction evidence"),
            (self.candidate_evidence_sha256, "recovery candidate evidence"),
            (self.attestation_sha256, "recovery attestation digest"),
        ):
            _sha(value, label)
        if type(self.cause) is not RecoveryCause:
            raise InvalidStageAttestation("recovery cause is invalid")
        if type(self.transaction_disposition) is not TransactionDisposition:
            raise InvalidStageAttestation("recovery transaction disposition is invalid")
        if type(self.candidate_disposition) is not CandidateDisposition:
            raise InvalidStageAttestation("recovery candidate disposition is invalid")
        _time(self.observed_at, "recovery observation time")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-recovery-evidence-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("recovery attestation is invalid")


@dataclass(frozen=True, slots=True)
class RollbackEvidence:
    provider_id: str
    provider_incarnation: str
    operation_id: str
    authorization_digest: str
    transaction_disposition: TransactionDisposition
    candidate_disposition: CandidateDisposition
    transaction_rollback_receipt_sha256: str
    candidate_rollback_receipt_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> RollbackEvidence:
        material = dict(values)
        for key in ("transaction_disposition", "candidate_disposition"):
            value = material.get(key)
            if type(value) in {TransactionDisposition, CandidateDisposition}:
                material[key] = cast(
                    TransactionDisposition | CandidateDisposition, value
                ).value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-rollback-evidence-v1"
            ),
        )

    def __post_init__(self) -> None:
        _id(self.provider_id, "rollback provider ID")
        _id(self.provider_incarnation, "rollback provider incarnation")
        _id(self.operation_id, "rollback operation ID")
        for value, label in (
            (self.authorization_digest, "rollback authorization digest"),
            (self.transaction_rollback_receipt_sha256, "transaction rollback receipt"),
            (self.candidate_rollback_receipt_sha256, "candidate rollback receipt"),
            (self.attestation_sha256, "rollback attestation digest"),
        ):
            _sha(value, label)
        if self.transaction_disposition not in {
            TransactionDisposition.ABSENT,
            TransactionDisposition.ROLLED_BACK,
        }:
            raise InvalidStageAttestation("rollback transaction is still open")
        if self.candidate_disposition not in {
            CandidateDisposition.RESOLVED,
            CandidateDisposition.INVALIDATED,
        }:
            raise InvalidStageAttestation("rollback candidate is still staged")
        _time(self.observed_at, "rollback observation time")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-rollback-evidence-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("rollback attestation is invalid")


@dataclass(frozen=True, slots=True)
class ExecutionLease:
    coordinator_id: str
    coordinator_incarnation: str
    lease_id: str
    operation_id: str
    session_id: str
    mode: LeaseMode
    fencing_token: int
    acquired_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> ExecutionLease:
        material = dict(values)
        mode = material.get("mode")
        if type(mode) is LeaseMode:
            material["mode"] = mode.value
        acquired = material.get("acquired_at")
        if type(acquired) is datetime:
            material["acquired_at"] = _time_text(acquired)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-exclusive-lease-v1"
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.coordinator_id, "execution coordinator ID"),
            (self.coordinator_incarnation, "execution coordinator incarnation"),
            (self.lease_id, "execution lease ID"),
            (self.operation_id, "execution lease operation ID"),
            (self.session_id, "execution lease session ID"),
        ):
            _id(value, label)
        if type(self.mode) is not LeaseMode:
            raise InvalidStageAttestation("execution lease mode is invalid")
        _integer(self.fencing_token, "execution lease fencing token")
        if self.fencing_token == 0:
            raise InvalidStageAttestation("execution lease fencing token must be positive")
        _time(self.acquired_at, "execution lease acquisition time")
        _sha(self.attestation_sha256, "execution lease attestation")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-exclusive-lease-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("execution lease attestation is invalid")


@dataclass(frozen=True, slots=True)
class ExecutionLeaseValidation:
    coordinator_id: str
    coordinator_incarnation: str
    lease_id: str
    operation_id: str
    session_id: str
    mode: LeaseMode
    fencing_token: int
    lease_attestation_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> ExecutionLeaseValidation:
        material = dict(values)
        mode = material.get("mode")
        if type(mode) is LeaseMode:
            material["mode"] = mode.value
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material,
                domain="flux-clone-import-stage-lease-validation-v1",
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.coordinator_id, "lease-validation coordinator ID"),
            (
                self.coordinator_incarnation,
                "lease-validation coordinator incarnation",
            ),
            (self.lease_id, "lease-validation lease ID"),
            (self.operation_id, "lease-validation operation ID"),
            (self.session_id, "lease-validation session ID"),
        ):
            _id(value, label)
        if type(self.mode) is not LeaseMode:
            raise InvalidStageAttestation("lease-validation mode is invalid")
        _integer(self.fencing_token, "lease-validation fencing token")
        if self.fencing_token == 0:
            raise InvalidStageAttestation(
                "lease-validation fencing token must be positive"
            )
        _sha(self.lease_attestation_sha256, "lease-validation lease attestation")
        _sha(self.attestation_sha256, "lease-validation attestation")
        _time(self.observed_at, "lease-validation observation time")
        if self.attestation_sha256 != _object_attestation_digest(
            self,
            domain="flux-clone-import-stage-lease-validation-v1",
        ):
            raise InvalidStageAttestation("lease-validation attestation is invalid")


@dataclass(frozen=True, slots=True)
class MonotonicAnchorState:
    anchor_id: str
    anchor_incarnation: str
    journal_key: str
    journal_incarnation: str
    journal_generation: int
    journal_catalog_sha256: str
    operation_id: str
    authorization_id: str
    authorization_digest: str
    identity_sha256: str
    generation: int
    journal_event_head_sha256: str
    transition_envelope_json: str
    transition_envelope_sha256: str
    observed_at: datetime
    attestation_sha256: str

    @classmethod
    def create(cls, **values: object) -> MonotonicAnchorState:
        material = dict(values)
        observed = material.get("observed_at")
        if type(observed) is datetime:
            material["observed_at"] = _time_text(observed)
        return cls(
            **values,  # type: ignore[arg-type]
            attestation_sha256=stable_hash(
                material, domain="flux-clone-import-stage-monotonic-anchor-v1"
            ),
        )

    def __post_init__(self) -> None:
        for value, label in (
            (self.anchor_id, "monotonic anchor ID"),
            (self.anchor_incarnation, "monotonic anchor incarnation"),
            (self.journal_key, "anchored journal key"),
            (self.journal_incarnation, "anchored journal incarnation"),
            (self.operation_id, "anchored operation ID"),
            (self.authorization_id, "anchored authorization ID"),
        ):
            _id(value, label)
        for value, label in (
            (self.authorization_digest, "anchored authorization digest"),
            (self.identity_sha256, "anchored identity digest"),
            (self.journal_catalog_sha256, "anchored journal catalog digest"),
            (self.journal_event_head_sha256, "anchored event head"),
            (self.transition_envelope_sha256, "anchored transition envelope"),
            (self.attestation_sha256, "monotonic anchor attestation"),
        ):
            _sha(value, label)
        if type(self.transition_envelope_json) is not str:
            raise InvalidStageAttestation(
                "anchored transition envelope must be canonical JSON text"
            )
        if hashlib.sha256(
            b"flux-clone.import-stage-journal.transition-envelope.v1\0"
            + self.transition_envelope_json.encode("utf-8")
        ).hexdigest() != self.transition_envelope_sha256:
            raise InvalidStageAttestation(
                "anchored transition envelope digest is invalid"
            )
        _integer(self.generation, "anchored generation")
        _integer(self.journal_generation, "anchored journal generation")
        _time(self.observed_at, "anchor observation time")
        expected = _object_attestation_digest(
            self, domain="flux-clone-import-stage-monotonic-anchor-v1"
        )
        if self.attestation_sha256 != expected:
            raise InvalidStageAttestation("monotonic anchor attestation is invalid")


@runtime_checkable
class StageAuthorizationVerifier(Protocol):
    verifier_id: str
    verifier_incarnation: str

    def verify_and_consume(
        self,
        authorization: AuthorizedImportStagingInput,
        *,
        service_actor: str,
    ) -> AuthorizationVerification: ...

    def verify_live(
        self, binding: StageOperationBinding
    ) -> AuthorizationVerification:
        """Reauthenticate the seal, principal, authority, and consumption fence."""

        ...


@runtime_checkable
class TrustedStageEvidenceProvider(Protocol):
    provider_id: str
    provider_incarnation: str

    def live_authority(
        self, binding: StageOperationBinding
    ) -> LiveAuthorityEvidence: ...

    def transaction_open(
        self, binding: StageOperationBinding
    ) -> TransactionOpenEvidence: ...

    def transaction_preflight(
        self, binding: StageOperationBinding
    ) -> TransactionPreflightEvidence: ...

    def candidate_staged(
        self, binding: StageOperationBinding
    ) -> CandidateStagedEvidence: ...

    def candidate_preflight(
        self, binding: StageOperationBinding
    ) -> CandidatePreflightEvidence: ...

    def recovery_state(
        self,
        binding: StageOperationBinding,
        *,
        journal_state: StageOperationState,
    ) -> RecoveryEvidence: ...

    def rollback_complete(
        self, binding: StageOperationBinding
    ) -> RollbackEvidence: ...


@runtime_checkable
class ExclusiveStageExecutionCoordinator(Protocol):
    """Cross-process lease; it must be released automatically on process death."""

    coordinator_id: str
    coordinator_incarnation: str

    def acquire(
        self,
        *,
        operation_id: str,
        session_id: str,
        mode: LeaseMode,
    ) -> AbstractContextManager[ExecutionLease]: ...

    def validate(self, lease: ExecutionLease) -> ExecutionLeaseValidation: ...


@runtime_checkable
class MonotonicStageJournalAnchor(Protocol):
    """Rollback-resistant store outside the journal database."""

    anchor_id: str
    anchor_incarnation: str

    def claim(
        self,
        *,
        journal_key: str,
        journal_incarnation: str,
        journal_generation: int,
        journal_catalog_sha256: str,
        operation_id: str,
        authorization_id: str,
        authorization_digest: str,
        identity_sha256: str,
        generation: int,
        journal_event_head_sha256: str,
        transition_envelope_json: str,
        transition_envelope_sha256: str,
    ) -> MonotonicAnchorState: ...

    def advance(
        self,
        *,
        journal_key: str,
        journal_incarnation: str,
        expected_journal_generation: int,
        journal_generation: int,
        journal_catalog_sha256: str,
        operation_id: str,
        authorization_id: str,
        authorization_digest: str,
        identity_sha256: str,
        expected_generation: int,
        generation: int,
        journal_event_head_sha256: str,
        transition_envelope_json: str,
        transition_envelope_sha256: str,
    ) -> MonotonicAnchorState: ...

    def current(self, *, operation_id: str) -> MonotonicAnchorState: ...

    def current_journal(
        self, *, journal_key: str
    ) -> MonotonicAnchorState | None: ...


__all__ = (
    "AuthorizationVerification",
    "CandidateDisposition",
    "CandidatePreflightEvidence",
    "CandidateStagedEvidence",
    "ExecutionLease",
    "ExecutionLeaseValidation",
    "ExclusiveStageExecutionCoordinator",
    "InvalidStageAttestation",
    "LeaseMode",
    "LiveAuthorityEvidence",
    "MonotonicAnchorState",
    "MonotonicStageJournalAnchor",
    "RecoveryCause",
    "RecoveryEvidence",
    "RollbackEvidence",
    "StageAuthorizationVerifier",
    "StageTrustError",
    "TransactionDisposition",
    "TransactionOpenEvidence",
    "TransactionPreflightEvidence",
    "TrustedStageEvidenceProvider",
)
