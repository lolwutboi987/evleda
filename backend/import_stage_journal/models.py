"""Immutable records for the durable canonical-import staging journal.

This domain records stage orchestration facts only.  It does not approve a
mapping, authenticate an approval issuer, execute a kernel command, commit a
revision, or grant manufacturing authority.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import cast

from backend.design_kernel import stable_hash
from backend.import_approval import (
    AuthorizedImportStagingInput,
    commands_sha256,
    import_preview_digest,
    prospective_revision_sha256,
)

from .trust import AuthorizationVerification

_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_OPERATION_PREFIX = "import-stage-operation-"
_VERIFIED_CAPABILITY_TOKEN = object()


class ImportStageJournalError(RuntimeError):
    """Base failure with a stable application-facing code."""

    code = "import_stage_journal_error"


class InvalidStageOperation(ImportStageJournalError, ValueError):
    code = "invalid_import_stage_operation"


class StageOperationNotFound(ImportStageJournalError):
    code = "import_stage_operation_not_found"


class StageOperationConcurrencyConflict(ImportStageJournalError):
    code = "import_stage_operation_revision_conflict"


class StageOperationEvidenceMismatch(ImportStageJournalError):
    code = "import_stage_operation_evidence_mismatch"


class StageOperationReplayError(ImportStageJournalError):
    code = "import_stage_operation_replay"


class StageOperationExpired(ImportStageJournalError):
    code = "import_stage_operation_expired"


class StageOperationRecoveryRequired(ImportStageJournalError):
    code = "import_stage_operation_recovery_required"


class IllegalStageOperationTransition(ImportStageJournalError):
    code = "illegal_import_stage_operation_transition"


class StageOperationIntegrityError(ImportStageJournalError):
    code = "import_stage_journal_integrity_error"


class StageJournalUnavailable(ImportStageJournalError):
    code = "import_stage_journal_unavailable"


class UnsupportedStageJournalSchema(ImportStageJournalError):
    code = "import_stage_journal_schema_unsupported"


class StageOperationState(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    """Monotonic orchestration states for one use of one authorization."""

    PREPARED = "prepared"
    TRANSACTION_OPEN_STARTED = "transaction_open_started"
    TRANSACTION_OPEN = "transaction_open"
    CANDIDATE_STAGE_STARTED = "candidate_stage_started"
    CANDIDATE_STAGED = "candidate_staged"
    SIDE_EFFECT_UNCERTAIN = "side_effect_uncertain"
    RECOVERY_REQUIRED = "recovery_required"
    ROLLBACK_STARTED = "rollback_started"
    ROLLED_BACK = "rolled_back"


class StageOperationEventKind(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    PREPARED = "prepared"
    TRANSACTION_OPEN_STARTED = "transaction_open_started"
    TRANSACTION_OPENED = "transaction_opened"
    CANDIDATE_STAGE_STARTED = "candidate_stage_started"
    CANDIDATE_STAGED = "candidate_staged"
    SIDE_EFFECT_UNCERTAIN = "side_effect_uncertain"
    RECOVERY_REQUIRED = "recovery_required"
    ROLLBACK_STARTED = "rollback_started"
    ROLLBACK_COMPLETED = "rollback_completed"


class StageRecoveryReason(str, Enum):  # noqa: UP042 - stable wire-compatible Enum
    PROCESS_RESTART = "process_restart"
    SIDE_EFFECT_FAILURE = "side_effect_failure"
    STALE_BINDING = "stale_binding"
    AUTHORIZATION_EXPIRED = "authorization_expired"
    OPERATOR_REQUESTED = "operator_requested"


def require_public_id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or _PUBLIC_ID.fullmatch(value) is None
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise InvalidStageOperation(f"{label} must be a canonical public identifier")
    return value


def require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise InvalidStageOperation(f"{label} must be a lowercase SHA-256 digest")
    return value


def require_nonnegative_int(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise InvalidStageOperation(f"{label} must be a non-negative integer")
    return value


def require_time(value: object, label: str) -> datetime:
    if (
        type(value) is not datetime
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise InvalidStageOperation(f"{label} must be timezone-aware")
    return value


def time_text(value: datetime) -> str:
    require_time(value, "timestamp")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def operation_id_for(authorization_digest: str) -> str:
    require_sha256(authorization_digest, "authorization digest")
    return f"{_OPERATION_PREFIX}{authorization_digest[:32]}"


@dataclass(frozen=True, slots=True)
class StageOperationBinding:
    """Every immutable fact bound before the first possible side effect."""

    operation_id: str
    authorization_id: str
    authorization_digest: str
    authorization_issuer_id: str
    authorization_issuer_seal: str
    authorization_request_id: str
    authorization_request_digest: str
    authorization_subject_digest: str
    mapping_approval_id: str
    mapping_approval_digest: str
    project_id: str
    expected_head: str
    run_id: str
    run_revision: int
    coordination_incarnation: str
    coordination_context_digest: str
    candidate_id: str
    candidate_sha256: str
    candidate_generation: int
    candidate_last_event_sha256: str
    mapping_evidence_id: str
    mapping_evidence_sha256: str
    mapping_evidence_generation: int
    mapping_evidence_last_event_sha256: str
    canonical_candidate_sha256: str
    mapper_result_sha256: str
    source_snapshot_sha256: str
    transaction_id: str
    command_hashes: tuple[str, ...]
    commands_sha256: str
    prospective_graph_sha256: str
    prospective_revision_sha256: str
    preview_digest: str
    review_manifest_sha256: str
    approval_operation_key: str
    uploader_actor: str
    authorized_human_actor: str
    mapping_command_actor: str
    staging_service_actor: str
    uploader_principal_sha256: str
    reviewer_principal_sha256: str
    mapper_principal_sha256: str
    staging_service_principal_sha256: str
    project_event_head_sha256: str
    run_incarnation: str
    run_event_head_sha256: str
    coordination_event_head_sha256: str
    target_store_id: str
    target_store_incarnation: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    authorization_verifier_id: str
    authorization_verifier_incarnation: str
    authorization_verification_sha256: str
    authorization_consumption_fence_id: str
    authorization_consumption_fence_sha256: str
    evidence_provider_id: str
    evidence_provider_incarnation: str
    execution_coordinator_id: str
    execution_coordinator_incarnation: str
    monotonic_anchor_id: str
    monotonic_anchor_incarnation: str
    journal_key: str
    journal_incarnation: str
    service_actor: str
    candidate_stage_receipt_sha256: str
    authorization_issued_at: datetime
    authorization_expires_at: datetime
    prepared_at: datetime
    owner_session_id: str
    authorization_lifecycle_generation: int = 2
    scope: str = "mapping-to-canonical-stage"
    authorizes_internal_commit: bool = False
    authorizes_manufacturing_release: bool = False

    def __post_init__(self) -> None:
        for value, label in (
            (self.operation_id, "stage operation ID"),
            (self.authorization_id, "stage authorization ID"),
            (self.authorization_issuer_id, "authorization issuer ID"),
            (self.authorization_request_id, "authorization request ID"),
            (self.mapping_approval_id, "mapping approval ID"),
            (self.project_id, "project ID"),
            (self.run_id, "run ID"),
            (self.coordination_incarnation, "coordination incarnation"),
            (self.candidate_id, "candidate ID"),
            (self.mapping_evidence_id, "mapping evidence ID"),
            (self.transaction_id, "transaction ID"),
            (self.approval_operation_key, "approval operation key"),
            (self.uploader_actor, "uploader actor"),
            (self.authorized_human_actor, "authorized human actor"),
            (self.mapping_command_actor, "mapping command actor"),
            (self.staging_service_actor, "authorized staging service actor"),
            (self.run_incarnation, "run incarnation"),
            (self.target_store_id, "target store ID"),
            (self.target_store_incarnation, "target store incarnation"),
            (self.authorization_verifier_id, "authorization verifier ID"),
            (
                self.authorization_verifier_incarnation,
                "authorization verifier incarnation",
            ),
            (
                self.authorization_consumption_fence_id,
                "authorization consumption fence ID",
            ),
            (self.evidence_provider_id, "stage evidence provider ID"),
            (
                self.evidence_provider_incarnation,
                "stage evidence provider incarnation",
            ),
            (self.execution_coordinator_id, "execution coordinator ID"),
            (
                self.execution_coordinator_incarnation,
                "execution coordinator incarnation",
            ),
            (self.monotonic_anchor_id, "monotonic anchor ID"),
            (self.monotonic_anchor_incarnation, "monotonic anchor incarnation"),
            (self.journal_key, "stage journal key"),
            (self.journal_incarnation, "stage journal incarnation"),
            (self.service_actor, "stage service actor"),
            (self.owner_session_id, "journal owner session ID"),
        ):
            require_public_id(value, label)
        for value, label in (
            (self.authorization_digest, "authorization digest"),
            (self.authorization_issuer_seal, "authorization issuer seal"),
            (self.authorization_request_digest, "authorization request digest"),
            (self.authorization_subject_digest, "authorization subject digest"),
            (self.mapping_approval_digest, "mapping approval digest"),
            (self.expected_head, "expected project head"),
            (self.coordination_context_digest, "coordination context digest"),
            (self.candidate_sha256, "candidate digest"),
            (self.candidate_last_event_sha256, "candidate event digest"),
            (self.mapping_evidence_sha256, "mapping evidence digest"),
            (
                self.mapping_evidence_last_event_sha256,
                "mapping evidence event digest",
            ),
            (self.canonical_candidate_sha256, "canonical candidate digest"),
            (self.mapper_result_sha256, "mapper result digest"),
            (self.source_snapshot_sha256, "approval source snapshot digest"),
            (self.commands_sha256, "commands digest"),
            (self.prospective_graph_sha256, "prospective graph digest"),
            (self.prospective_revision_sha256, "prospective revision digest"),
            (self.preview_digest, "preview digest"),
            (self.review_manifest_sha256, "review manifest digest"),
            (self.uploader_principal_sha256, "uploader principal digest"),
            (self.reviewer_principal_sha256, "reviewer principal digest"),
            (self.mapper_principal_sha256, "mapper principal digest"),
            (
                self.staging_service_principal_sha256,
                "staging service principal digest",
            ),
            (self.project_event_head_sha256, "project event head"),
            (self.run_event_head_sha256, "run event head"),
            (self.coordination_event_head_sha256, "coordination event head"),
            (self.authority_snapshot_sha256, "authority snapshot digest"),
            (
                self.principal_authority_snapshot_sha256,
                "principal-authority snapshot digest",
            ),
            (
                self.authorization_verification_sha256,
                "authorization verification attestation",
            ),
            (
                self.authorization_consumption_fence_sha256,
                "authorization consumption fence digest",
            ),
            (self.candidate_stage_receipt_sha256, "candidate stage receipt digest"),
        ):
            require_sha256(value, label)
        for value, label in (
            (self.run_revision, "run revision"),
            (self.candidate_generation, "candidate generation"),
            (self.mapping_evidence_generation, "mapping evidence generation"),
        ):
            require_nonnegative_int(value, label)
        if self.authorization_lifecycle_generation != 2:
            raise InvalidStageOperation("stage authorization must be lifecycle generation two")
        if self.scope != "mapping-to-canonical-stage":
            raise InvalidStageOperation("stage operation scope must be stage-only")
        if self.authorizes_internal_commit is not False:
            raise InvalidStageOperation("stage operation cannot authorize commit")
        if self.authorizes_manufacturing_release is not False:
            raise InvalidStageOperation("stage operation cannot authorize manufacturing")
        if self.service_actor != self.staging_service_actor:
            raise InvalidStageOperation(
                "journal service actor must match the sealed staging service actor"
            )
        if self.service_actor in {
            self.authorized_human_actor,
            self.mapping_command_actor,
        }:
            raise InvalidStageOperation(
                "stage service actor must be separate from human and mapping actors"
            )
        issued_at = require_time(self.authorization_issued_at, "authorization issue time")
        expires_at = require_time(
            self.authorization_expires_at, "authorization expiry"
        )
        prepared_at = require_time(self.prepared_at, "preparation time")
        if not issued_at <= prepared_at < expires_at:
            raise InvalidStageOperation(
                "PREPARED must be recorded while the authorization is live"
            )
        if type(self.command_hashes) is not tuple or not self.command_hashes:
            raise InvalidStageOperation("ordered command hashes must be a non-empty tuple")
        for command_hash in self.command_hashes:
            require_sha256(command_hash, "command hash")
        if commands_sha256(self.command_hashes) != self.commands_sha256:
            raise InvalidStageOperation("commands digest does not bind ordered commands")
        if import_preview_digest(
            base_revision=self.expected_head,
            transaction_id=self.transaction_id,
            prospective_graph_sha256=self.prospective_graph_sha256,
            command_hashes=self.command_hashes,
        ) != self.preview_digest:
            raise InvalidStageOperation("preview digest does not bind this transaction")
        if prospective_revision_sha256(
            project_id=self.project_id,
            base_revision=self.expected_head,
            prospective_graph_sha256=self.prospective_graph_sha256,
            commands_digest=self.commands_sha256,
            preview_digest=self.preview_digest,
        ) != self.prospective_revision_sha256:
            raise InvalidStageOperation("prospective revision digest is inconsistent")
        if operation_id_for(self.authorization_digest) != self.operation_id:
            raise InvalidStageOperation("stage operation ID must derive from authorization")
        if self.authorization_id != (
            f"import-stage-authorization-{self.authorization_digest[:32]}"
        ):
            raise InvalidStageOperation("authorization ID does not derive from its digest")
        expected_authorization = stable_hash(
            {
                "issuer_id": self.authorization_issuer_id,
                "request_id": self.authorization_request_id,
                "request_digest": self.authorization_request_digest,
                "subject_digest": self.authorization_subject_digest,
                "mapping_approval_id": self.mapping_approval_id,
                "mapping_approval_digest": self.mapping_approval_digest,
                "candidate_id": self.candidate_id,
                "candidate_sha256": self.candidate_sha256,
                "candidate_generation": self.candidate_generation,
                "candidate_last_event_sha256": self.candidate_last_event_sha256,
                "mapping_evidence_id": self.mapping_evidence_id,
                "mapping_evidence_sha256": self.mapping_evidence_sha256,
                "mapping_evidence_generation": self.mapping_evidence_generation,
                "mapping_evidence_last_event_sha256": (
                    self.mapping_evidence_last_event_sha256
                ),
                "canonical_candidate_sha256": self.canonical_candidate_sha256,
                "mapper_result_sha256": self.mapper_result_sha256,
                "source_snapshot_sha256": self.source_snapshot_sha256,
                "project_id": self.project_id,
                "base_revision": self.expected_head,
                "prospective_graph_sha256": self.prospective_graph_sha256,
                "prospective_revision_sha256": self.prospective_revision_sha256,
                "transaction_id": self.transaction_id,
                "command_hashes": self.command_hashes,
                "commands_sha256": self.commands_sha256,
                "preview_digest": self.preview_digest,
                "review_manifest_sha256": self.review_manifest_sha256,
                "operation_key": self.approval_operation_key,
                "uploader_actor": self.uploader_actor,
                "authorized_human_actor": self.authorized_human_actor,
                "mapping_command_actor": self.mapping_command_actor,
                "staging_service_actor": self.staging_service_actor,
                "uploader_principal_sha256": self.uploader_principal_sha256,
                "reviewer_principal_sha256": self.reviewer_principal_sha256,
                "mapper_principal_sha256": self.mapper_principal_sha256,
                "staging_service_principal_sha256": (
                    self.staging_service_principal_sha256
                ),
                "run_id": self.run_id,
                "run_revision": self.run_revision,
                "project_event_head_sha256": self.project_event_head_sha256,
                "run_incarnation": self.run_incarnation,
                "run_event_head_sha256": self.run_event_head_sha256,
                "coordination_incarnation": self.coordination_incarnation,
                "coordination_context_digest": self.coordination_context_digest,
                "coordination_event_head_sha256": (
                    self.coordination_event_head_sha256
                ),
                "target_store_id": self.target_store_id,
                "target_store_incarnation": self.target_store_incarnation,
                "authority_snapshot_sha256": self.authority_snapshot_sha256,
                "principal_authority_snapshot_sha256": (
                    self.principal_authority_snapshot_sha256
                ),
                "issued_at": time_text(self.authorization_issued_at),
                "expires_at": time_text(self.authorization_expires_at),
                "lifecycle_generation": self.authorization_lifecycle_generation,
                "scope": self.scope,
                "authorizes_internal_commit": self.authorizes_internal_commit,
                "authorizes_manufacturing_release": (
                    self.authorizes_manufacturing_release
                ),
                "commit_approval_id": None,
                "release_approval_id": None,
            },
            domain="flux-clone-authorized-import-staging-input-v1",
        )
        if expected_authorization != self.authorization_digest:
            raise InvalidStageOperation(
                "stage operation does not reproduce the sealed authorization digest"
            )
        expected_receipt = stable_hash(
            {
                "operation_id": self.operation_id,
                "authorization_id": self.authorization_id,
                "authorization_digest": self.authorization_digest,
                "project_id": self.project_id,
                "expected_head": self.expected_head,
                "target_store_id": self.target_store_id,
                "target_store_incarnation": self.target_store_incarnation,
                "candidate_id": self.candidate_id,
                "candidate_sha256": self.candidate_sha256,
                "candidate_generation": self.candidate_generation,
                "candidate_last_event_sha256": self.candidate_last_event_sha256,
                "mapping_evidence_id": self.mapping_evidence_id,
                "mapping_evidence_sha256": self.mapping_evidence_sha256,
                "mapping_evidence_generation": self.mapping_evidence_generation,
                "mapping_evidence_last_event_sha256": (
                    self.mapping_evidence_last_event_sha256
                ),
                "source_snapshot_sha256": self.source_snapshot_sha256,
                "principal_authority_snapshot_sha256": (
                    self.principal_authority_snapshot_sha256
                ),
                "transaction_id": self.transaction_id,
                "command_hashes": self.command_hashes,
                "commands_sha256": self.commands_sha256,
                "prospective_graph_sha256": self.prospective_graph_sha256,
                "preview_digest": self.preview_digest,
                "service_actor": self.service_actor,
                "staging_service_principal_sha256": (
                    self.staging_service_principal_sha256
                ),
                "authorization_verifier_id": self.authorization_verifier_id,
                "authorization_verifier_incarnation": (
                    self.authorization_verifier_incarnation
                ),
                "authorization_verification_sha256": (
                    self.authorization_verification_sha256
                ),
                "authorization_consumption_fence_id": (
                    self.authorization_consumption_fence_id
                ),
                "authorization_consumption_fence_sha256": (
                    self.authorization_consumption_fence_sha256
                ),
                "evidence_provider_id": self.evidence_provider_id,
                "evidence_provider_incarnation": self.evidence_provider_incarnation,
                "execution_coordinator_id": self.execution_coordinator_id,
                "execution_coordinator_incarnation": (
                    self.execution_coordinator_incarnation
                ),
                "monotonic_anchor_id": self.monotonic_anchor_id,
                "monotonic_anchor_incarnation": self.monotonic_anchor_incarnation,
                "journal_key": self.journal_key,
                "journal_incarnation": self.journal_incarnation,
            },
            domain="flux-clone-import-stage-candidate-receipt-v1",
        )
        if expected_receipt != self.candidate_stage_receipt_sha256:
            raise InvalidStageOperation("candidate stage receipt binding is inconsistent")

    @classmethod
    def from_authorization(
        cls,
        authorization: AuthorizedImportStagingInput,
        *,
        service_actor: str,
        verification: AuthorizationVerification,
        evidence_provider_id: str,
        evidence_provider_incarnation: str,
        execution_coordinator_id: str,
        execution_coordinator_incarnation: str,
        monotonic_anchor_id: str,
        monotonic_anchor_incarnation: str,
        journal_key: str,
        journal_incarnation: str,
        prepared_at: datetime,
        owner_session_id: str,
    ) -> StageOperationBinding:
        if type(authorization) is not AuthorizedImportStagingInput:
            raise InvalidStageOperation(
                "preparation requires AuthorizedImportStagingInput"
            )
        if type(verification) is not AuthorizationVerification:
            raise InvalidStageOperation(
                "preparation requires trusted authorization verification"
            )
        if (
            verification.authorization_id != authorization.authorization_id
            or verification.authorization_digest != authorization.authorization_digest
            or verification.authorization_issuer_seal != authorization.issuer_seal
            or verification.service_actor != service_actor
            or verification.service_principal_sha256
            != authorization.staging_service_principal_sha256
            or verification.authority_snapshot_sha256
            != authorization.authority_snapshot_sha256
            or verification.principal_authority_snapshot_sha256
            != authorization.principal_authority_snapshot_sha256
        ):
            raise InvalidStageOperation(
                "authorization verification does not bind the exact sealed input"
            )
        operation_id = operation_id_for(authorization.authorization_digest)
        receipt = stable_hash(
            {
                "operation_id": operation_id,
                "authorization_id": authorization.authorization_id,
                "authorization_digest": authorization.authorization_digest,
                "project_id": authorization.project_id,
                "expected_head": authorization.base_revision,
                "target_store_id": authorization.target_store_id,
                "target_store_incarnation": authorization.target_store_incarnation,
                "candidate_id": authorization.candidate_id,
                "candidate_sha256": authorization.candidate_sha256,
                "candidate_generation": authorization.candidate_generation,
                "candidate_last_event_sha256": (
                    authorization.candidate_last_event_sha256
                ),
                "mapping_evidence_id": authorization.mapping_evidence_id,
                "mapping_evidence_sha256": authorization.mapping_evidence_sha256,
                "mapping_evidence_generation": (
                    authorization.mapping_evidence_generation
                ),
                "mapping_evidence_last_event_sha256": (
                    authorization.mapping_evidence_last_event_sha256
                ),
                "source_snapshot_sha256": authorization.source_snapshot_sha256,
                "transaction_id": authorization.transaction_id,
                "command_hashes": authorization.command_hashes,
                "commands_sha256": authorization.commands_sha256,
                "prospective_graph_sha256": authorization.prospective_graph_sha256,
                "preview_digest": authorization.preview_digest,
                "service_actor": service_actor,
                "staging_service_principal_sha256": (
                    authorization.staging_service_principal_sha256
                ),
                "authorization_verifier_id": verification.verifier_id,
                "authorization_verifier_incarnation": (
                    verification.verifier_incarnation
                ),
                "authorization_verification_sha256": (
                    verification.attestation_sha256
                ),
                "authorization_consumption_fence_id": (
                    verification.consumption_fence_id
                ),
                "authorization_consumption_fence_sha256": (
                    verification.consumption_fence_sha256
                ),
                "evidence_provider_id": evidence_provider_id,
                "evidence_provider_incarnation": evidence_provider_incarnation,
                "execution_coordinator_id": execution_coordinator_id,
                "execution_coordinator_incarnation": (
                    execution_coordinator_incarnation
                ),
                "monotonic_anchor_id": monotonic_anchor_id,
                "monotonic_anchor_incarnation": monotonic_anchor_incarnation,
                "journal_key": journal_key,
                "journal_incarnation": journal_incarnation,
                "principal_authority_snapshot_sha256": (
                    authorization.principal_authority_snapshot_sha256
                ),
            },
            domain="flux-clone-import-stage-candidate-receipt-v1",
        )
        return cls(
            operation_id=operation_id,
            authorization_id=authorization.authorization_id,
            authorization_digest=authorization.authorization_digest,
            authorization_issuer_id=authorization.issuer_id,
            authorization_issuer_seal=authorization.issuer_seal,
            authorization_request_id=authorization.request_id,
            authorization_request_digest=authorization.request_digest,
            authorization_subject_digest=authorization.subject_digest,
            mapping_approval_id=authorization.mapping_approval_id,
            mapping_approval_digest=authorization.mapping_approval_digest,
            project_id=authorization.project_id,
            expected_head=authorization.base_revision,
            run_id=authorization.run_id,
            run_revision=authorization.run_revision,
            coordination_incarnation=authorization.coordination_incarnation,
            coordination_context_digest=authorization.coordination_context_digest,
            candidate_id=authorization.candidate_id,
            candidate_sha256=authorization.candidate_sha256,
            candidate_generation=authorization.candidate_generation,
            candidate_last_event_sha256=authorization.candidate_last_event_sha256,
            mapping_evidence_id=authorization.mapping_evidence_id,
            mapping_evidence_sha256=authorization.mapping_evidence_sha256,
            mapping_evidence_generation=authorization.mapping_evidence_generation,
            mapping_evidence_last_event_sha256=(
                authorization.mapping_evidence_last_event_sha256
            ),
            canonical_candidate_sha256=authorization.canonical_candidate_sha256,
            mapper_result_sha256=authorization.mapper_result_sha256,
            source_snapshot_sha256=authorization.source_snapshot_sha256,
            transaction_id=authorization.transaction_id,
            command_hashes=authorization.command_hashes,
            commands_sha256=authorization.commands_sha256,
            prospective_graph_sha256=authorization.prospective_graph_sha256,
            prospective_revision_sha256=authorization.prospective_revision_sha256,
            preview_digest=authorization.preview_digest,
            review_manifest_sha256=authorization.review_manifest_sha256,
            approval_operation_key=authorization.operation_key,
            uploader_actor=authorization.uploader_actor,
            authorized_human_actor=authorization.authorized_human_actor,
            mapping_command_actor=authorization.mapping_command_actor,
            staging_service_actor=authorization.staging_service_actor,
            uploader_principal_sha256=authorization.uploader_principal_sha256,
            reviewer_principal_sha256=authorization.reviewer_principal_sha256,
            mapper_principal_sha256=authorization.mapper_principal_sha256,
            staging_service_principal_sha256=(
                authorization.staging_service_principal_sha256
            ),
            project_event_head_sha256=authorization.project_event_head_sha256,
            run_incarnation=authorization.run_incarnation,
            run_event_head_sha256=authorization.run_event_head_sha256,
            coordination_event_head_sha256=(
                authorization.coordination_event_head_sha256
            ),
            target_store_id=authorization.target_store_id,
            target_store_incarnation=authorization.target_store_incarnation,
            authority_snapshot_sha256=authorization.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                authorization.principal_authority_snapshot_sha256
            ),
            authorization_verifier_id=verification.verifier_id,
            authorization_verifier_incarnation=verification.verifier_incarnation,
            authorization_verification_sha256=verification.attestation_sha256,
            authorization_consumption_fence_id=verification.consumption_fence_id,
            authorization_consumption_fence_sha256=(
                verification.consumption_fence_sha256
            ),
            evidence_provider_id=evidence_provider_id,
            evidence_provider_incarnation=evidence_provider_incarnation,
            execution_coordinator_id=execution_coordinator_id,
            execution_coordinator_incarnation=execution_coordinator_incarnation,
            monotonic_anchor_id=monotonic_anchor_id,
            monotonic_anchor_incarnation=monotonic_anchor_incarnation,
            journal_key=journal_key,
            journal_incarnation=journal_incarnation,
            service_actor=service_actor,
            candidate_stage_receipt_sha256=receipt,
            authorization_issued_at=authorization.issued_at,
            authorization_expires_at=authorization.expires_at,
            prepared_at=prepared_at,
            owner_session_id=owner_session_id,
            authorization_lifecycle_generation=authorization.lifecycle_generation,
            scope=authorization.scope.value,
            authorizes_internal_commit=authorization.authorizes_internal_commit,
            authorizes_manufacturing_release=(
                authorization.authorizes_manufacturing_release
            ),
        )


@dataclass(frozen=True, slots=True)
class StageOperationEvent:
    operation_id: str
    sequence: int
    transition_id: str
    kind: StageOperationEventKind
    from_state: StageOperationState | None
    to_state: StageOperationState
    actor: str
    occurred_at: datetime
    request_sha256: str
    payload_sha256: str
    previous_event_sha256: str
    event_sha256: str
    payload: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class StageOperation:
    binding: StageOperationBinding
    state: StageOperationState
    generation: int
    last_event_sha256: str
    updated_at: datetime
    events: tuple[StageOperationEvent, ...]
    journal_generation: int
    journal_catalog_sha256: str
    journal_anchor_attestation_sha256: str

    def recovery_only_in(self, session_id: str) -> bool:
        """Whether this journal session is forbidden from forward progress."""

        require_public_id(session_id, "journal session ID")
        return (
            self.state
            in {
                StageOperationState.PREPARED,
                StageOperationState.TRANSACTION_OPEN_STARTED,
                StageOperationState.TRANSACTION_OPEN,
                StageOperationState.CANDIDATE_STAGE_STARTED,
                StageOperationState.SIDE_EFFECT_UNCERTAIN,
                StageOperationState.ROLLBACK_STARTED,
            }
            and session_id != self.binding.owner_session_id
        )

    @property
    def grants_commit_authority(self) -> bool:
        return False

    @property
    def grants_manufacturing_authority(self) -> bool:
        return False

    @property
    def completed_stage_receipt(self) -> CompletedStageReceipt | None:
        """Return unauthenticated audit data for the recorded outcome.

        The candidate correlation receipt in the immutable binding is safe to
        write into the candidate before this event exists.  Neither that digest
        nor this raw record is authority; the issuing journal must authenticate
        it against live effects and issue a verified capability.
        """

        if self.state is not StageOperationState.CANDIDATE_STAGED:
            return None
        opened = next(
            (
                event
                for event in self.events
                if event.kind is StageOperationEventKind.TRANSACTION_OPENED
            ),
            None,
        )
        staged = next(
            (
                event
                for event in self.events
                if event.kind is StageOperationEventKind.CANDIDATE_STAGED
            ),
            None,
        )
        if opened is None or staged is None:
            return None
        candidate_evidence = staged.payload.get("candidate_evidence")
        if type(candidate_evidence) is not dict:
            return None
        candidate_evidence = cast(dict[str, object], candidate_evidence)
        generation = candidate_evidence.get("staged_candidate_generation")
        last_event = candidate_evidence.get("staged_candidate_last_event_sha256")
        provider_attestation = candidate_evidence.get("attestation_sha256")
        if (
            type(generation) is not int
            or type(last_event) is not str
            or type(provider_attestation) is not str
        ):
            # A restored operation has already passed repository integrity
            # verification.  This guard keeps manually-created records closed.
            return None
        material = {
            "operation_id": self.binding.operation_id,
            "authorization_id": self.binding.authorization_id,
            "authorization_digest": self.binding.authorization_digest,
            "candidate_stage_receipt_sha256": (
                self.binding.candidate_stage_receipt_sha256
            ),
            "transaction_id": self.binding.transaction_id,
            "transaction_open_event_sha256": opened.event_sha256,
            "candidate_staged_event_sha256": staged.event_sha256,
            "candidate_provider_attestation_sha256": provider_attestation,
            "evidence_provider_id": self.binding.evidence_provider_id,
            "evidence_provider_incarnation": (
                self.binding.evidence_provider_incarnation
            ),
            "staged_candidate_generation": generation,
            "staged_candidate_last_event_sha256": last_event,
            "completed_at": time_text(staged.occurred_at),
            "journal_generation": self.generation,
            "journal_event_head_sha256": self.last_event_sha256,
            "journal_state": self.state.value,
            "journal_catalog_generation": self.journal_generation,
            "journal_catalog_sha256": self.journal_catalog_sha256,
            "journal_anchor_attestation_sha256": (
                self.journal_anchor_attestation_sha256
            ),
            "monotonic_anchor_id": self.binding.monotonic_anchor_id,
            "monotonic_anchor_incarnation": (
                self.binding.monotonic_anchor_incarnation
            ),
            "journal_key": self.binding.journal_key,
            "journal_incarnation": self.binding.journal_incarnation,
            "authorizes_internal_commit": False,
            "authorizes_manufacturing_release": False,
        }
        return CompletedStageReceipt(
            operation_id=self.binding.operation_id,
            authorization_id=self.binding.authorization_id,
            authorization_digest=self.binding.authorization_digest,
            candidate_stage_receipt_sha256=(
                self.binding.candidate_stage_receipt_sha256
            ),
            transaction_id=self.binding.transaction_id,
            transaction_open_event_sha256=opened.event_sha256,
            candidate_staged_event_sha256=staged.event_sha256,
            candidate_provider_attestation_sha256=provider_attestation,
            evidence_provider_id=self.binding.evidence_provider_id,
            evidence_provider_incarnation=self.binding.evidence_provider_incarnation,
            staged_candidate_generation=generation,
            staged_candidate_last_event_sha256=last_event,
            completed_at=staged.occurred_at,
            journal_generation=self.generation,
            journal_event_head_sha256=self.last_event_sha256,
            journal_state=self.state,
            journal_catalog_generation=self.journal_generation,
            journal_catalog_sha256=self.journal_catalog_sha256,
            journal_anchor_attestation_sha256=(
                self.journal_anchor_attestation_sha256
            ),
            monotonic_anchor_id=self.binding.monotonic_anchor_id,
            monotonic_anchor_incarnation=self.binding.monotonic_anchor_incarnation,
            journal_key=self.binding.journal_key,
            journal_incarnation=self.binding.journal_incarnation,
            outcome_receipt_sha256=stable_hash(
                material,
                domain="flux-clone-import-stage-outcome-receipt-v1",
            ),
        )


@dataclass(frozen=True, slots=True)
class CompletedStageReceipt:
    """Unauthenticated audit record; never an authority-bearing capability."""

    operation_id: str
    authorization_id: str
    authorization_digest: str
    candidate_stage_receipt_sha256: str
    transaction_id: str
    transaction_open_event_sha256: str
    candidate_staged_event_sha256: str
    candidate_provider_attestation_sha256: str
    evidence_provider_id: str
    evidence_provider_incarnation: str
    staged_candidate_generation: int
    staged_candidate_last_event_sha256: str
    completed_at: datetime
    journal_generation: int
    journal_event_head_sha256: str
    journal_state: StageOperationState
    journal_catalog_generation: int
    journal_catalog_sha256: str
    journal_anchor_attestation_sha256: str
    monotonic_anchor_id: str
    monotonic_anchor_incarnation: str
    journal_key: str
    journal_incarnation: str
    outcome_receipt_sha256: str
    authorizes_internal_commit: bool = False
    authorizes_manufacturing_release: bool = False

    @property
    def is_authority(self) -> bool:
        return False

    def __post_init__(self) -> None:
        for value, label in (
            (self.operation_id, "stage receipt operation ID"),
            (self.authorization_id, "stage receipt authorization ID"),
            (self.transaction_id, "stage receipt transaction ID"),
            (self.evidence_provider_id, "stage receipt evidence provider ID"),
            (
                self.evidence_provider_incarnation,
                "stage receipt evidence provider incarnation",
            ),
            (self.monotonic_anchor_id, "stage receipt monotonic anchor ID"),
            (
                self.monotonic_anchor_incarnation,
                "stage receipt monotonic anchor incarnation",
            ),
            (self.journal_key, "stage receipt journal key"),
            (self.journal_incarnation, "stage receipt journal incarnation"),
        ):
            require_public_id(value, label)
        for value, label in (
            (self.authorization_digest, "stage receipt authorization digest"),
            (
                self.candidate_stage_receipt_sha256,
                "stage receipt candidate correlation digest",
            ),
            (
                self.transaction_open_event_sha256,
                "stage receipt transaction event digest",
            ),
            (
                self.candidate_staged_event_sha256,
                "stage receipt candidate event digest",
            ),
            (
                self.candidate_provider_attestation_sha256,
                "stage receipt provider attestation",
            ),
            (
                self.staged_candidate_last_event_sha256,
                "stage receipt durable candidate event digest",
            ),
            (self.outcome_receipt_sha256, "stage outcome receipt digest"),
            (self.journal_event_head_sha256, "stage receipt journal event head"),
            (self.journal_catalog_sha256, "stage receipt journal catalog digest"),
            (
                self.journal_anchor_attestation_sha256,
                "stage receipt external anchor attestation",
            ),
        ):
            require_sha256(value, label)
        require_nonnegative_int(
            self.staged_candidate_generation, "stage receipt candidate generation"
        )
        require_nonnegative_int(self.journal_generation, "stage receipt journal generation")
        require_nonnegative_int(
            self.journal_catalog_generation,
            "stage receipt journal catalog generation",
        )
        if self.journal_state is not StageOperationState.CANDIDATE_STAGED:
            raise InvalidStageOperation(
                "stage outcome receipt requires current CANDIDATE_STAGED state"
            )
        if self.journal_event_head_sha256 != self.candidate_staged_event_sha256:
            raise InvalidStageOperation(
                "stage outcome receipt must bind the current candidate event head"
            )
        require_time(self.completed_at, "stage receipt completion time")
        if self.authorizes_internal_commit is not False:
            raise InvalidStageOperation("stage outcome cannot authorize commit")
        if self.authorizes_manufacturing_release is not False:
            raise InvalidStageOperation("stage outcome cannot authorize manufacturing")
        expected = stable_hash(
            {
                "operation_id": self.operation_id,
                "authorization_id": self.authorization_id,
                "authorization_digest": self.authorization_digest,
                "candidate_stage_receipt_sha256": (
                    self.candidate_stage_receipt_sha256
                ),
                "transaction_id": self.transaction_id,
                "transaction_open_event_sha256": (
                    self.transaction_open_event_sha256
                ),
                "candidate_staged_event_sha256": (
                    self.candidate_staged_event_sha256
                ),
                "candidate_provider_attestation_sha256": (
                    self.candidate_provider_attestation_sha256
                ),
                "evidence_provider_id": self.evidence_provider_id,
                "evidence_provider_incarnation": self.evidence_provider_incarnation,
                "staged_candidate_generation": self.staged_candidate_generation,
                "staged_candidate_last_event_sha256": (
                    self.staged_candidate_last_event_sha256
                ),
                "completed_at": time_text(self.completed_at),
                "journal_generation": self.journal_generation,
                "journal_event_head_sha256": self.journal_event_head_sha256,
                "journal_state": self.journal_state.value,
                "journal_catalog_generation": self.journal_catalog_generation,
                "journal_catalog_sha256": self.journal_catalog_sha256,
                "journal_anchor_attestation_sha256": (
                    self.journal_anchor_attestation_sha256
                ),
                "monotonic_anchor_id": self.monotonic_anchor_id,
                "monotonic_anchor_incarnation": (
                    self.monotonic_anchor_incarnation
                ),
                "journal_key": self.journal_key,
                "journal_incarnation": self.journal_incarnation,
                "authorizes_internal_commit": self.authorizes_internal_commit,
                "authorizes_manufacturing_release": (
                    self.authorizes_manufacturing_release
                ),
            },
            domain="flux-clone-import-stage-outcome-receipt-v1",
        )
        if expected != self.outcome_receipt_sha256:
            raise InvalidStageOperation("stage outcome receipt digest is inconsistent")


class VerifiedStageCapability:
    """Opaque, journal-MACed result of live receipt verification.

    It cannot be constructed through the public initializer.  Downstream code
    must still pass it back to the issuing journal's
    ``require_verified_stage_capability`` immediately before acceptance.
    """

    __slots__ = (
        "_operation_id",
        "_outcome_receipt_sha256",
        "_journal_key",
        "_journal_incarnation",
        "_operation_generation",
        "_operation_event_head_sha256",
        "_journal_generation",
        "_journal_catalog_sha256",
        "_transaction_attestation_sha256",
        "_candidate_attestation_sha256",
        "_capability_key_id",
        "_verified_at",
        "_nonce",
        "_mac_sha256",
    )

    def __init__(
        self,
        token: object,
        *,
        operation_id: str,
        outcome_receipt_sha256: str,
        journal_key: str,
        journal_incarnation: str,
        operation_generation: int,
        operation_event_head_sha256: str,
        journal_generation: int,
        journal_catalog_sha256: str,
        transaction_attestation_sha256: str,
        candidate_attestation_sha256: str,
        capability_key_id: str,
        verified_at: datetime,
        nonce: str,
        mac_sha256: str,
    ) -> None:
        if token is not _VERIFIED_CAPABILITY_TOKEN:
            raise InvalidStageOperation(
                "verified stage capabilities are issued only by the journal"
            )
        for value, label in (
            (operation_id, "verified capability operation ID"),
            (journal_key, "verified capability journal key"),
            (journal_incarnation, "verified capability journal incarnation"),
            (nonce, "verified capability nonce"),
        ):
            require_public_id(value, label)
        for value, label in (
            (outcome_receipt_sha256, "verified capability receipt"),
            (operation_event_head_sha256, "verified capability operation head"),
            (journal_catalog_sha256, "verified capability catalog"),
            (transaction_attestation_sha256, "verified transaction attestation"),
            (candidate_attestation_sha256, "verified candidate attestation"),
            (capability_key_id, "verified capability key ID"),
            (mac_sha256, "verified capability MAC"),
        ):
            require_sha256(value, label)
        require_nonnegative_int(
            operation_generation, "verified capability operation generation"
        )
        require_nonnegative_int(
            journal_generation, "verified capability journal generation"
        )
        require_time(verified_at, "verified capability time")
        self._operation_id = operation_id
        self._outcome_receipt_sha256 = outcome_receipt_sha256
        self._journal_key = journal_key
        self._journal_incarnation = journal_incarnation
        self._operation_generation = operation_generation
        self._operation_event_head_sha256 = operation_event_head_sha256
        self._journal_generation = journal_generation
        self._journal_catalog_sha256 = journal_catalog_sha256
        self._transaction_attestation_sha256 = transaction_attestation_sha256
        self._candidate_attestation_sha256 = candidate_attestation_sha256
        self._capability_key_id = capability_key_id
        self._verified_at = verified_at
        self._nonce = nonce
        self._mac_sha256 = mac_sha256

    def __setattr__(self, name: str, value: object) -> None:
        if hasattr(self, name):
            raise AttributeError("verified stage capabilities are immutable")
        object.__setattr__(self, name, value)

    @property
    def operation_id(self) -> str:
        return self._operation_id

    @property
    def outcome_receipt_sha256(self) -> str:
        return self._outcome_receipt_sha256

    @property
    def mac_sha256(self) -> str:
        return self._mac_sha256

    @property
    def verified_at(self) -> datetime:
        return self._verified_at

    @property
    def grants_commit_authority(self) -> bool:
        return False

    @property
    def grants_manufacturing_authority(self) -> bool:
        return False

    def _material(self) -> dict[str, object]:
        return {
            "operation_id": self._operation_id,
            "outcome_receipt_sha256": self._outcome_receipt_sha256,
            "journal_key": self._journal_key,
            "journal_incarnation": self._journal_incarnation,
            "operation_generation": self._operation_generation,
            "operation_event_head_sha256": self._operation_event_head_sha256,
            "journal_generation": self._journal_generation,
            "journal_catalog_sha256": self._journal_catalog_sha256,
            "transaction_attestation_sha256": (
                self._transaction_attestation_sha256
            ),
            "candidate_attestation_sha256": self._candidate_attestation_sha256,
            "capability_key_id": self._capability_key_id,
            "verified_at": time_text(self._verified_at),
            "nonce": self._nonce,
        }


def issue_verified_stage_capability(**values: object) -> VerifiedStageCapability:
    return VerifiedStageCapability(
        _VERIFIED_CAPABILITY_TOKEN,
        **values,  # type: ignore[arg-type]
    )


@dataclass(frozen=True, slots=True)
class PrepareResult:
    operation: StageOperation
    created: bool


@dataclass(frozen=True, slots=True)
class TransitionResult:
    operation: StageOperation
    event: StageOperationEvent
    idempotent_retry: bool


__all__ = (
    "CompletedStageReceipt",
    "IllegalStageOperationTransition",
    "ImportStageJournalError",
    "InvalidStageOperation",
    "PrepareResult",
    "StageJournalUnavailable",
    "StageOperation",
    "StageOperationBinding",
    "StageOperationConcurrencyConflict",
    "StageOperationEvent",
    "StageOperationEventKind",
    "StageOperationEvidenceMismatch",
    "StageOperationExpired",
    "StageOperationIntegrityError",
    "StageOperationNotFound",
    "StageOperationRecoveryRequired",
    "StageOperationReplayError",
    "StageOperationState",
    "StageRecoveryReason",
    "TransitionResult",
    "UnsupportedStageJournalSchema",
    "VerifiedStageCapability",
    "operation_id_for",
)
