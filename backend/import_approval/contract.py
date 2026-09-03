"""Fail-closed issuer for human-approved canonical-import staging inputs."""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import cast

from backend.canonical_import import (
    CanonicalImportCandidate,
    CanonicalImportTransactionInput,
    CanonicalMappingEvidence,
    ImportMappingResult,
    MappingEvidenceRepository,
    MappingEvidenceState,
)
from backend.design_kernel import DesignCommand, stable_hash
from backend.design_kernel.model import canonical_json
from backend.interchange_artifacts import ArtifactKind
from backend.kicad_import_candidates import (
    CandidateState,
    ImportCandidate,
    ImportCandidateRepository,
)

from .ledger import SQLiteApprovalLedger
from .models import (
    ApprovalLedgerAnchorStore,
    ApprovalSourceCASProvider,
    ApprovalSourceSnapshot,
    AuthenticatedPrincipal,
    AuthorizedImportStagingInput,
    CurrentAuthorityProvider,
    CurrentAuthoritySnapshot,
    HumanMappingApproval,
    ImportApprovalActorMismatch,
    ImportApprovalContext,
    ImportApprovalEvidenceMismatch,
    ImportApprovalExpired,
    ImportApprovalIntegrityError,
    ImportApprovalInvariantError,
    ImportApprovalLifecycle,
    ImportApprovalLifecycleError,
    ImportApprovalScope,
    ImportApprovalStale,
    ImportApprovalStatus,
    MappingApprovalRequest,
    MappingDecision,
    PrincipalRole,
    ReviewManifest,
    TrustedPrincipalProvider,
    commands_sha256,
    import_preview_digest,
    mapping_generation_fence_sha256,
    prospective_revision_sha256,
)
from .models import (
    approval_time_text as _time_text,
)
from .models import (
    require_approval_id as _require_id,
)
from .serialization import decode_record_json, record_json

_REQUEST_PREFIX = "import-map-request-"
_APPROVAL_PREFIX = "import-map-approval-"
_AUTHORIZATION_PREFIX = "import-stage-authorization-"


@dataclass(frozen=True, slots=True)
class _Evidence:
    candidate: ImportCandidate
    mapping: ImportMappingResult
    mapping_evidence: CanonicalMappingEvidence
    context: ImportApprovalContext
    candidate_sha256: str
    canonical_candidate_sha256: str
    mapper_result_sha256: str
    command_hashes: tuple[str, ...]
    commands_sha256: str
    preview_digest: str
    prospective_revision_sha256: str


@dataclass(frozen=True, slots=True)
class _Record:
    request: MappingApprovalRequest
    state: ImportApprovalLifecycle
    generation: int
    approval: HumanMappingApproval | None = None
    authorization: AuthorizedImportStagingInput | None = None
    invalidated_by: str | None = None
    invalidated_principal_sha256: str | None = None
    invalidation_reason: str | None = None

    def status(self) -> ImportApprovalStatus:
        return ImportApprovalStatus(
            request=self.request,
            state=self.state,
            generation=self.generation,
            approval=self.approval,
            authorization=self.authorization,
            invalidated_by=self.invalidated_by,
            invalidated_principal_sha256=self.invalidated_principal_sha256,
            invalidation_reason=self.invalidation_reason,
        )


def _utc_now() -> datetime:
    return datetime.now(UTC)


class ImportApprovalContract:
    """Issue and validate exact, stage-only import authorization.

    ``sealing_key`` is an issuer-owned secret of at least 256 bits. Every
    lifecycle transition is persisted as an append-only, hash-chained and
    HMAC-sealed SQLite event. Exact records and replay fences survive restart.

    No method receives a ``DesignKernel`` and no method stages or commits a
    command.  ``authorize_staging`` is idempotent only for an exactly identical
    subject, enabling crash recovery without granting a second or broader
    authorization.
    """

    def __init__(
        self,
        *,
        issuer_id: str,
        sealing_key: bytes,
        candidate_repository: ImportCandidateRepository,
        mapping_evidence_repository: MappingEvidenceRepository,
        ledger_path: str | Path,
        current_authority_provider: CurrentAuthorityProvider,
        trusted_principal_provider: TrustedPrincipalProvider,
        source_cas_provider: ApprovalSourceCASProvider,
        ledger_anchor_store: ApprovalLedgerAnchorStore,
        principal_authority_id: str,
        require_distinct_uploader_reviewer: bool = True,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        _require_id(issuer_id, "approval issuer ID")
        if type(sealing_key) is not bytes or len(sealing_key) < 32:
            raise ImportApprovalInvariantError(
                "approval sealing key must contain at least 32 secret bytes"
            )
        if not callable(clock):
            raise ImportApprovalInvariantError("approval clock must be callable")
        if not isinstance(cast(object, candidate_repository), ImportCandidateRepository):
            raise ImportApprovalInvariantError(
                "approval contract requires an ImportCandidateRepository"
            )
        if not isinstance(
            cast(object, mapping_evidence_repository), MappingEvidenceRepository
        ):
            raise ImportApprovalInvariantError(
                "approval contract requires a MappingEvidenceRepository"
            )
        if not isinstance(cast(object, current_authority_provider), CurrentAuthorityProvider):
            raise ImportApprovalInvariantError(
                "approval contract requires a CurrentAuthorityProvider"
            )
        if not isinstance(cast(object, trusted_principal_provider), TrustedPrincipalProvider):
            raise ImportApprovalInvariantError(
                "approval contract requires a TrustedPrincipalProvider"
            )
        if not isinstance(cast(object, source_cas_provider), ApprovalSourceCASProvider):
            raise ImportApprovalInvariantError(
                "approval contract requires an ApprovalSourceCASProvider"
            )
        if not isinstance(cast(object, ledger_anchor_store), ApprovalLedgerAnchorStore):
            raise ImportApprovalInvariantError(
                "approval contract requires an ApprovalLedgerAnchorStore"
            )
        _require_id(principal_authority_id, "principal authority ID")
        if type(require_distinct_uploader_reviewer) is not bool:
            raise ImportApprovalInvariantError(
                "uploader/reviewer separation policy must be boolean"
            )
        self._issuer_id = issuer_id
        self._sealing_key = sealing_key
        self._candidate_repository = candidate_repository
        self._mapping_evidence_repository = mapping_evidence_repository
        self._current_authority_provider = current_authority_provider
        self._trusted_principal_provider = trusted_principal_provider
        self._source_cas_provider = source_cas_provider
        self._principal_authority_id = principal_authority_id
        self._require_distinct_uploader_reviewer = require_distinct_uploader_reviewer
        self._clock = clock
        self._records: dict[str, _Record] = {}
        self._subjects: dict[str, str] = {}
        self._operations: dict[str, str] = {}
        self._rejection_fences: dict[str, str] = {}
        self._lock = RLock()
        self._last_clock: datetime | None = None
        self._ledger = SQLiteApprovalLedger(
            ledger_path,
            issuer_id=issuer_id,
            seal=self._seal,
            anchor_store=ledger_anchor_store,
        )
        try:
            with self._lock:
                self._reload_ledger_locked()
        except BaseException:
            self._ledger.close()
            raise

    @property
    def issuer_id(self) -> str:
        return self._issuer_id

    def close(self) -> None:
        self._ledger.close()

    def __enter__(self) -> ImportApprovalContract:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def request_mapping_approval(
        self,
        *,
        candidate: ImportCandidate,
        mapping: ImportMappingResult,
        mapping_evidence: CanonicalMappingEvidence,
        context: ImportApprovalContext,
        review_manifest: ReviewManifest,
        operation_key: str,
        expires_at: datetime,
        expected_candidate_generation: int,
        expected_mapping_evidence_generation: int,
    ) -> MappingApprovalRequest:
        """Create a human review request for an exact resolved mapping."""

        _require_id(operation_key, "mapping approval operation key")
        if type(review_manifest) is not ReviewManifest:
            raise ImportApprovalInvariantError(
                "mapping approval requires a ReviewManifest"
            )
        if type(expires_at) is not datetime or expires_at.tzinfo is None:
            raise ImportApprovalInvariantError("mapping approval expiry must be timezone-aware")
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            if expires_at.utcoffset() is None or expires_at <= now:
                raise ImportApprovalExpired("mapping approval expiry must be in the future")
            self._require_evidence_input_types(
                candidate, mapping, mapping_evidence, context
            )
            source_before = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            evidence = self._validate_evidence(
                candidate=candidate,
                mapping=mapping,
                mapping_evidence=mapping_evidence,
                context=context,
                expected_candidate_generation=expected_candidate_generation,
                expected_mapping_evidence_generation=(
                    expected_mapping_evidence_generation
                ),
                required_state=CandidateState.RESOLVED,
            )
            source_after = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            self._require_stable_source_snapshot(
                source_before,
                source_after,
                evidence,
            )
            now = self._now_locked()
            if expires_at <= now:
                raise ImportApprovalExpired(
                    "mapping approval expired while current evidence was being checked"
                )
            self._require_review_manifest(review_manifest, evidence)
            generation_fence = self._generation_fence(evidence)
            subject_material = self._subject_material(
                evidence,
                review_manifest,
                generation_fence,
                source_after,
            )
            subject_digest = stable_hash(
                subject_material,
                domain="flux-clone-import-mapping-approval-subject-v1",
            )
            request_digest = stable_hash(
                {
                    "subject_digest": subject_digest,
                    "requested_at": _time_text(now),
                    "expires_at": _time_text(expires_at),
                    "lifecycle_generation": 0,
                    "operation_key": operation_key,
                },
                domain="flux-clone-import-mapping-approval-request-v1",
            )
            request_id = f"{_REQUEST_PREFIX}{request_digest[:32]}"
            seal = self._seal(
                "mapping-request",
                {
                    "request_id": request_id,
                    "request_digest": request_digest,
                    "subject_digest": subject_digest,
                },
            )
            transaction = evidence.mapping.transaction_input
            canonical_candidate = evidence.mapping.candidate
            assert transaction is not None and canonical_candidate is not None
            request = MappingApprovalRequest(
                request_id=request_id,
                issuer_id=self._issuer_id,
                candidate_id=candidate.candidate_id,
                candidate_sha256=evidence.candidate_sha256,
                candidate_generation=candidate.generation,
                candidate_last_event_sha256=candidate.last_event_digest,
                inspection_receipt_sha256=candidate.inspection_receipt_digest,
                resolution_receipt_sha256=mapping_evidence.mapping_evidence_digest,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                mapping_evidence_sha256=mapping_evidence.mapping_evidence_digest,
                mapping_evidence_generation=mapping_evidence.generation,
                mapping_evidence_last_event_sha256=mapping_evidence.last_event_digest,
                canonical_candidate_sha256=evidence.canonical_candidate_sha256,
                mapper_result_sha256=evidence.mapper_result_sha256,
                mapping_generation_fence_sha256=generation_fence,
                source_snapshot_sha256=source_after.snapshot_sha256,
                project_id=context.project_id,
                base_revision=context.base_revision,
                prospective_graph_sha256=context.prospective_graph_sha256,
                prospective_revision_sha256=evidence.prospective_revision_sha256,
                transaction_id=transaction.transaction_id,
                command_hashes=evidence.command_hashes,
                commands_sha256=evidence.commands_sha256,
                preview_digest=evidence.preview_digest,
                review_manifest=review_manifest,
                operation_key=operation_key,
                uploader_actor=context.uploader_principal.principal_id,
                authorized_human_actor=context.authorized_human_actor,
                mapping_command_actor=context.mapping_command_actor,
                staging_service_actor=context.staging_service_actor,
                uploader_principal_sha256=context.uploader_principal.principal_digest,
                reviewer_principal_sha256=(
                    context.authorized_human_principal.principal_digest
                ),
                mapper_principal_sha256=(
                    context.mapping_command_principal.principal_digest
                ),
                staging_service_principal_sha256=(
                    context.staging_service_principal.principal_digest
                ),
                run_id=context.run_id,
                run_revision=context.run_revision,
                project_event_head_sha256=context.project_event_head_sha256,
                run_incarnation=context.run_incarnation,
                run_event_head_sha256=context.run_event_head_sha256,
                coordination_incarnation=context.coordination_incarnation,
                coordination_context_digest=context.coordination_context_digest,
                coordination_event_head_sha256=(
                    context.coordination_event_head_sha256
                ),
                target_store_id=context.target_store_id,
                target_store_incarnation=context.target_store_incarnation,
                authority_snapshot_sha256=context.authority_snapshot.snapshot_digest,
                principal_authority_snapshot_sha256=(
                    source_after.principal_authority_snapshot_sha256
                ),
                requested_at=now,
                expires_at=expires_at,
                lifecycle_generation=0,
                subject_digest=subject_digest,
                request_digest=request_digest,
                issuer_seal=seal,
            )
            operation_request_id = self._operations.get(operation_key)
            if operation_request_id is not None:
                existing = self._records[operation_request_id]
                if (
                    existing.request.subject_digest == subject_digest
                    and existing.request.expires_at == expires_at
                    and existing.request.review_manifest == review_manifest
                ):
                    self._cas_source_snapshot(
                        source_after,
                        self._source_operation_id("request-retry", request_digest),
                    )
                    return existing.request
                raise ImportApprovalLifecycleError(
                    "mapping approval operation key was reused for another request"
                )
            rejected_request_id = self._rejection_fences.get(generation_fence)
            if rejected_request_id is not None:
                raise ImportApprovalLifecycleError(
                    "this candidate/mapping generation was rejected; new durable "
                    "candidate or mapping evidence is required"
                )
            existing_id = self._subjects.get(subject_digest)
            if existing_id is not None:
                existing = self._expire_locked(self._records[existing_id], now)
                self._persist_if_changed_locked(self._records[existing_id], existing, now)
                if existing.state is not ImportApprovalLifecycle.EXPIRED:
                    raise ImportApprovalLifecycleError(
                        "this exact candidate/mapping generation is already fenced by "
                        f"a {existing.state.value} approval lifecycle"
                    )
            record = _Record(
                request=request,
                state=ImportApprovalLifecycle.REQUESTED,
                generation=0,
            )
            self._cas_source_snapshot(
                source_after,
                self._source_operation_id("request", request_digest),
            )
            self._persist_record_locked(record, now)
            return request

    def decide_mapping(
        self,
        request: MappingApprovalRequest,
        *,
        principal: AuthenticatedPrincipal,
        decision: MappingDecision,
        expected_lifecycle_generation: int,
        reason: str | None = None,
    ) -> HumanMappingApproval:
        """Record one authenticated human mapping decision."""

        if type(request) is not MappingApprovalRequest:
            raise ImportApprovalInvariantError("mapping decision requires MappingApprovalRequest")
        if type(decision) is not MappingDecision:
            raise ImportApprovalInvariantError("mapping decision must be MappingDecision")
        if reason is not None and type(reason) is not str:
            raise ImportApprovalInvariantError("mapping decision reason must be exact text")
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            self._require_principal(principal, PrincipalRole.HUMAN_REVIEWER)
            record = self._verified_record_locked(request, now)
            source_before = self._collect_request_source_snapshot(request)
            self._require_request_repositories_current(request)
            self._require_request_authority_current(request)
            source_after = self._collect_request_source_snapshot(request)
            self._require_stable_request_source_snapshot(
                source_before,
                source_after,
                request,
            )
            now = self._now_locked()
            record = self._expire_locked(record, now)
            self._persist_if_changed_locked(self._records[request.request_id], record, now)
            if record.state is ImportApprovalLifecycle.EXPIRED:
                raise ImportApprovalExpired("mapping approval request expired")
            if record.approval is not None:
                approval = record.approval
                if (
                    approval.decided_by == principal.principal_id
                    and approval.decided_principal_sha256 == principal.principal_digest
                    and approval.decision is decision
                    and approval.reason == reason
                ):
                    self._cas_source_snapshot(
                        source_after,
                        self._source_operation_id(
                            "decision-retry", approval.approval_digest
                        ),
                    )
                    return approval
                raise ImportApprovalLifecycleError(
                    "an exact mapping request cannot receive a conflicting second decision"
                )
            self._require_generation_not_rejected_locked(request)
            if record.state is not ImportApprovalLifecycle.REQUESTED:
                raise ImportApprovalLifecycleError(
                    f"mapping request is {record.state.value}, not requested"
                )
            self._require_generation(record, expected_lifecycle_generation)
            if (
                principal.principal_id != request.authorized_human_actor
                or principal.principal_digest != request.reviewer_principal_sha256
            ):
                raise ImportApprovalActorMismatch(
                    "mapping decision actor is not the request's authorized human"
                )
            if decision is MappingDecision.REJECTED and reason is None:
                raise ImportApprovalInvariantError("a rejected mapping requires a reason")
            approval_digest = stable_hash(
                {
                    "issuer_id": self._issuer_id,
                    "request_id": request.request_id,
                    "request_digest": request.request_digest,
                    "subject_digest": request.subject_digest,
                    "scope": ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE.value,
                    "decision": decision.value,
                    "decided_by": principal.principal_id,
                    "decided_principal_sha256": principal.principal_digest,
                    "decided_at": _time_text(now),
                    "expires_at": _time_text(request.expires_at),
                    "lifecycle_generation": 1,
                    "reason": reason,
                    "authorizes_internal_commit": False,
                    "authorizes_manufacturing_release": False,
                },
                domain="flux-clone-human-import-mapping-approval-v1",
            )
            approval_id = f"{_APPROVAL_PREFIX}{approval_digest[:32]}"
            seal = self._seal(
                "human-mapping-approval",
                {
                    "approval_id": approval_id,
                    "approval_digest": approval_digest,
                    "request_digest": request.request_digest,
                },
            )
            approval = HumanMappingApproval(
                approval_id=approval_id,
                issuer_id=self._issuer_id,
                request_id=request.request_id,
                request_digest=request.request_digest,
                subject_digest=request.subject_digest,
                decision=decision,
                decided_by=principal.principal_id,
                decided_principal_sha256=principal.principal_digest,
                decided_at=now,
                expires_at=request.expires_at,
                lifecycle_generation=1,
                approval_digest=approval_digest,
                issuer_seal=seal,
                reason=reason,
            )
            state = (
                ImportApprovalLifecycle.APPROVED
                if decision is MappingDecision.APPROVED
                else ImportApprovalLifecycle.REJECTED
            )
            next_record = replace(
                record,
                state=state,
                generation=1,
                approval=approval,
            )
            self._cas_source_snapshot(
                source_after,
                self._source_operation_id("decision", approval_digest),
            )
            self._persist_record_locked(next_record, now)
            return approval

    def authorize_staging(
        self,
        approval: HumanMappingApproval,
        *,
        candidate: ImportCandidate,
        mapping: ImportMappingResult,
        mapping_evidence: CanonicalMappingEvidence,
        context: ImportApprovalContext,
        principal: AuthenticatedPrincipal,
        expected_candidate_generation: int,
        expected_mapping_evidence_generation: int,
        expected_lifecycle_generation: int,
    ) -> AuthorizedImportStagingInput:
        """Issue or idempotently recover one exact stage-only authorization."""

        if type(approval) is not HumanMappingApproval:
            raise ImportApprovalInvariantError(
                "staging authorization requires HumanMappingApproval"
            )
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            self._require_principal(principal, PrincipalRole.STAGING_SERVICE)
            record = self._record_for_approval_locked(approval, now)
            self._require_generation_not_rejected_locked(record.request)
            if approval.decision is not MappingDecision.APPROVED:
                raise ImportApprovalLifecycleError("a rejected mapping cannot authorize staging")
            if (
                principal.principal_id != record.request.staging_service_actor
                or principal.principal_digest
                != record.request.staging_service_principal_sha256
            ):
                raise ImportApprovalActorMismatch(
                    "staging principal is not the request's trusted staging service"
                )
            self._require_evidence_input_types(
                candidate, mapping, mapping_evidence, context
            )
            source_before = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            evidence = self._validate_evidence(
                candidate=candidate,
                mapping=mapping,
                mapping_evidence=mapping_evidence,
                context=context,
                expected_candidate_generation=expected_candidate_generation,
                expected_mapping_evidence_generation=(
                    expected_mapping_evidence_generation
                ),
                required_state=CandidateState.RESOLVED,
            )
            source_after = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            self._require_stable_source_snapshot(
                source_before,
                source_after,
                evidence,
            )
            now = self._now_locked()
            record = self._expire_locked(record, now)
            self._persist_if_changed_locked(self._records[record.request.request_id], record, now)
            if record.state is ImportApprovalLifecycle.EXPIRED:
                raise ImportApprovalExpired("mapping approval expired during evidence validation")
            self._require_evidence_matches_request(
                record.request, evidence, source_after
            )

            if record.state is ImportApprovalLifecycle.AUTHORIZED:
                if record.authorization is None:
                    raise ImportApprovalLifecycleError(
                        "authorized lifecycle record lacks its exact authorization"
                    )
                self._verify_authorization_seal(record.authorization)
                self._cas_source_snapshot(
                    source_after,
                    self._source_operation_id(
                        "authorization-retry",
                        record.authorization.authorization_digest,
                    ),
                )
                return record.authorization
            if record.state is not ImportApprovalLifecycle.APPROVED:
                raise ImportApprovalLifecycleError(
                    f"mapping approval is {record.state.value}, not approved"
                )
            self._require_generation(record, expected_lifecycle_generation)
            authorization = self._build_authorization(
                request=record.request,
                approval=approval,
                evidence=evidence,
                issued_at=now,
            )
            next_record = replace(
                record,
                state=ImportApprovalLifecycle.AUTHORIZED,
                generation=2,
                authorization=authorization,
            )
            self._cas_source_snapshot(
                source_after,
                self._source_operation_id(
                    "authorization", authorization.authorization_digest
                ),
            )
            self._persist_record_locked(next_record, now)
            return authorization

    def validate_staging_authorization(
        self,
        authorization: AuthorizedImportStagingInput,
        *,
        candidate: ImportCandidate,
        mapping: ImportMappingResult,
        mapping_evidence: CanonicalMappingEvidence,
        context: ImportApprovalContext,
        principal: AuthenticatedPrincipal,
        expected_candidate_generation: int,
        expected_mapping_evidence_generation: int,
    ) -> AuthorizedImportStagingInput:
        """Validate an authorization at the internal staging boundary.

        The exact object is returned for convenient access to
        ``transaction_input``.  This method has no kernel side effects.  Exact
        retries are safe because the mapped commands carry stable command IDs
        and idempotency keys; any broadened or rebound replay is rejected.
        """

        if type(authorization) is not AuthorizedImportStagingInput:
            raise ImportApprovalInvariantError(
                "staging validation requires AuthorizedImportStagingInput"
            )
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            self._require_principal(principal, PrincipalRole.STAGING_SERVICE)
            record = self._records.get(authorization.request_id)
            if record is None:
                raise ImportApprovalLifecycleError("staging authorization is unknown")
            record = self._expire_locked(record, now)
            self._persist_if_changed_locked(
                self._records[authorization.request_id], record, now
            )
            if record.state is ImportApprovalLifecycle.EXPIRED:
                raise ImportApprovalExpired("staging authorization expired")
            if (
                record.state is not ImportApprovalLifecycle.AUTHORIZED
                or record.authorization != authorization
            ):
                raise ImportApprovalLifecycleError(
                    "staging authorization was replayed outside its exact issued lifecycle"
                )
            self._require_generation_not_rejected_locked(record.request)
            self._verify_authorization_seal(authorization)
            if (
                principal.principal_id != authorization.staging_service_actor
                or principal.principal_digest
                != authorization.staging_service_principal_sha256
            ):
                raise ImportApprovalActorMismatch(
                    "staging validation principal is not the trusted staging service"
                )
            self._require_evidence_input_types(
                candidate, mapping, mapping_evidence, context
            )
            source_before = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            evidence = self._validate_evidence(
                candidate=candidate,
                mapping=mapping,
                mapping_evidence=mapping_evidence,
                context=context,
                expected_candidate_generation=expected_candidate_generation,
                expected_mapping_evidence_generation=(
                    expected_mapping_evidence_generation
                ),
                required_state=CandidateState.RESOLVED,
            )
            source_after = self._collect_source_snapshot(
                candidate_id=candidate.candidate_id,
                mapping_evidence_id=mapping_evidence.mapping_evidence_id,
                project_id=context.project_id,
                run_id=context.run_id,
            )
            self._require_stable_source_snapshot(
                source_before,
                source_after,
                evidence,
            )
            now = self._now_locked()
            record = self._expire_locked(record, now)
            self._persist_if_changed_locked(
                self._records[authorization.request_id], record, now
            )
            if record.state is ImportApprovalLifecycle.EXPIRED:
                raise ImportApprovalExpired(
                    "staging authorization expired during evidence validation"
                )
            self._require_evidence_matches_request(
                record.request, evidence, source_after
            )
            self._cas_source_snapshot(
                source_after,
                self._source_operation_id(
                    "validation", authorization.authorization_digest
                ),
            )
            return authorization

    def reconcile_staged(
        self,
        authorization: AuthorizedImportStagingInput,
        *,
        candidate: ImportCandidate,
    ) -> ImportApprovalStatus:
        """Disabled until the durable stage journal supplies an outcome receipt."""

        raise ImportApprovalLifecycleError(
            "candidate lifecycle state and an authorization digest cannot prove staging; "
            "reconciliation requires the durable stage-operation journal"
        )

    def get_status(self, request_id: str) -> ImportApprovalStatus:
        """Return the exact lifecycle record for recovery or audit."""

        _require_id(request_id, "mapping request ID")
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            original = self._records.get(request_id)
            if original is None:
                raise ImportApprovalLifecycleError("mapping approval request is unknown")
            record = self._expire_locked(original, now)
            self._persist_if_changed_locked(original, record, now)
            return record.status()

    def invalidate(
        self,
        request_id: str,
        *,
        principal: AuthenticatedPrincipal,
        reason: str,
        expected_lifecycle_generation: int,
    ) -> ImportApprovalStatus:
        """Fail closed a request when external state changes before staging."""

        _require_id(request_id, "mapping request ID")
        if type(reason) is not str or not reason.strip():
            raise ImportApprovalInvariantError("approval invalidation requires a reason")
        with self._lock:
            self._reload_ledger_locked()
            now = self._now_locked()
            self._require_principal(principal, PrincipalRole.STAGING_SERVICE)
            original = self._records.get(request_id)
            if original is None:
                raise ImportApprovalLifecycleError("mapping approval request is unknown")
            if (
                principal.principal_id != original.request.staging_service_actor
                or principal.principal_digest
                != original.request.staging_service_principal_sha256
            ):
                raise ImportApprovalActorMismatch(
                    "invalidation principal is not the request's trusted staging service"
                )
            source_before = self._collect_request_source_snapshot(original.request)
            self._require_request_repositories_current(original.request)
            self._require_request_authority_current(original.request)
            source_after = self._collect_request_source_snapshot(original.request)
            self._require_stable_request_source_snapshot(
                source_before,
                source_after,
                original.request,
            )
            now = self._now_locked()
            record = self._expire_locked(original, now)
            if record.state is ImportApprovalLifecycle.EXPIRED:
                if record != original:
                    record.status()
                    expiry_digest = stable_hash(
                        {
                            "request_digest": record.request.request_digest,
                            "lifecycle_generation": record.generation,
                            "expired_at": _time_text(now),
                        },
                        domain="flux-clone-import-approval-expiry-v1",
                    )
                    self._cas_source_snapshot(
                        source_after,
                        self._source_operation_id("expiry", expiry_digest),
                    )
                    self._persist_record_locked(record, now)
                raise ImportApprovalLifecycleError("mapping approval is already expired")
            if record.state in {
                ImportApprovalLifecycle.INVALIDATED,
                ImportApprovalLifecycle.REJECTED,
            }:
                raise ImportApprovalLifecycleError(
                    f"mapping approval is already {record.state.value}"
                )
            self._require_generation(record, expected_lifecycle_generation)
            record = replace(
                record,
                state=ImportApprovalLifecycle.INVALIDATED,
                generation=record.generation + 1,
                invalidated_by=principal.principal_id,
                invalidated_principal_sha256=principal.principal_digest,
                invalidation_reason=reason,
            )
            status = record.status()
            invalidation_digest = stable_hash(
                {
                    "request_digest": record.request.request_digest,
                    "expected_lifecycle_generation": expected_lifecycle_generation,
                    "invalidated_by": principal.principal_id,
                    "invalidated_principal_sha256": principal.principal_digest,
                    "reason": reason,
                },
                domain="flux-clone-import-approval-invalidation-v1",
            )
            self._cas_source_snapshot(
                source_after,
                self._source_operation_id("invalidation", invalidation_digest),
            )
            self._persist_record_locked(record, now)
            return status

    def _now_locked(self) -> datetime:
        value = self._clock()
        if (
            type(value) is not datetime
            or value.tzinfo is None
            or value.utcoffset() is None
        ):
            raise ImportApprovalInvariantError("approval clock returned a naive timestamp")
        normalized = value.astimezone(UTC)
        if self._last_clock is not None and normalized < self._last_clock:
            raise ImportApprovalStale("approval clock moved backwards")
        self._last_clock = normalized
        return normalized

    def _validate_evidence(
        self,
        *,
        candidate: ImportCandidate,
        mapping: ImportMappingResult,
        mapping_evidence: CanonicalMappingEvidence,
        context: ImportApprovalContext,
        expected_candidate_generation: int,
        expected_mapping_evidence_generation: int,
        required_state: CandidateState,
    ) -> _Evidence:
        if type(candidate) is not ImportCandidate:
            raise ImportApprovalInvariantError("approval candidate must be ImportCandidate")
        if type(mapping) is not ImportMappingResult:
            raise ImportApprovalInvariantError("approval mapping must be ImportMappingResult")
        if type(mapping_evidence) is not CanonicalMappingEvidence:
            raise ImportApprovalInvariantError(
                "approval mapping evidence must be CanonicalMappingEvidence"
            )
        if type(context) is not ImportApprovalContext:
            raise ImportApprovalInvariantError("approval context must be ImportApprovalContext")
        if type(required_state) is not CandidateState:
            raise ImportApprovalInvariantError("required candidate state is invalid")
        self._require_context_principals(context)
        try:
            current_candidate = self._candidate_repository.get(candidate.candidate_id)
            current_mapping_evidence = self._mapping_evidence_repository.get(
                mapping_evidence.mapping_evidence_id
            )
        except Exception as exc:
            raise ImportApprovalEvidenceMismatch(
                "current durable import evidence could not be loaded"
            ) from exc
        if (
            type(current_candidate) is not ImportCandidate
            or type(current_mapping_evidence) is not CanonicalMappingEvidence
        ):
            raise ImportApprovalIntegrityError(
                "durable import repositories returned non-concrete records"
            )
        if current_candidate != candidate:
            raise ImportApprovalStale(
                "durable import candidate changed after the supplied snapshot"
            )
        if current_mapping_evidence != mapping_evidence:
            raise ImportApprovalStale(
                "durable mapping evidence changed after the supplied snapshot"
            )
        if (
            type(expected_candidate_generation) is not int
            or expected_candidate_generation < 0
        ):
            raise ImportApprovalInvariantError(
                "expected candidate generation must be a non-negative integer"
            )
        if candidate.generation != expected_candidate_generation:
            raise ImportApprovalStale("durable import candidate generation changed")
        if (
            type(expected_mapping_evidence_generation) is not int
            or expected_mapping_evidence_generation < 0
        ):
            raise ImportApprovalInvariantError(
                "expected mapping evidence generation must be a non-negative integer"
            )
        if mapping_evidence.generation != expected_mapping_evidence_generation:
            raise ImportApprovalStale("durable mapping evidence generation changed")
        if mapping_evidence.state is not MappingEvidenceState.ACTIVE:
            raise ImportApprovalLifecycleError(
                "durable mapping evidence is not active"
            )
        if candidate.state is not required_state:
            raise ImportApprovalLifecycleError(
                f"durable candidate is {candidate.state.value}, not {required_state.value}"
            )
        if candidate.artifact_kind is not ArtifactKind.KICAD_PROJECT_BUNDLE:
            raise ImportApprovalEvidenceMismatch(
                "canonical project import approval requires a project-bundle candidate"
            )
        if (
            not mapping.stage_eligible
            or mapping.candidate is None
            or mapping.transaction_input is None
        ):
            raise ImportApprovalEvidenceMismatch(
                "mapping is blocked or lacks an exact transaction input"
            )
        canonical_candidate = mapping.candidate
        transaction = mapping.transaction_input
        if (
            type(canonical_candidate) is not CanonicalImportCandidate
            or type(transaction) is not CanonicalImportTransactionInput
            or type(transaction.commands) is not tuple
            or any(type(command) is not DesignCommand for command in transaction.commands)
        ):
            raise ImportApprovalEvidenceMismatch(
                "mapping contains non-concrete candidate, transaction, or command records"
            )
        if (
            candidate.resolution_receipt_digest
            != mapping_evidence.mapping_evidence_digest
        ):
            raise ImportApprovalEvidenceMismatch(
                "candidate resolution receipt does not equal the durable mapping evidence digest"
            )
        if (
            mapping_evidence.import_candidate_id != candidate.candidate_id
            or mapping_evidence.import_candidate_digest != candidate.candidate_digest
            or mapping_evidence.import_candidate_state is not CandidateState.PENDING
            or mapping_evidence.import_candidate_generation != 0
            or mapping_evidence.mapper_result_sha256 != mapping.mapping_sha256
        ):
            raise ImportApprovalEvidenceMismatch(
                "durable mapping evidence does not bind this candidate and mapper result"
            )
        if (
            candidate.project_id != context.project_id
            or candidate.expected_project_revision != context.base_revision
            or candidate.run_id != context.run_id
            or candidate.expected_run_revision != context.run_revision
        ):
            raise ImportApprovalStale(
                "candidate project, base revision, or run context is stale"
            )
        if candidate.created_by != context.uploader_principal.principal_id:
            raise ImportApprovalActorMismatch(
                "authenticated uploader is not the durable candidate owner"
            )
        if (
            self._require_distinct_uploader_reviewer
            and context.uploader_principal.principal_id
            == context.authorized_human_principal.principal_id
        ):
            raise ImportApprovalActorMismatch(
                "approval policy requires the uploader and reviewer to be distinct"
            )
        inspection = candidate.decoded_inspection_payload()
        if inspection.get("coordinationContextDigest") != context.coordination_context_digest:
            raise ImportApprovalStale(
                "candidate inspection does not bind the live coordination context"
            )
        if (
            mapping_evidence.project_id != context.project_id
            or mapping_evidence.project_revision != context.base_revision
            or mapping_evidence.canonical_base_revision != context.base_revision
            or mapping_evidence.run_id != context.run_id
            or mapping_evidence.run_revision != context.run_revision
            or mapping_evidence.coordination_context_digest
            != context.coordination_context_digest
        ):
            raise ImportApprovalStale(
                "durable mapping evidence project, revision, run, or context is stale"
            )
        if (
            mapping.authorized_actor != context.mapping_command_actor
            or canonical_candidate.authorized_actor != context.mapping_command_actor
            or transaction.authorized_actor != context.mapping_command_actor
            or mapping_evidence.authorized_actor != context.mapping_command_actor
        ):
            raise ImportApprovalEvidenceMismatch(
                "canonical mapping command actor changed after mapping"
            )
        if (
            canonical_candidate.project_id != context.project_id
            or canonical_candidate.base_revision != context.base_revision
            or transaction.base_revision != context.base_revision
        ):
            raise ImportApprovalStale(
                "mapping no longer targets the live canonical project revision"
            )
        if (
            canonical_candidate.graph_sha256 != context.prospective_graph_sha256
            or transaction.prospective_graph_sha256 != context.prospective_graph_sha256
            or mapping_evidence.canonical_graph_sha256
            != context.prospective_graph_sha256
        ):
            raise ImportApprovalStale(
                "mapping no longer targets the approved prospective canonical state"
            )
        command_hashes = tuple(command.command_hash for command in transaction.commands)
        command_set_digest = commands_sha256(command_hashes)
        if transaction.commands_sha256 != command_set_digest:
            raise ImportApprovalEvidenceMismatch("mapping command digest is inconsistent")
        if mapping_evidence.transaction_commands_sha256 != command_set_digest:
            raise ImportApprovalEvidenceMismatch(
                "durable mapping evidence command digest is inconsistent"
            )
        if (
            mapping_evidence.mapper_candidate_sha256
            != canonical_candidate.candidate_sha256
            or mapping_evidence.source_import_evidence_sha256
            != canonical_candidate.source_import_evidence_sha256
            or mapping_evidence.source_bundle_ir_sha256
            != canonical_candidate.source_bundle_ir_sha256
            or mapping_evidence.diagnostics_manifest_sha256
            != canonical_candidate.diagnostics_manifest_sha256
            or mapping_evidence.provenance_set_sha256
            != canonical_candidate.provenance_set_sha256
            or mapping_evidence.mapping_advisories != mapping.advisories
        ):
            raise ImportApprovalEvidenceMismatch(
                "durable mapping evidence does not reproduce the exact canonical mapping"
            )
        preview = import_preview_digest(
            base_revision=context.base_revision,
            transaction_id=transaction.transaction_id,
            prospective_graph_sha256=context.prospective_graph_sha256,
            command_hashes=command_hashes,
        )
        prospective = prospective_revision_sha256(
            project_id=context.project_id,
            base_revision=context.base_revision,
            prospective_graph_sha256=context.prospective_graph_sha256,
            commands_digest=command_set_digest,
            preview_digest=preview,
        )
        self._require_context_authority_current(context)
        return _Evidence(
            candidate=candidate,
            mapping=mapping,
            mapping_evidence=mapping_evidence,
            context=context,
            candidate_sha256=candidate.candidate_digest,
            canonical_candidate_sha256=canonical_candidate.candidate_sha256,
            mapper_result_sha256=mapping.mapping_sha256,
            command_hashes=command_hashes,
            commands_sha256=command_set_digest,
            preview_digest=preview,
            prospective_revision_sha256=prospective,
        )

    @staticmethod
    def _require_evidence_input_types(
        candidate: ImportCandidate,
        mapping: ImportMappingResult,
        mapping_evidence: CanonicalMappingEvidence,
        context: ImportApprovalContext,
    ) -> None:
        if (
            type(candidate) is not ImportCandidate
            or type(mapping) is not ImportMappingResult
            or type(mapping_evidence) is not CanonicalMappingEvidence
            or type(context) is not ImportApprovalContext
        ):
            raise ImportApprovalInvariantError(
                "approval evidence requires exact concrete record types"
            )

    @staticmethod
    def _candidate_version_sha256(candidate: ImportCandidate) -> str:
        if type(candidate) is not ImportCandidate or type(candidate.state) is not CandidateState:
            raise ImportApprovalIntegrityError(
                "candidate repository returned a non-concrete record"
            )
        return stable_hash(
            {
                "candidate_id": candidate.candidate_id,
                "candidate_sha256": candidate.candidate_digest,
                "generation": candidate.generation,
                "last_event_sha256": candidate.last_event_digest,
                "state": candidate.state.value,
            },
            domain="flux-clone-import-approval-candidate-version-v1",
        )

    @staticmethod
    def _mapping_version_sha256(mapping: CanonicalMappingEvidence) -> str:
        if (
            type(mapping) is not CanonicalMappingEvidence
            or type(mapping.state) is not MappingEvidenceState
        ):
            raise ImportApprovalIntegrityError(
                "mapping repository returned a non-concrete record"
            )
        return stable_hash(
            {
                "mapping_evidence_id": mapping.mapping_evidence_id,
                "mapping_evidence_sha256": mapping.mapping_evidence_digest,
                "generation": mapping.generation,
                "last_event_sha256": mapping.last_event_digest,
                "state": mapping.state.value,
            },
            domain="flux-clone-import-approval-mapping-version-v1",
        )

    def _collect_source_snapshot(
        self,
        *,
        candidate_id: str,
        mapping_evidence_id: str,
        project_id: str,
        run_id: str,
    ) -> ApprovalSourceSnapshot:
        try:
            candidate = self._candidate_repository.get(candidate_id)
            mapping = self._mapping_evidence_repository.get(mapping_evidence_id)
            authority = self._current_authority_provider.current_authority(
                project_id=project_id,
                run_id=run_id,
            )
            principal_authority_snapshot = (
                self._trusted_principal_provider.principal_authority_snapshot_sha256()
            )
        except Exception as exc:
            raise ImportApprovalStale(
                "approval source version tokens could not be collected"
            ) from exc
        if type(authority) is not CurrentAuthoritySnapshot:
            raise ImportApprovalIntegrityError(
                "authority provider returned a non-concrete snapshot"
            )
        if type(principal_authority_snapshot) is not str:
            raise ImportApprovalIntegrityError(
                "principal provider returned a non-concrete authority snapshot"
            )
        return ApprovalSourceSnapshot.create(
            candidate_id=candidate_id,
            candidate_version_sha256=self._candidate_version_sha256(candidate),
            mapping_evidence_id=mapping_evidence_id,
            mapping_version_sha256=self._mapping_version_sha256(mapping),
            authority_snapshot_sha256=authority.snapshot_digest,
            principal_authority_snapshot_sha256=principal_authority_snapshot,
        )

    def _collect_request_source_snapshot(
        self,
        request: MappingApprovalRequest,
    ) -> ApprovalSourceSnapshot:
        return self._collect_source_snapshot(
            candidate_id=request.candidate_id,
            mapping_evidence_id=request.mapping_evidence_id,
            project_id=request.project_id,
            run_id=request.run_id,
        )

    def _source_snapshot_for_evidence(
        self,
        evidence: _Evidence,
        principal_authority_snapshot_sha256: str,
    ) -> ApprovalSourceSnapshot:
        return ApprovalSourceSnapshot.create(
            candidate_id=evidence.candidate.candidate_id,
            candidate_version_sha256=self._candidate_version_sha256(
                evidence.candidate
            ),
            mapping_evidence_id=evidence.mapping_evidence.mapping_evidence_id,
            mapping_version_sha256=self._mapping_version_sha256(
                evidence.mapping_evidence
            ),
            authority_snapshot_sha256=(
                evidence.context.authority_snapshot.snapshot_digest
            ),
            principal_authority_snapshot_sha256=(
                principal_authority_snapshot_sha256
            ),
        )

    def _require_stable_source_snapshot(
        self,
        before: ApprovalSourceSnapshot,
        after: ApprovalSourceSnapshot,
        evidence: _Evidence,
    ) -> None:
        expected = self._source_snapshot_for_evidence(
            evidence,
            after.principal_authority_snapshot_sha256,
        )
        if (
            type(before) is not ApprovalSourceSnapshot
            or type(after) is not ApprovalSourceSnapshot
            or before.snapshot_sha256 != after.snapshot_sha256
            or after.snapshot_sha256 != expected.snapshot_sha256
        ):
            raise ImportApprovalStale(
                "candidate, mapping, or authority changed during double collection"
            )

    @staticmethod
    def _require_stable_request_source_snapshot(
        before: ApprovalSourceSnapshot,
        after: ApprovalSourceSnapshot,
        request: MappingApprovalRequest,
    ) -> None:
        if (
            type(before) is not ApprovalSourceSnapshot
            or type(after) is not ApprovalSourceSnapshot
            or before.snapshot_sha256 != after.snapshot_sha256
            or after.snapshot_sha256 != request.source_snapshot_sha256
        ):
            raise ImportApprovalStale(
                "request source tokens changed during double collection"
            )

    def _cas_source_snapshot(
        self,
        expected: ApprovalSourceSnapshot,
        operation_id: str,
    ) -> None:
        try:
            current = self._source_cas_provider.compare_and_swap_source_snapshot(
                expected=expected,
                operation_id=operation_id,
            )
        except Exception as exc:
            raise ImportApprovalStale(
                "approval source CAS freshness fence failed"
            ) from exc
        if (
            type(current) is not ApprovalSourceSnapshot
            or current.snapshot_sha256 != expected.snapshot_sha256
        ):
            raise ImportApprovalStale(
                "approval source CAS returned a contradictory snapshot"
            )

    @staticmethod
    def _source_operation_id(kind: str, digest: str) -> str:
        return f"source-fence-{kind}-{digest[:32]}"

    def _subject_material(
        self,
        evidence: _Evidence,
        review_manifest: ReviewManifest,
        generation_fence: str,
        source_snapshot: ApprovalSourceSnapshot,
    ) -> dict[str, object]:
        candidate = evidence.candidate
        transaction = evidence.mapping.transaction_input
        assert transaction is not None
        return {
            "scope": ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE.value,
            "issuer_id": self._issuer_id,
            "candidate": {
                "candidate_id": candidate.candidate_id,
                "candidate_sha256": evidence.candidate_sha256,
                "generation": candidate.generation,
                "last_event_sha256": candidate.last_event_digest,
                "inspection_receipt_sha256": candidate.inspection_receipt_digest,
                "resolution_receipt_sha256": (
                    evidence.mapping_evidence.mapping_evidence_digest
                ),
            },
            "mapping": {
                "mapping_evidence_id": (
                    evidence.mapping_evidence.mapping_evidence_id
                ),
                "mapping_evidence_sha256": (
                    evidence.mapping_evidence.mapping_evidence_digest
                ),
                "mapping_evidence_generation": (
                    evidence.mapping_evidence.generation
                ),
                "mapping_evidence_last_event_sha256": (
                    evidence.mapping_evidence.last_event_digest
                ),
                "canonical_candidate_sha256": evidence.canonical_candidate_sha256,
                "mapper_result_sha256": evidence.mapper_result_sha256,
                "mapping_generation_fence_sha256": generation_fence,
                "source_snapshot_sha256": source_snapshot.snapshot_sha256,
            },
            "canonical_state": {
                "project_id": evidence.context.project_id,
                "base_revision": evidence.context.base_revision,
                "prospective_graph_sha256": evidence.context.prospective_graph_sha256,
                "prospective_revision_sha256": evidence.prospective_revision_sha256,
            },
            "commands": {
                "transaction_id": transaction.transaction_id,
                "command_hashes": evidence.command_hashes,
                "commands_sha256": evidence.commands_sha256,
                "preview_digest": evidence.preview_digest,
                "review_manifest_sha256": review_manifest.manifest_sha256,
            },
            "authority": {
                "uploader_actor": evidence.context.uploader_principal.principal_id,
                "authorized_human_actor": evidence.context.authorized_human_actor,
                "mapping_command_actor": evidence.context.mapping_command_actor,
                "staging_service_actor": evidence.context.staging_service_actor,
                "uploader_principal_sha256": (
                    evidence.context.uploader_principal.principal_digest
                ),
                "reviewer_principal_sha256": (
                    evidence.context.authorized_human_principal.principal_digest
                ),
                "mapper_principal_sha256": (
                    evidence.context.mapping_command_principal.principal_digest
                ),
                "staging_service_principal_sha256": (
                    evidence.context.staging_service_principal.principal_digest
                ),
                "run_id": evidence.context.run_id,
                "run_revision": evidence.context.run_revision,
                "project_event_head_sha256": (
                    evidence.context.project_event_head_sha256
                ),
                "run_incarnation": evidence.context.run_incarnation,
                "run_event_head_sha256": evidence.context.run_event_head_sha256,
                "coordination_incarnation": evidence.context.coordination_incarnation,
                "coordination_context_digest": (
                    evidence.context.coordination_context_digest
                ),
                "coordination_event_head_sha256": (
                    evidence.context.coordination_event_head_sha256
                ),
                "target_store_id": evidence.context.target_store_id,
                "target_store_incarnation": (
                    evidence.context.target_store_incarnation
                ),
                "authority_snapshot_sha256": (
                    evidence.context.authority_snapshot.snapshot_digest
                ),
                "principal_authority_snapshot_sha256": (
                    source_snapshot.principal_authority_snapshot_sha256
                ),
            },
        }

    def _require_evidence_matches_request(
        self,
        request: MappingApprovalRequest,
        evidence: _Evidence,
        source_snapshot: ApprovalSourceSnapshot,
    ) -> None:
        candidate = evidence.candidate
        transaction = evidence.mapping.transaction_input
        assert transaction is not None
        expected = (
            request.candidate_id == candidate.candidate_id
            and request.candidate_sha256 == evidence.candidate_sha256
            and request.candidate_generation == candidate.generation
            and request.candidate_last_event_sha256 == candidate.last_event_digest
            and request.inspection_receipt_sha256 == candidate.inspection_receipt_digest
            and request.resolution_receipt_sha256
            == evidence.mapping_evidence.mapping_evidence_digest
            and request.mapping_evidence_id
            == evidence.mapping_evidence.mapping_evidence_id
            and request.mapping_evidence_sha256
            == evidence.mapping_evidence.mapping_evidence_digest
            and request.mapping_evidence_generation
            == evidence.mapping_evidence.generation
            and request.mapping_evidence_last_event_sha256
            == evidence.mapping_evidence.last_event_digest
            and request.canonical_candidate_sha256
            == evidence.canonical_candidate_sha256
            and request.mapper_result_sha256 == evidence.mapper_result_sha256
            and request.mapping_generation_fence_sha256
            == self._generation_fence(evidence)
            and request.source_snapshot_sha256
            == source_snapshot.snapshot_sha256
            and request.principal_authority_snapshot_sha256
            == source_snapshot.principal_authority_snapshot_sha256
            and request.project_id == evidence.context.project_id
            and request.base_revision == evidence.context.base_revision
            and request.prospective_graph_sha256
            == evidence.context.prospective_graph_sha256
            and request.prospective_revision_sha256
            == evidence.prospective_revision_sha256
            and request.transaction_id == transaction.transaction_id
            and request.command_hashes == evidence.command_hashes
            and request.commands_sha256 == evidence.commands_sha256
            and request.preview_digest == evidence.preview_digest
            and request.review_manifest.commands_sha256 == evidence.commands_sha256
            and request.review_manifest.provenance_set_sha256
            == evidence.mapping_evidence.provenance_set_sha256
            and request.review_manifest.advisories_sha256
            == self._advisories_sha256(evidence.mapping.advisories)
            and request.uploader_actor
            == evidence.context.uploader_principal.principal_id
            and request.authorized_human_actor
            == evidence.context.authorized_human_actor
            and request.mapping_command_actor
            == evidence.context.mapping_command_actor
            and request.staging_service_actor
            == evidence.context.staging_service_actor
            and request.uploader_principal_sha256
            == evidence.context.uploader_principal.principal_digest
            and request.reviewer_principal_sha256
            == evidence.context.authorized_human_principal.principal_digest
            and request.mapper_principal_sha256
            == evidence.context.mapping_command_principal.principal_digest
            and request.staging_service_principal_sha256
            == evidence.context.staging_service_principal.principal_digest
            and request.run_id == evidence.context.run_id
            and request.run_revision == evidence.context.run_revision
            and request.project_event_head_sha256
            == evidence.context.project_event_head_sha256
            and request.run_incarnation == evidence.context.run_incarnation
            and request.run_event_head_sha256
            == evidence.context.run_event_head_sha256
            and request.coordination_incarnation
            == evidence.context.coordination_incarnation
            and request.coordination_context_digest
            == evidence.context.coordination_context_digest
            and request.coordination_event_head_sha256
            == evidence.context.coordination_event_head_sha256
            and request.target_store_id == evidence.context.target_store_id
            and request.target_store_incarnation
            == evidence.context.target_store_incarnation
            and request.authority_snapshot_sha256
            == evidence.context.authority_snapshot.snapshot_digest
        )
        if not expected:
            raise ImportApprovalStale(
                "candidate, mapping, commands, revision, or coordination context changed"
            )
        current_subject = stable_hash(
            self._subject_material(
                evidence,
                request.review_manifest,
                request.mapping_generation_fence_sha256,
                source_snapshot,
            ),
            domain="flux-clone-import-mapping-approval-subject-v1",
        )
        if current_subject != request.subject_digest:
            raise ImportApprovalEvidenceMismatch(
                "current import evidence does not reproduce the approved subject"
            )

    def _build_authorization(
        self,
        *,
        request: MappingApprovalRequest,
        approval: HumanMappingApproval,
        evidence: _Evidence,
        issued_at: datetime,
    ) -> AuthorizedImportStagingInput:
        transaction = evidence.mapping.transaction_input
        assert transaction is not None
        material = {
            "issuer_id": self._issuer_id,
            "request_id": request.request_id,
            "request_digest": request.request_digest,
            "subject_digest": request.subject_digest,
            "mapping_approval_id": approval.approval_id,
            "mapping_approval_digest": approval.approval_digest,
            "candidate_id": request.candidate_id,
            "candidate_sha256": request.candidate_sha256,
            "candidate_generation": request.candidate_generation,
            "candidate_last_event_sha256": request.candidate_last_event_sha256,
            "mapping_evidence_id": request.mapping_evidence_id,
            "mapping_evidence_sha256": request.mapping_evidence_sha256,
            "mapping_evidence_generation": request.mapping_evidence_generation,
            "mapping_evidence_last_event_sha256": (
                request.mapping_evidence_last_event_sha256
            ),
            "canonical_candidate_sha256": request.canonical_candidate_sha256,
            "mapper_result_sha256": request.mapper_result_sha256,
            "source_snapshot_sha256": request.source_snapshot_sha256,
            "project_id": request.project_id,
            "base_revision": request.base_revision,
            "prospective_graph_sha256": request.prospective_graph_sha256,
            "prospective_revision_sha256": request.prospective_revision_sha256,
            "transaction_id": request.transaction_id,
            "command_hashes": request.command_hashes,
            "commands_sha256": request.commands_sha256,
            "preview_digest": request.preview_digest,
            "review_manifest_sha256": request.review_manifest.manifest_sha256,
            "operation_key": request.operation_key,
            "uploader_actor": request.uploader_actor,
            "authorized_human_actor": request.authorized_human_actor,
            "mapping_command_actor": request.mapping_command_actor,
            "staging_service_actor": request.staging_service_actor,
            "uploader_principal_sha256": request.uploader_principal_sha256,
            "reviewer_principal_sha256": request.reviewer_principal_sha256,
            "mapper_principal_sha256": request.mapper_principal_sha256,
            "staging_service_principal_sha256": (
                request.staging_service_principal_sha256
            ),
            "run_id": request.run_id,
            "run_revision": request.run_revision,
            "project_event_head_sha256": request.project_event_head_sha256,
            "run_incarnation": request.run_incarnation,
            "run_event_head_sha256": request.run_event_head_sha256,
            "coordination_incarnation": request.coordination_incarnation,
            "coordination_context_digest": request.coordination_context_digest,
            "coordination_event_head_sha256": (
                request.coordination_event_head_sha256
            ),
            "target_store_id": request.target_store_id,
            "target_store_incarnation": request.target_store_incarnation,
            "authority_snapshot_sha256": request.authority_snapshot_sha256,
            "principal_authority_snapshot_sha256": (
                request.principal_authority_snapshot_sha256
            ),
            "issued_at": _time_text(issued_at),
            "expires_at": _time_text(request.expires_at),
            "lifecycle_generation": 2,
            "scope": ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE.value,
            "authorizes_internal_commit": False,
            "authorizes_manufacturing_release": False,
            "commit_approval_id": None,
            "release_approval_id": None,
        }
        digest = stable_hash(
            material,
            domain="flux-clone-authorized-import-staging-input-v1",
        )
        authorization_id = f"{_AUTHORIZATION_PREFIX}{digest[:32]}"
        seal = self._seal(
            "authorized-staging-input",
            {
                "authorization_id": authorization_id,
                "authorization_digest": digest,
                "mapping_approval_digest": approval.approval_digest,
                "subject_digest": request.subject_digest,
            },
        )
        return AuthorizedImportStagingInput(
            authorization_id=authorization_id,
            issuer_id=self._issuer_id,
            request_id=request.request_id,
            request_digest=request.request_digest,
            subject_digest=request.subject_digest,
            mapping_approval_id=approval.approval_id,
            mapping_approval_digest=approval.approval_digest,
            candidate_id=request.candidate_id,
            candidate_sha256=request.candidate_sha256,
            candidate_generation=request.candidate_generation,
            candidate_last_event_sha256=request.candidate_last_event_sha256,
            mapping_evidence_id=request.mapping_evidence_id,
            mapping_evidence_sha256=request.mapping_evidence_sha256,
            mapping_evidence_generation=request.mapping_evidence_generation,
            mapping_evidence_last_event_sha256=(
                request.mapping_evidence_last_event_sha256
            ),
            canonical_candidate_sha256=request.canonical_candidate_sha256,
            mapper_result_sha256=request.mapper_result_sha256,
            source_snapshot_sha256=request.source_snapshot_sha256,
            project_id=request.project_id,
            base_revision=request.base_revision,
            prospective_graph_sha256=request.prospective_graph_sha256,
            prospective_revision_sha256=request.prospective_revision_sha256,
            transaction_id=request.transaction_id,
            command_hashes=request.command_hashes,
            commands_sha256=request.commands_sha256,
            preview_digest=request.preview_digest,
            review_manifest_sha256=request.review_manifest.manifest_sha256,
            operation_key=request.operation_key,
            uploader_actor=request.uploader_actor,
            authorized_human_actor=request.authorized_human_actor,
            mapping_command_actor=request.mapping_command_actor,
            staging_service_actor=request.staging_service_actor,
            uploader_principal_sha256=request.uploader_principal_sha256,
            reviewer_principal_sha256=request.reviewer_principal_sha256,
            mapper_principal_sha256=request.mapper_principal_sha256,
            staging_service_principal_sha256=(
                request.staging_service_principal_sha256
            ),
            run_id=request.run_id,
            run_revision=request.run_revision,
            project_event_head_sha256=request.project_event_head_sha256,
            run_incarnation=request.run_incarnation,
            run_event_head_sha256=request.run_event_head_sha256,
            coordination_incarnation=request.coordination_incarnation,
            coordination_context_digest=request.coordination_context_digest,
            coordination_event_head_sha256=request.coordination_event_head_sha256,
            target_store_id=request.target_store_id,
            target_store_incarnation=request.target_store_incarnation,
            authority_snapshot_sha256=request.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                request.principal_authority_snapshot_sha256
            ),
            issued_at=issued_at,
            expires_at=request.expires_at,
            lifecycle_generation=2,
            transaction_input=transaction,
            authorization_digest=digest,
            issuer_seal=seal,
        )

    def _verified_record_locked(
        self,
        request: MappingApprovalRequest,
        now: datetime,
    ) -> _Record:
        original = self._records.get(request.request_id)
        if original is None:
            raise ImportApprovalLifecycleError("mapping approval request is unknown")
        record = self._expire_locked(original, now)
        if record.state is ImportApprovalLifecycle.EXPIRED:
            self._persist_if_changed_locked(original, record, now)
            raise ImportApprovalExpired("mapping approval request expired")
        if record.request != request:
            raise ImportApprovalEvidenceMismatch(
                "mapping request was altered or rebound after issuance"
            )
        if request.issuer_id != self._issuer_id:
            raise ImportApprovalEvidenceMismatch("mapping request issuer changed")
        expected = self._seal(
            "mapping-request",
            {
                "request_id": request.request_id,
                "request_digest": request.request_digest,
                "subject_digest": request.subject_digest,
            },
        )
        if not hmac.compare_digest(request.issuer_seal, expected):
            raise ImportApprovalEvidenceMismatch(
                "mapping request issuer seal is invalid"
            )
        return record

    def _record_for_approval_locked(
        self,
        approval: HumanMappingApproval,
        now: datetime,
    ) -> _Record:
        original = self._records.get(approval.request_id)
        if original is None:
            raise ImportApprovalLifecycleError("mapping approval is unknown")
        record = self._expire_locked(original, now)
        if record.state is ImportApprovalLifecycle.EXPIRED:
            self._persist_if_changed_locked(original, record, now)
            raise ImportApprovalExpired("mapping approval expired")
        if record.approval != approval:
            raise ImportApprovalEvidenceMismatch(
                "mapping approval was altered or replayed against another request"
            )
        if approval.issuer_id != self._issuer_id:
            raise ImportApprovalEvidenceMismatch("mapping approval issuer changed")
        expected = self._seal(
            "human-mapping-approval",
            {
                "approval_id": approval.approval_id,
                "approval_digest": approval.approval_digest,
                "request_digest": approval.request_digest,
            },
        )
        if not hmac.compare_digest(approval.issuer_seal, expected):
            raise ImportApprovalEvidenceMismatch("mapping approval issuer seal is invalid")
        return record

    def _require_principal(
        self,
        principal: AuthenticatedPrincipal,
        role: PrincipalRole,
    ) -> None:
        if type(principal) is not AuthenticatedPrincipal:
            raise ImportApprovalInvariantError(
                "approval actor must be a server-derived AuthenticatedPrincipal"
            )
        if principal.role is not role:
            raise ImportApprovalActorMismatch(
                f"approval principal requires role {role.value}"
            )
        if principal.authority_id != self._principal_authority_id:
            raise ImportApprovalActorMismatch(
                "approval principal was issued by an untrusted identity authority"
            )
        try:
            trusted = self._trusted_principal_provider.attest_principal(
                principal=principal,
                role=role,
            )
        except Exception as exc:
            raise ImportApprovalActorMismatch(
                "approval principal could not be resolved by the trusted identity provider"
            ) from exc
        if type(trusted) is not AuthenticatedPrincipal:
            raise ImportApprovalIntegrityError(
                "trusted identity provider returned an invalid principal"
            )
        if trusted is not principal:
            raise ImportApprovalActorMismatch(
                "approval principal is stale or was not server-derived"
            )

    def _require_context_principals(self, context: ImportApprovalContext) -> None:
        for principal, role in (
            (context.uploader_principal, PrincipalRole.HUMAN_REVIEWER),
            (context.authorized_human_principal, PrincipalRole.HUMAN_REVIEWER),
            (context.mapping_command_principal, PrincipalRole.TRUSTED_MAPPER),
            (context.staging_service_principal, PrincipalRole.STAGING_SERVICE),
        ):
            self._require_principal(principal, role)
        protected_ids = {
            context.mapping_command_principal.principal_id,
            context.staging_service_principal.principal_id,
        }
        if len(protected_ids) != 2 or protected_ids.intersection(
            {
                context.uploader_principal.principal_id,
                context.authorized_human_principal.principal_id,
            }
        ):
            raise ImportApprovalActorMismatch(
                "human, mapper, and staging-service principals must be role-separated"
            )

    def _require_context_authority_current(
        self,
        context: ImportApprovalContext,
    ) -> None:
        try:
            current = self._current_authority_provider.current_authority(
                project_id=context.project_id,
                run_id=context.run_id,
            )
        except Exception as exc:
            raise ImportApprovalStale(
                "current project/run/coordination authority could not be loaded"
            ) from exc
        if type(current) is not CurrentAuthoritySnapshot:
            raise ImportApprovalIntegrityError(
                "current authority provider returned an invalid snapshot"
            )
        if current != context.authority_snapshot:
            raise ImportApprovalStale(
                "project head, run, coordination, or target-store authority changed"
            )

    def _require_request_authority_current(
        self,
        request: MappingApprovalRequest,
    ) -> None:
        expected = CurrentAuthoritySnapshot(
            project_id=request.project_id,
            project_head_revision=request.base_revision,
            project_event_head_sha256=request.project_event_head_sha256,
            run_id=request.run_id,
            run_revision=request.run_revision,
            run_incarnation=request.run_incarnation,
            run_event_head_sha256=request.run_event_head_sha256,
            coordination_context_digest=request.coordination_context_digest,
            coordination_incarnation=request.coordination_incarnation,
            coordination_event_head_sha256=request.coordination_event_head_sha256,
            target_store_id=request.target_store_id,
            target_store_incarnation=request.target_store_incarnation,
        )
        if expected.snapshot_digest != request.authority_snapshot_sha256:
            raise ImportApprovalIntegrityError(
                "mapping request authority snapshot digest is inconsistent"
            )
        try:
            current = self._current_authority_provider.current_authority(
                project_id=request.project_id,
                run_id=request.run_id,
            )
        except Exception as exc:
            raise ImportApprovalStale("current authority could not be loaded") from exc
        if type(current) is not CurrentAuthoritySnapshot:
            raise ImportApprovalIntegrityError(
                "current authority provider returned an invalid snapshot"
            )
        if current != expected:
            raise ImportApprovalStale(
                "mapping request no longer names the current authority snapshot"
            )

    def _require_request_repositories_current(
        self,
        request: MappingApprovalRequest,
    ) -> None:
        """Re-read the durable request evidence before recording a decision."""

        try:
            candidate = self._candidate_repository.get(request.candidate_id)
            mapping_evidence = self._mapping_evidence_repository.get(
                request.mapping_evidence_id
            )
        except Exception as exc:
            raise ImportApprovalStale(
                "current durable import evidence could not be loaded for decision"
            ) from exc
        if (
            type(candidate) is not ImportCandidate
            or type(mapping_evidence) is not CanonicalMappingEvidence
        ):
            raise ImportApprovalIntegrityError(
                "durable repositories returned non-concrete decision evidence"
            )
        if (
            candidate.candidate_digest != request.candidate_sha256
            or candidate.generation != request.candidate_generation
            or candidate.last_event_digest != request.candidate_last_event_sha256
            or candidate.inspection_receipt_digest
            != request.inspection_receipt_sha256
            or candidate.resolution_receipt_digest
            != request.resolution_receipt_sha256
            or candidate.state is not CandidateState.RESOLVED
            or mapping_evidence.mapping_evidence_digest
            != request.mapping_evidence_sha256
            or mapping_evidence.generation
            != request.mapping_evidence_generation
            or mapping_evidence.last_event_digest
            != request.mapping_evidence_last_event_sha256
            or mapping_evidence.state is not MappingEvidenceState.ACTIVE
        ):
            raise ImportApprovalStale(
                "durable candidate or mapping evidence changed before decision"
            )

    def _require_generation_not_rejected_locked(
        self,
        request: MappingApprovalRequest,
    ) -> None:
        rejected_request_id = self._rejection_fences.get(
            request.mapping_generation_fence_sha256
        )
        if rejected_request_id is not None and rejected_request_id != request.request_id:
            raise ImportApprovalLifecycleError(
                "this candidate/mapping generation has a durable rejection; "
                "new candidate or mapping evidence is required"
            )

    @staticmethod
    def _advisories_sha256(advisories: tuple[object, ...]) -> str:
        return stable_hash(
            advisories,
            domain="flux-clone-import-review-advisories-v1",
        )

    @staticmethod
    def _generation_fence(evidence: _Evidence) -> str:
        return mapping_generation_fence_sha256(
            candidate_id=evidence.candidate.candidate_id,
            candidate_sha256=evidence.candidate_sha256,
            candidate_generation=evidence.candidate.generation,
            mapping_evidence_id=evidence.mapping_evidence.mapping_evidence_id,
            mapping_evidence_sha256=(
                evidence.mapping_evidence.mapping_evidence_digest
            ),
            mapping_evidence_generation=evidence.mapping_evidence.generation,
            canonical_candidate_sha256=evidence.canonical_candidate_sha256,
            mapper_result_sha256=evidence.mapper_result_sha256,
        )

    def _require_review_manifest(
        self,
        manifest: ReviewManifest,
        evidence: _Evidence,
    ) -> None:
        if (
            manifest.commands_sha256 != evidence.commands_sha256
            or manifest.provenance_set_sha256
            != evidence.mapping_evidence.provenance_set_sha256
            or manifest.advisories_sha256
            != self._advisories_sha256(evidence.mapping.advisories)
        ):
            raise ImportApprovalEvidenceMismatch(
                "review manifest does not bind the exact commands, provenance, and advisories"
            )
        semantic = json.loads(manifest.semantic_diff_json)
        transaction = evidence.mapping.transaction_input
        assert transaction is not None
        required = {
            "projectId": evidence.context.project_id,
            "baseRevision": evidence.context.base_revision,
            "transactionId": transaction.transaction_id,
            "prospectiveGraphSha256": evidence.context.prospective_graph_sha256,
            "previewDigest": evidence.preview_digest,
            "orderedCommandHashes": list(evidence.command_hashes),
        }
        if any(semantic.get(key) != value for key, value in required.items()):
            raise ImportApprovalEvidenceMismatch(
                "review semantic diff does not reproduce the exact staged preview"
            )

    def _record_payload(self, record: _Record) -> dict[str, object]:
        return {
            "version": 1,
            "request": record.request,
            "state": record.state.value,
            "generation": record.generation,
            "approval": record.approval,
            "authorization": record.authorization,
            "invalidated_by": record.invalidated_by,
            "invalidated_principal_sha256": record.invalidated_principal_sha256,
            "invalidation_reason": record.invalidation_reason,
        }

    def _record_from_json(self, source: str) -> _Record:
        payload = decode_record_json(source)
        expected_keys = {
            "version",
            "request",
            "state",
            "generation",
            "approval",
            "authorization",
            "invalidated_by",
            "invalidated_principal_sha256",
            "invalidation_reason",
        }
        if set(payload) != expected_keys or payload["version"] != 1:
            raise ImportApprovalIntegrityError(
                "approval ledger snapshot schema is not exact"
            )
        try:
            state = ImportApprovalLifecycle(payload["state"])
            record = _Record(
                request=payload["request"],
                state=state,
                generation=payload["generation"],
                approval=payload["approval"],
                authorization=payload["authorization"],
                invalidated_by=payload["invalidated_by"],
                invalidated_principal_sha256=(
                    payload["invalidated_principal_sha256"]
                ),
                invalidation_reason=payload["invalidation_reason"],
            )
            record.status()
        except Exception as exc:
            if isinstance(exc, ImportApprovalIntegrityError):
                raise
            raise ImportApprovalIntegrityError(
                "approval ledger lifecycle snapshot is invalid"
            ) from exc
        self._verify_request_seal(record.request)
        if record.approval is not None:
            self._verify_approval_seal(record.approval)
        if record.authorization is not None:
            self._verify_authorization_seal(record.authorization)
        return record

    def _verify_request_seal(self, request: MappingApprovalRequest) -> None:
        if request.issuer_id != self._issuer_id:
            raise ImportApprovalIntegrityError("mapping request issuer changed")
        expected = self._seal(
            "mapping-request",
            {
                "request_id": request.request_id,
                "request_digest": request.request_digest,
                "subject_digest": request.subject_digest,
            },
        )
        if not hmac.compare_digest(request.issuer_seal, expected):
            raise ImportApprovalIntegrityError("mapping request issuer seal is invalid")

    def _verify_approval_seal(self, approval: HumanMappingApproval) -> None:
        if approval.issuer_id != self._issuer_id:
            raise ImportApprovalIntegrityError("mapping approval issuer changed")
        expected = self._seal(
            "human-mapping-approval",
            {
                "approval_id": approval.approval_id,
                "approval_digest": approval.approval_digest,
                "request_digest": approval.request_digest,
            },
        )
        if not hmac.compare_digest(approval.issuer_seal, expected):
            raise ImportApprovalIntegrityError("mapping approval issuer seal is invalid")

    def _reload_ledger_locked(self) -> None:
        events, head, last_at = self._ledger.load()
        records: dict[str, _Record] = {}
        subjects: dict[str, str] = {}
        operations: dict[str, str] = {}
        rejection_fences: dict[str, str] = {}
        for event in events:
            record = self._record_from_json(event.record_json)
            request = record.request
            if (
                event.request_id != request.request_id
                or event.subject_digest != request.subject_digest
                or event.operation_key != request.operation_key
                or event.state != record.state.value
                or event.generation != record.generation
            ):
                raise ImportApprovalIntegrityError(
                    "approval ledger event metadata contradicts its sealed snapshot"
                )
            previous = records.get(request.request_id)
            self._verify_event_snapshot_time(previous, record, event.occurred_at)
            if previous is None:
                existing_subject_id = subjects.get(request.subject_digest)
                if existing_subject_id is not None:
                    existing_subject = records[existing_subject_id]
                    if existing_subject.state is not ImportApprovalLifecycle.EXPIRED:
                        raise ImportApprovalIntegrityError(
                            "approval ledger contains a duplicate live or terminal subject"
                        )
                if (
                    record.state is not ImportApprovalLifecycle.REQUESTED
                    or record.generation != 0
                ):
                    raise ImportApprovalIntegrityError(
                        "approval lifecycle does not begin at requested generation zero"
                    )
            else:
                self._verify_transition(previous, record)
            operation_owner = operations.get(request.operation_key)
            if operation_owner is not None and operation_owner != request.request_id:
                raise ImportApprovalIntegrityError(
                    "approval operation key was replayed across requests"
                )
            records[request.request_id] = record
            subjects[request.subject_digest] = request.request_id
            operations[request.operation_key] = request.request_id
            if record.state is ImportApprovalLifecycle.REJECTED:
                existing_rejection = rejection_fences.get(
                    request.mapping_generation_fence_sha256
                )
                if (
                    existing_rejection is not None
                    and existing_rejection != request.request_id
                ):
                    raise ImportApprovalIntegrityError(
                        "approval ledger contains duplicate rejected generation fences"
                    )
                rejection_fences[
                    request.mapping_generation_fence_sha256
                ] = request.request_id
        self._ledger.confirm_verified_load(
            events,
            expected_head=head,
            last_at=last_at,
        )
        self._records = records
        self._subjects = subjects
        self._operations = operations
        self._rejection_fences = rejection_fences
        self._ledger_head = head
        if last_at is not None and (
            self._last_clock is None or last_at > self._last_clock
        ):
            self._last_clock = last_at

    @staticmethod
    def _verify_transition(previous: _Record, current: _Record) -> None:
        if current.request != previous.request:
            raise ImportApprovalIntegrityError(
                "approval lifecycle request changed across events"
            )
        allowed = {
            ImportApprovalLifecycle.REQUESTED: {
                ImportApprovalLifecycle.APPROVED,
                ImportApprovalLifecycle.REJECTED,
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            },
            ImportApprovalLifecycle.APPROVED: {
                ImportApprovalLifecycle.AUTHORIZED,
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            },
            ImportApprovalLifecycle.AUTHORIZED: {
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            },
        }
        if (
            current.state not in allowed.get(previous.state, set())
            or current.generation != previous.generation + 1
        ):
            raise ImportApprovalIntegrityError(
                "approval ledger contains an illegal lifecycle transition"
            )
        if previous.approval is not None and current.approval != previous.approval:
            raise ImportApprovalIntegrityError(
                "approval decision changed after it was recorded"
            )
        if (
            previous.authorization is not None
            and current.authorization != previous.authorization
        ):
            raise ImportApprovalIntegrityError(
                "staging authorization changed after it was recorded"
            )

    @staticmethod
    def _verify_event_snapshot_time(
        previous: _Record | None,
        current: _Record,
        occurred_at: datetime,
    ) -> None:
        request = current.request
        if previous is None:
            valid = (
                current.state is ImportApprovalLifecycle.REQUESTED
                and occurred_at == request.requested_at
            )
        elif current.state in {
            ImportApprovalLifecycle.APPROVED,
            ImportApprovalLifecycle.REJECTED,
        }:
            valid = (
                current.approval is not None
                and occurred_at == current.approval.decided_at
            )
        elif current.state is ImportApprovalLifecycle.AUTHORIZED:
            valid = (
                current.authorization is not None
                and occurred_at == current.authorization.issued_at
            )
        elif current.state is ImportApprovalLifecycle.EXPIRED:
            valid = occurred_at >= request.expires_at
        elif current.state is ImportApprovalLifecycle.INVALIDATED:
            evidence_time = request.requested_at
            if current.approval is not None:
                evidence_time = current.approval.decided_at
            if current.authorization is not None:
                evidence_time = current.authorization.issued_at
            valid = evidence_time <= occurred_at < request.expires_at
        else:
            valid = False
        if not valid:
            raise ImportApprovalIntegrityError(
                "approval ledger event time contradicts its lifecycle evidence"
            )

    def _persist_record_locked(self, record: _Record, occurred_at: datetime) -> None:
        record.status()
        previous = self._records.get(record.request.request_id)
        if previous is None:
            if (
                record.state is not ImportApprovalLifecycle.REQUESTED
                or record.generation != 0
            ):
                raise ImportApprovalIntegrityError(
                    "approval lifecycle must begin at requested generation zero"
                )
        elif previous != record:
            self._verify_transition(previous, record)
        else:
            raise ImportApprovalIntegrityError(
                "approval ledger refuses a duplicate lifecycle snapshot"
            )
        source = record_json(self._record_payload(record))
        self._ledger_head = self._ledger.append(
            expected_head=self._ledger_head,
            request_id=record.request.request_id,
            subject_digest=record.request.subject_digest,
            operation_key=record.request.operation_key,
            state=record.state.value,
            generation=record.generation,
            occurred_at=occurred_at,
            record_json=source,
        )
        self._records[record.request.request_id] = record
        self._subjects[record.request.subject_digest] = record.request.request_id
        self._operations[record.request.operation_key] = record.request.request_id
        if record.state is ImportApprovalLifecycle.REJECTED:
            self._rejection_fences[
                record.request.mapping_generation_fence_sha256
            ] = record.request.request_id

    def _persist_if_changed_locked(
        self,
        previous: _Record,
        current: _Record,
        occurred_at: datetime,
    ) -> None:
        if previous != current:
            self._persist_record_locked(current, occurred_at)

    def _verify_authorization_seal(
        self,
        authorization: AuthorizedImportStagingInput,
    ) -> None:
        if authorization.issuer_id != self._issuer_id:
            raise ImportApprovalEvidenceMismatch("staging authorization issuer changed")
        expected = self._seal(
            "authorized-staging-input",
            {
                "authorization_id": authorization.authorization_id,
                "authorization_digest": authorization.authorization_digest,
                "mapping_approval_digest": authorization.mapping_approval_digest,
                "subject_digest": authorization.subject_digest,
            },
        )
        if not hmac.compare_digest(authorization.issuer_seal, expected):
            raise ImportApprovalEvidenceMismatch(
                "staging authorization issuer seal is invalid"
            )

    @staticmethod
    def _require_generation(record: _Record, expected: int) -> None:
        if type(expected) is not int or expected < 0:
            raise ImportApprovalInvariantError(
                "expected lifecycle generation must be a non-negative integer"
            )
        if record.generation != expected:
            raise ImportApprovalStale(
                f"mapping approval generation is {record.generation}, not {expected}"
            )

    @staticmethod
    def _expire_locked(record: _Record, now: datetime) -> _Record:
        if record.state in {
            ImportApprovalLifecycle.EXPIRED,
            ImportApprovalLifecycle.INVALIDATED,
            ImportApprovalLifecycle.REJECTED,
        }:
            return record
        if now >= record.request.expires_at:
            return replace(
                record,
                state=ImportApprovalLifecycle.EXPIRED,
                generation=record.generation + 1,
            )
        return record

    def _seal(self, kind: str, material: dict[str, object]) -> str:
        payload = canonical_json(
            {
                "issuer_id": self._issuer_id,
                "kind": kind,
                "material": material,
            }
        ).encode("utf-8")
        return hmac.new(
            self._sealing_key,
            b"flux-clone-import-approval-seal-v1\0" + payload,
            hashlib.sha256,
        ).hexdigest()


__all__ = ("ImportApprovalContract",)
