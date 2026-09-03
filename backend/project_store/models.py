"""Public immutable records for durable canonical project state."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from backend.design_kernel import DesignRevision, DesignTransaction


class ProjectStoreError(RuntimeError):
    """Base error for the durable project repository."""


class ProjectNotFound(ProjectStoreError):
    """The requested canonical project or record does not exist."""


class ProjectAlreadyExists(ProjectStoreError):
    """A project with the same canonical identifier already exists."""


class ConcurrencyConflict(ProjectStoreError):
    """Optimistic project-head or transaction-generation check failed."""


class IntegrityError(ProjectStoreError):
    """Durable bytes do not reproduce their declared canonical state."""


class StoreUnavailable(ProjectStoreError):
    """The database is temporarily unavailable for an operational reason."""


class UnsupportedStoreSchema(ProjectStoreError):
    """The database or encoded document uses an unsupported schema."""


class ApprovalDecision(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


def _require_public_id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or any(character.isspace() for character in value)
        or any(unicodedata.category(character).startswith("C") for character in value)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ValueError(f"{label} must be a non-empty canonical identifier")
    return value


def _require_digest(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


@dataclass(frozen=True, slots=True)
class ApprovalEvidence:
    """Immutable human decision bound to one exact verified release subject."""

    approval_id: str
    approval_digest: str
    transaction_id: str
    preview_digest: str
    release_subject_digest: str
    verification_report_hash: str
    decision: ApprovalDecision
    actor: str
    decided_at: datetime
    reason: str | None = None

    def __post_init__(self) -> None:
        _require_public_id(self.approval_id, "approval ID")
        _require_digest(self.approval_digest, "approval digest")
        _require_public_id(self.transaction_id, "approval transaction ID")
        _require_digest(self.preview_digest, "approval preview digest")
        _require_digest(self.release_subject_digest, "approval release subject digest")
        _require_digest(self.verification_report_hash, "approval verification report hash")
        if type(self.decision) is not ApprovalDecision:
            raise ValueError("approval decision must be ApprovalDecision")
        _require_public_id(self.actor, "approval actor")
        if (
            type(self.decided_at) is not datetime
            or self.decided_at.tzinfo is not UTC
            or self.decided_at.fold != 0
        ):
            raise ValueError("approval decision time must be an exact canonical UTC datetime")
        if self.reason is not None:
            if type(self.reason) is not str or not self.reason.strip():
                raise ValueError("approval reason must be non-empty text when present")
            if any(unicodedata.category(character).startswith("C") for character in self.reason):
                raise ValueError("approval reason cannot contain control characters")


@dataclass(frozen=True, slots=True)
class DurableCommitAttestation:
    """Persistent Ed25519 proof for one authority-consumed canonical commit."""

    schema_version: int
    scope: str
    algorithm: str
    attestation_key_id: str
    project_id: str
    base_revision: str
    head_revision: str
    parent_revision: str
    revision_hash: str
    sequence: int
    transaction_id: str
    command_hashes: tuple[str, ...]
    command_hashes_digest: str
    preview_digest: str
    verified_preview_digest: str
    prospective_graph_sha256: str
    verification_report_hash: str
    verification_input_hash: str
    verification_rule_set_hash: str
    commit_gate_passed: bool
    release_subject_digest: str
    approval_id: str
    approval_run_id: str
    approval_kind: str
    approval_digest: str
    approval_principal: str
    approval_decided_at: datetime
    approval_expires_at: datetime | None
    authorization_key_id: str
    authorization_id: str
    authorization_digest: str
    authorization_nonce: str
    authorization_issued_at: datetime
    authorization_expires_at: datetime
    authorization_consumed_at: datetime
    signature: str

    def __post_init__(self) -> None:
        if type(self) is not DurableCommitAttestation:
            raise ValueError("durable commit attestation must be the exact concrete type")
        if type(self.schema_version) is not int or self.schema_version != 1:
            raise ValueError("durable commit attestation schema version must be 1")
        for value, expected, label in (
            (self.scope, "canonical-design-durable-commit", "attestation scope"),
            (self.algorithm, "ed25519", "attestation algorithm"),
            (self.approval_kind, "release", "approval kind"),
        ):
            if type(value) is not str or value != expected:
                raise ValueError(f"{label} must be {expected!r}")
        for value, label in (
            (self.attestation_key_id, "attestation key ID"),
            (self.project_id, "attestation project ID"),
            (self.transaction_id, "attestation transaction ID"),
            (self.approval_id, "attestation approval ID"),
            (self.approval_run_id, "attestation approval run ID"),
            (self.approval_principal, "attestation approval principal"),
            (self.authorization_key_id, "attestation authorization key ID"),
            (self.authorization_id, "attestation authorization ID"),
        ):
            _require_public_id(value, label)
            if type(value) is not str:
                raise ValueError(f"{label} must be an exact string")
        for value, label in (
            (self.base_revision, "attestation base revision"),
            (self.head_revision, "attestation head revision"),
            (self.parent_revision, "attestation parent revision"),
            (self.revision_hash, "attestation revision hash"),
            (self.command_hashes_digest, "attestation ordered command digest"),
            (self.preview_digest, "attestation preview digest"),
            (self.verified_preview_digest, "attestation verified preview digest"),
            (self.prospective_graph_sha256, "attestation graph digest"),
            (self.verification_report_hash, "attestation verification report hash"),
            (self.verification_input_hash, "attestation verification input hash"),
            (self.verification_rule_set_hash, "attestation verification rule-set hash"),
            (self.release_subject_digest, "attestation release subject digest"),
            (self.approval_digest, "attestation approval digest"),
            (self.authorization_digest, "attestation authorization digest"),
            (self.authorization_nonce, "attestation authorization nonce"),
        ):
            _require_digest(value, label)
            if type(value) is not str:
                raise ValueError(f"{label} must be an exact string")
        if type(self.command_hashes) is not tuple or not self.command_hashes:
            raise ValueError("attestation command hashes must be a non-empty exact tuple")
        for command_hash in self.command_hashes:
            _require_digest(command_hash, "attestation command hash")
            if type(command_hash) is not str:
                raise ValueError("attestation command hashes must be exact strings")
        if type(self.sequence) is not int or self.sequence <= 0:
            raise ValueError("attestation sequence must be a positive exact integer")
        if type(self.commit_gate_passed) is not bool or not self.commit_gate_passed:
            raise ValueError("durable commit attestation requires an exact passing gate")
        for value, label in (
            (self.approval_decided_at, "attestation approval decision time"),
            (self.authorization_issued_at, "attestation authorization issue time"),
            (self.authorization_expires_at, "attestation authorization expiry"),
            (self.authorization_consumed_at, "attestation authorization consumption time"),
        ):
            if type(value) is not datetime or value.tzinfo is not UTC or value.fold != 0:
                raise ValueError(f"{label} must be an exact canonical UTC datetime")
        if self.approval_expires_at is not None and (
            type(self.approval_expires_at) is not datetime
            or self.approval_expires_at.tzinfo is not UTC
            or self.approval_expires_at.fold != 0
        ):
            raise ValueError("attestation approval expiry must be exact canonical UTC")
        if not (
            self.authorization_issued_at
            <= self.authorization_consumed_at
            < self.authorization_expires_at
        ):
            raise ValueError("attestation authorization consumption time is outside its lifetime")
        if self.approval_decided_at > self.authorization_consumed_at:
            raise ValueError("attestation approval was decided after authorization consumption")
        if (
            self.approval_expires_at is not None
            and self.authorization_consumed_at >= self.approval_expires_at
        ):
            raise ValueError("attestation approval expired before authorization consumption")
        if (
            type(self.signature) is not str
            or len(self.signature) != 128
            or any(character not in "0123456789abcdef" for character in self.signature)
        ):
            raise ValueError("attestation signature must be a lowercase Ed25519 signature")


@dataclass(frozen=True, slots=True)
class StoredTransaction:
    transaction: DesignTransaction
    generation: int

    def __post_init__(self) -> None:
        if type(self.transaction) is not DesignTransaction:
            raise ValueError("stored transaction must contain a DesignTransaction")
        if (
            type(self.generation) is not int
            or self.generation < 0
        ):
            raise ValueError("transaction generation must be a non-negative integer")


@dataclass(frozen=True, slots=True)
class ProjectState:
    """Complete restart-safe state; deliberately contains no filesystem path."""

    project_id: str
    head_revision: DesignRevision
    revisions: tuple[DesignRevision, ...]
    transactions: tuple[StoredTransaction, ...]
    approvals: tuple[ApprovalEvidence, ...]
    attestations: tuple[DurableCommitAttestation, ...]

    def __post_init__(self) -> None:
        _require_public_id(self.project_id, "project ID")
        if not self.revisions or self.revisions[-1] != self.head_revision:
            raise ValueError("project revisions must end at the declared head")
        if any(revision.graph.project_id != self.project_id for revision in self.revisions):
            raise ValueError("all project revisions must contain the same project ID")
        if type(self.attestations) is not tuple or any(
            type(attestation) is not DurableCommitAttestation
            for attestation in self.attestations
        ):
            raise ValueError("project attestations must be an exact immutable tuple")
        if len(self.attestations) != len(self.revisions) - 1:
            raise ValueError("every non-genesis revision requires one durable attestation")
