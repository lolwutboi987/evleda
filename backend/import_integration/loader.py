"""Fail-closed reconstruction of one exact, inert resolved import subject."""

from __future__ import annotations

from dataclasses import replace
from typing import cast

from backend.canonical_import import (
    CanonicalImportCandidate,
    CanonicalImportTransactionInput,
    CanonicalMappingEvidence,
    ImportMappingResult,
    MappingEvidenceDraft,
    MappingEvidenceEvent,
    MappingEvidenceEventKind,
    MappingEvidenceNotFound,
    MappingEvidenceState,
    MappingEvidenceStoreError,
    MappingEvidenceStoreUnavailable,
)
from backend.import_approval import (
    CurrentAuthorityProvider,
    CurrentAuthoritySnapshot,
    import_preview_digest,
    prospective_revision_sha256,
)
from backend.interchange_artifacts import (
    ArtifactContent,
    ArtifactNotFound,
    ArtifactRecord,
    ArtifactStoreError,
    ArtifactStoreUnavailable,
)
from backend.kicad_import_candidates import (
    CandidateEventKind,
    CandidateIdentityScheme,
    CandidateNotFound,
    CandidateRepositoryError,
    CandidateState,
    CandidateStoreUnavailable,
    CandidateTransitionEvent,
    ImportCandidate,
)

from .models import (
    DeterministicImportRemapper,
    HostOwnedArtifactReader,
    ImportIntegrationConfigurationError,
    ImportIntegrationError,
    ImportSubjectIntegrityError,
    ImportSubjectInvalidRequest,
    ImportSubjectNotFound,
    ImportSubjectStale,
    ImportSubjectUnavailable,
    ResolvedCandidateReader,
    ResolvedImportSubject,
    ResolvedImportSubjectRequest,
    ResolvedImportSubjectRequestIssuer,
    ResolvedMappingReader,
    resolved_import_subject_sha256,
)


class ResolvedImportSubjectLoader:
    """Reconstruct a resolved import without granting any mutation authority."""

    def __init__(
        self,
        *,
        request_issuer: ResolvedImportSubjectRequestIssuer | None = None,
        artifact_reader: HostOwnedArtifactReader | None = None,
        candidate_repository: ResolvedCandidateReader | None = None,
        mapping_repository: ResolvedMappingReader | None = None,
        remapper: DeterministicImportRemapper | None = None,
        authority_provider: CurrentAuthorityProvider | None = None,
    ) -> None:
        if (
            type(request_issuer) is not ResolvedImportSubjectRequestIssuer
            or artifact_reader is None
            or candidate_repository is None
            or mapping_repository is None
            or remapper is None
            or authority_provider is None
        ):
            raise ImportIntegrationConfigurationError(
                "resolved import loading requires every trusted read adapter"
            )
        requirements = (
            (artifact_reader, HostOwnedArtifactReader, "artifact reader"),
            (
                candidate_repository,
                ResolvedCandidateReader,
                "candidate repository",
            ),
            (
                mapping_repository,
                ResolvedMappingReader,
                "mapping repository",
            ),
            (remapper, DeterministicImportRemapper, "deterministic remapper"),
            (
                authority_provider,
                CurrentAuthorityProvider,
                "current authority provider",
            ),
        )
        for value, protocol, label in requirements:
            if not isinstance(cast(object, value), protocol):
                raise ImportIntegrationConfigurationError(
                    f"resolved import loader requires a valid {label}"
                )
        self._request_issuer = request_issuer
        self._artifact_reader = artifact_reader
        self._candidate_repository = candidate_repository
        self._mapping_repository = mapping_repository
        self._remapper = remapper
        self._authority_provider = authority_provider

    def load(self, request: object) -> ResolvedImportSubject:
        """Return an inert exact subject after two-phase trusted rereads."""

        if type(request) is not ResolvedImportSubjectRequest:
            raise ImportSubjectInvalidRequest(
                "loader accepts only exact server-issued request records"
            )
        try:
            request.__post_init__()
        except ImportIntegrationError:
            raise
        except Exception as exc:
            raise ImportSubjectInvalidRequest(
                "server-issued request failed integrity validation"
            ) from exc
        if not request.was_issued_by(self._request_issuer):
            raise ImportSubjectInvalidRequest("request was issued by another server issuer")

        candidate, candidate_events = self._read_candidate(
            request.candidate_id,
            initial=True,
        )
        self._require_candidate_request(
            request,
            candidate,
            candidate_events,
        )
        mapping, mapping_events = self._read_named_mapping(candidate)
        self._require_mapping_request(request, mapping)
        self._require_candidate_mapping_chain(
            candidate,
            candidate_events,
            mapping,
        )

        authority = self._read_authority(
            project_id=request.project_id,
            run_id=request.run_id,
        )
        self._require_authority(
            request,
            candidate,
            mapping,
            authority,
        )
        artifact = self._read_artifact(request)
        self._require_artifact(request, candidate, mapping, artifact)

        # Retain exact validating clones so a hostile adapter cannot mutate a
        # shared frozen object with object.__setattr__ during another callback.
        candidate_snapshot = replace(candidate)
        authority_snapshot = replace(authority)
        artifact_snapshot = ArtifactContent(
            replace(artifact.record),
            bytes(artifact.payload),
        )

        mapping_result = self._remap(
            artifact=artifact_snapshot,
            candidate=candidate_snapshot,
            authority=authority_snapshot,
        )
        canonical_candidate, transaction_input = self._require_fresh_mapping(
            request,
            candidate_snapshot,
            candidate_events,
            mapping,
            mapping_result,
        )

        artifact_after = self._read_artifact(request)
        self._require_artifact(
            request,
            candidate_snapshot,
            mapping,
            artifact_after,
        )
        if artifact_after != artifact_snapshot:
            raise ImportSubjectIntegrityError(
                "managed artifact changed during deterministic remapping"
            )

        candidate_after, candidate_events_after = self._read_candidate(
            request.candidate_id,
            initial=False,
        )
        self._require_unchanged_candidate(
            candidate_snapshot,
            candidate_events,
            candidate_after,
            candidate_events_after,
        )
        mapping_after, mapping_events_after = self._read_named_mapping(candidate_after)
        self._require_unchanged_mapping(
            mapping,
            mapping_events,
            mapping_after,
            mapping_events_after,
        )
        authority_after = self._read_authority(
            project_id=request.project_id,
            run_id=request.run_id,
        )
        if authority_after != authority_snapshot:
            raise ImportSubjectStale(
                "current project, run, coordination, or store authority changed"
            )

        # Revalidate the fresh result after every external reread. The returned
        # subject contains projections only and cannot preserve mapper authority.
        canonical_candidate, transaction_input = self._require_fresh_mapping(
            request,
            candidate_after,
            candidate_events_after,
            mapping_after,
            mapping_result,
        )
        request.__post_init__()
        preview = import_preview_digest(
            base_revision=transaction_input.base_revision,
            transaction_id=transaction_input.transaction_id,
            prospective_graph_sha256=(transaction_input.prospective_graph_sha256),
            command_hashes=tuple(command.command_hash for command in transaction_input.commands),
        )
        prospective = prospective_revision_sha256(
            project_id=canonical_candidate.project_id,
            base_revision=transaction_input.base_revision,
            prospective_graph_sha256=(transaction_input.prospective_graph_sha256),
            commands_digest=transaction_input.commands_sha256,
            preview_digest=preview,
        )
        subject_digest = resolved_import_subject_sha256(
            request_digest=request.request_digest,
            artifact=artifact_after,
            candidate=candidate_after,
            candidate_events=candidate_events_after,
            mapping_evidence=mapping_after,
            mapping_events=mapping_events_after,
            canonical_candidate=canonical_candidate,
            transaction_input=transaction_input,
            mapping_result_sha256=mapping_result.mapping_sha256,
            authority=authority_after,
            preview_digest=preview,
            prospective_revision_digest=prospective,
        )
        return ResolvedImportSubject(
            request_id=request.request_id,
            request_digest=request.request_digest,
            artifact=artifact_after,
            candidate=candidate_after,
            candidate_events=candidate_events_after,
            mapping_evidence=mapping_after,
            mapping_events=mapping_events_after,
            canonical_candidate=canonical_candidate,
            transaction_input=transaction_input,
            mapping_result_sha256=mapping_result.mapping_sha256,
            authority=authority_after,
            preview_digest=preview,
            prospective_revision_sha256=prospective,
            subject_sha256=subject_digest,
        )

    def _read_candidate(
        self,
        candidate_id: str,
        *,
        initial: bool,
    ) -> tuple[ImportCandidate, tuple[CandidateTransitionEvent, ...]]:
        try:
            candidate = self._candidate_repository.get(candidate_id)
            events = self._candidate_repository.list_events(candidate_id)
        except CandidateNotFound as exc:
            if initial:
                raise ImportSubjectNotFound("resolved import candidate was not found") from exc
            raise ImportSubjectIntegrityError(
                "durable candidate disappeared during a read-only load"
            ) from exc
        except CandidateStoreUnavailable as exc:
            raise ImportSubjectUnavailable("candidate repository is unavailable") from exc
        except CandidateRepositoryError as exc:
            raise ImportSubjectIntegrityError(
                "candidate repository failed integrity validation"
            ) from exc
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "candidate adapter returned an unexpected failure"
            ) from exc
        if type(candidate) is not ImportCandidate:
            raise ImportSubjectIntegrityError("candidate adapter returned a non-concrete record")
        if type(events) is not tuple or any(
            type(event) is not CandidateTransitionEvent for event in events
        ):
            raise ImportSubjectIntegrityError(
                "candidate adapter returned a non-concrete event history"
            )
        try:
            candidate.__post_init__()
            for event in events:
                event.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "candidate adapter returned malformed durable evidence"
            ) from exc
        return replace(candidate), tuple(replace(event) for event in events)

    def _read_named_mapping(
        self,
        candidate: ImportCandidate,
    ) -> tuple[CanonicalMappingEvidence, tuple[MappingEvidenceEvent, ...]]:
        receipt = candidate.resolution_receipt_digest
        if receipt is None:
            raise ImportSubjectIntegrityError(
                "resolved candidate lacks its mapping-evidence receipt"
            )
        try:
            values = self._mapping_repository.list_for_candidate(candidate.candidate_id)
        except MappingEvidenceStoreUnavailable as exc:
            raise ImportSubjectUnavailable("mapping repository is unavailable") from exc
        except MappingEvidenceStoreError as exc:
            raise ImportSubjectIntegrityError(
                "mapping repository failed integrity validation"
            ) from exc
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "mapping adapter returned an unexpected failure"
            ) from exc
        if type(values) is not tuple or any(
            type(value) is not CanonicalMappingEvidence for value in values
        ):
            raise ImportSubjectIntegrityError("mapping adapter returned non-concrete records")
        try:
            for value in values:
                value.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "mapping adapter returned malformed durable evidence"
            ) from exc
        matches = tuple(value for value in values if value.mapping_evidence_digest == receipt)
        if len(matches) != 1:
            raise ImportSubjectIntegrityError(
                "candidate receipt does not identify one exact mapping record"
            )
        selected = matches[0]
        try:
            direct = self._mapping_repository.get(selected.mapping_evidence_id)
            events = self._mapping_repository.list_events(selected.mapping_evidence_id)
        except MappingEvidenceNotFound as exc:
            raise ImportSubjectIntegrityError(
                "receipt-selected mapping evidence disappeared"
            ) from exc
        except MappingEvidenceStoreUnavailable as exc:
            raise ImportSubjectUnavailable("mapping repository is unavailable") from exc
        except MappingEvidenceStoreError as exc:
            raise ImportSubjectIntegrityError(
                "mapping repository failed integrity validation"
            ) from exc
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "mapping adapter returned an unexpected failure"
            ) from exc
        if type(direct) is not CanonicalMappingEvidence or direct != selected:
            raise ImportSubjectIntegrityError("mapping list and item reads contradict each other")
        if type(events) is not tuple or any(
            type(event) is not MappingEvidenceEvent for event in events
        ):
            raise ImportSubjectIntegrityError(
                "mapping adapter returned a non-concrete event history"
            )
        try:
            direct.__post_init__()
            for event in events:
                event.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "mapping adapter returned malformed event evidence"
            ) from exc
        self._require_active_mapping_history(direct, events)
        return replace(direct), tuple(replace(event) for event in events)

    def _read_authority(
        self,
        *,
        project_id: str,
        run_id: str,
    ) -> CurrentAuthoritySnapshot:
        try:
            authority = self._authority_provider.current_authority(
                project_id=project_id,
                run_id=run_id,
            )
        except Exception as exc:
            raise ImportSubjectUnavailable("current import authority is unavailable") from exc
        if type(authority) is not CurrentAuthoritySnapshot:
            raise ImportSubjectIntegrityError("authority provider returned a non-concrete snapshot")
        try:
            authority.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "authority provider returned a malformed snapshot"
            ) from exc
        return replace(authority)

    def _read_artifact(
        self,
        request: ResolvedImportSubjectRequest,
    ) -> ArtifactContent:
        try:
            content = self._artifact_reader.read_exact(
                project_id=request.project_id,
                artifact_id=request.artifact_id,
                artifact_sha256=request.artifact_sha256,
                artifact_kind=request.artifact_kind,
            )
        except ArtifactStoreUnavailable as exc:
            raise ImportSubjectUnavailable("managed artifact store is unavailable") from exc
        except ArtifactNotFound as exc:
            raise ImportSubjectIntegrityError(
                "candidate source artifact is no longer available"
            ) from exc
        except ArtifactStoreError as exc:
            raise ImportSubjectIntegrityError(
                "managed artifact failed integrity validation"
            ) from exc
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "artifact reader returned an unexpected failure"
            ) from exc
        if type(content) is not ArtifactContent or type(content.record) is not ArtifactRecord:
            raise ImportSubjectIntegrityError("artifact reader returned non-concrete content")
        try:
            content.record.__post_init__()
            content.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError("artifact reader returned malformed content") from exc
        return ArtifactContent(replace(content.record), bytes(content.payload))

    def _remap(
        self,
        *,
        artifact: ArtifactContent,
        candidate: ImportCandidate,
        authority: CurrentAuthoritySnapshot,
    ) -> ImportMappingResult:
        try:
            result = self._remapper.remap(
                artifact=artifact,
                candidate=candidate,
                authority=authority,
            )
        except Exception as exc:
            raise ImportSubjectIntegrityError("deterministic remapper failed closed") from exc
        if type(result) is not ImportMappingResult:
            raise ImportSubjectIntegrityError("remapper returned a non-concrete mapping result")
        try:
            result.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "remapper returned malformed mapping evidence"
            ) from exc
        return result

    @staticmethod
    def _require_candidate_request(
        request: ResolvedImportSubjectRequest,
        candidate: ImportCandidate,
        events: tuple[CandidateTransitionEvent, ...],
    ) -> None:
        if candidate.identity_scheme is not CandidateIdentityScheme.CURRENT:
            raise ImportSubjectStale(
                "legacy candidate evidence requires current-scheme reinspection"
            )
        if candidate.state is not CandidateState.RESOLVED:
            raise ImportSubjectStale("candidate is not in the exact resolved lifecycle state")
        if (
            candidate.candidate_id != request.candidate_id
            or candidate.candidate_digest != request.candidate_digest
            or candidate.generation != request.candidate_generation
            or candidate.last_event_digest != request.candidate_last_event_sha256
            or candidate.resolution_receipt_digest != request.resolution_receipt_sha256
            or candidate.artifact_id != request.artifact_id
            or candidate.artifact_sha256 != request.artifact_sha256
            or candidate.artifact_kind is not request.artifact_kind
            or candidate.project_id != request.project_id
            or candidate.expected_project_revision != request.project_revision
            or candidate.run_id != request.run_id
            or candidate.expected_run_revision != request.run_revision
        ):
            raise ImportSubjectStale("candidate no longer matches the server-issued request")
        ResolvedImportSubjectLoader._require_resolved_candidate_history(
            candidate,
            events,
        )

    @staticmethod
    def _require_resolved_candidate_history(
        candidate: ImportCandidate,
        events: tuple[CandidateTransitionEvent, ...],
    ) -> None:
        if len(events) != 2:
            raise ImportSubjectIntegrityError(
                "resolved candidate must have one root and one resolution event"
            )
        root, resolved = events
        if (
            root.candidate_id != candidate.candidate_id
            or root.sequence != 0
            or root.kind
            not in {
                CandidateEventKind.CREATED,
                CandidateEventKind.MIGRATED,
            }
            or root.previous_state is not None
            or root.state is not CandidateState.PENDING
            or root.actor_id != candidate.created_by
            or root.receipt_digest != candidate.inspection_receipt_digest
            or root.reason is not None
            or root.transitioned_at != candidate.created_at
            or root.previous_event_digest != "0" * 64
            or resolved.sequence != 1
            or resolved.kind is not CandidateEventKind.TRANSITIONED
            or resolved.previous_state is not CandidateState.PENDING
            or resolved.state is not CandidateState.RESOLVED
            or resolved.candidate_id != candidate.candidate_id
            or resolved.previous_event_digest != root.event_digest
            or resolved.receipt_digest != candidate.resolution_receipt_digest
            or resolved.reason is not None
            or resolved.transitioned_at != candidate.updated_at
            or resolved.event_digest != candidate.last_event_digest
            or candidate.generation != 1
        ):
            raise ImportSubjectIntegrityError("candidate resolution history is not exact")

    @staticmethod
    def _require_mapping_request(
        request: ResolvedImportSubjectRequest,
        mapping: CanonicalMappingEvidence,
    ) -> None:
        if mapping.state is not MappingEvidenceState.ACTIVE:
            raise ImportSubjectStale("receipt-selected mapping is not active")
        if (
            mapping.mapping_evidence_id != request.mapping_evidence_id
            or mapping.mapping_evidence_digest != request.mapping_evidence_sha256
            or mapping.generation != request.mapping_evidence_generation
            or mapping.last_event_digest != request.mapping_evidence_last_event_sha256
        ):
            raise ImportSubjectStale("mapping evidence no longer matches the server-issued request")

    @staticmethod
    def _require_active_mapping_history(
        mapping: CanonicalMappingEvidence,
        events: tuple[MappingEvidenceEvent, ...],
    ) -> None:
        if (
            mapping.state is not MappingEvidenceState.ACTIVE
            or mapping.generation != 0
            or mapping.invalidation_reason is not None
            or len(events) != 1
        ):
            raise ImportSubjectStale("mapping evidence is not the exact active generation")
        root = events[0]
        if (
            root.sequence != 0
            or root.kind is not MappingEvidenceEventKind.CREATED
            or root.mapping_evidence_id != mapping.mapping_evidence_id
            or root.mapping_evidence_digest != mapping.mapping_evidence_digest
            or root.state is not MappingEvidenceState.ACTIVE
            or root.previous_state is not None
            or root.actor_id != mapping.authorized_actor
            or root.reason is not None
            or root.transitioned_at != mapping.created_at
            or root.previous_event_digest != "0" * 64
            or root.event_digest != mapping.last_event_digest
        ):
            raise ImportSubjectIntegrityError("mapping evidence creation history is not exact")

    @staticmethod
    def _require_candidate_mapping_chain(
        candidate: ImportCandidate,
        events: tuple[CandidateTransitionEvent, ...],
        mapping: CanonicalMappingEvidence,
    ) -> None:
        root = events[0]
        resolved = events[1]
        if (
            mapping.import_candidate_id != candidate.candidate_id
            or mapping.import_candidate_digest != candidate.candidate_digest
            or mapping.import_candidate_state is not CandidateState.PENDING
            or mapping.import_candidate_generation != 0
            or mapping.import_candidate_last_event_digest != root.event_digest
            or candidate.resolution_receipt_digest != mapping.mapping_evidence_digest
            or mapping.source_artifact_id != candidate.artifact_id
            or mapping.source_artifact_sha256 != candidate.artifact_sha256
            or mapping.source_artifact_kind is not candidate.artifact_kind
            or mapping.inspection_receipt_digest != candidate.inspection_receipt_digest
            or mapping.project_id != candidate.project_id
            or mapping.project_revision != candidate.expected_project_revision
            or mapping.run_id != candidate.run_id
            or mapping.run_revision != candidate.expected_run_revision
            or resolved.actor_id != mapping.authorized_actor
            or mapping.kicad_execution != "not-run"
            or mapping.manufacturing_release_eligible is not False
            or mapping.staging_authorized is not False
        ):
            raise ImportSubjectIntegrityError("candidate and mapping evidence bindings contradict")

    @staticmethod
    def _require_authority(
        request: ResolvedImportSubjectRequest,
        candidate: ImportCandidate,
        mapping: CanonicalMappingEvidence,
        authority: CurrentAuthoritySnapshot,
    ) -> None:
        try:
            inspection = candidate.decoded_inspection_payload()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "candidate inspection payload cannot be decoded"
            ) from exc
        if type(inspection) is not dict:
            raise ImportSubjectIntegrityError("candidate inspection payload is not an exact object")
        source = inspection.get("source")
        if type(source) is not dict:
            raise ImportSubjectIntegrityError("candidate inspection source is not an exact object")
        if (
            authority != request.expected_authority
            or authority.project_id != request.project_id
            or authority.project_head_revision != request.project_revision
            or authority.run_id != request.run_id
            or authority.run_revision != request.run_revision
            or authority.coordination_context_digest != request.coordination_context_digest
            or candidate.project_id != authority.project_id
            or candidate.expected_project_revision != authority.project_head_revision
            or candidate.run_id != authority.run_id
            or candidate.expected_run_revision != authority.run_revision
            or mapping.project_id != authority.project_id
            or mapping.project_revision != authority.project_head_revision
            or mapping.run_id != authority.run_id
            or mapping.run_revision != authority.run_revision
            or mapping.coordination_context_digest != authority.coordination_context_digest
            or inspection.get("coordinationContextDigest") != authority.coordination_context_digest
            or inspection.get("projectId") != authority.project_id
            or inspection.get("projectRevision") != authority.project_head_revision
            or inspection.get("runId") != authority.run_id
            or inspection.get("runRevision") != authority.run_revision
            or source.get("artifactId") != candidate.artifact_id
            or source.get("sha256") != candidate.artifact_sha256
            or source.get("kind") != candidate.artifact_kind.value
        ):
            raise ImportSubjectStale(
                "candidate or mapping context disagrees with current authority"
            )

    @staticmethod
    def _require_artifact(
        request: ResolvedImportSubjectRequest,
        candidate: ImportCandidate,
        mapping: CanonicalMappingEvidence,
        artifact: ArtifactContent,
    ) -> None:
        record = artifact.record
        if (
            record.artifact_id != request.artifact_id
            or record.sha256 != request.artifact_sha256
            or record.kind is not request.artifact_kind
            or record.artifact_id != candidate.artifact_id
            or record.sha256 != candidate.artifact_sha256
            or record.kind is not candidate.artifact_kind
            or record.actor_id != candidate.created_by
            or record.artifact_id != mapping.source_artifact_id
            or record.sha256 != mapping.source_artifact_sha256
            or record.kind is not mapping.source_artifact_kind
        ):
            raise ImportSubjectIntegrityError(
                "managed artifact does not bind the candidate and mapping"
            )

    @staticmethod
    def _require_fresh_mapping(
        request: ResolvedImportSubjectRequest,
        candidate: ImportCandidate,
        candidate_events: tuple[CandidateTransitionEvent, ...],
        mapping: CanonicalMappingEvidence,
        result: ImportMappingResult,
    ) -> tuple[CanonicalImportCandidate, CanonicalImportTransactionInput]:
        try:
            result.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "fresh mapper result failed exact validation"
            ) from exc
        if (
            result.blockers
            or not result.stage_eligible
            or result.candidate is None
            or result.transaction_input is None
            or not result.mapper_issuance_seal.is_deterministic_mapper_issuance
        ):
            raise ImportSubjectIntegrityError(
                "fresh mapper did not issue a blocker-free exact result"
            )
        canonical_candidate = result.candidate
        transaction_input = result.transaction_input
        if (
            type(canonical_candidate) is not CanonicalImportCandidate
            or type(transaction_input) is not CanonicalImportTransactionInput
        ):
            raise ImportSubjectIntegrityError("fresh mapper result contains non-concrete records")
        try:
            canonical_candidate.__post_init__()
            transaction_input.__post_init__()
            for command in transaction_input.commands:
                command.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "fresh mapper returned malformed canonical records"
            ) from exc

        root = candidate_events[0]
        pending = replace(
            candidate,
            state=CandidateState.PENDING,
            generation=0,
            resolution_receipt_digest=None,
            stage_receipt_digest=None,
            terminal_reason=None,
            updated_at=root.transitioned_at,
            last_event_digest=root.event_digest,
        )
        try:
            fresh_draft = MappingEvidenceDraft.from_mapping(pending, result)
            durable_draft = mapping.draft()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "fresh mapping cannot reproduce durable mapping evidence"
            ) from exc
        if fresh_draft != durable_draft:
            raise ImportSubjectIntegrityError(
                "fresh mapper result differs from durable mapping evidence"
            )
        fresh_preview = import_preview_digest(
            base_revision=transaction_input.base_revision,
            transaction_id=transaction_input.transaction_id,
            prospective_graph_sha256=(transaction_input.prospective_graph_sha256),
            command_hashes=tuple(command.command_hash for command in transaction_input.commands),
        )
        durable_preview = import_preview_digest(
            base_revision=mapping.canonical_base_revision,
            transaction_id=mapping.transaction_id,
            prospective_graph_sha256=mapping.canonical_graph_sha256,
            command_hashes=mapping.transaction_command_hashes,
        )
        fresh_prospective = prospective_revision_sha256(
            project_id=canonical_candidate.project_id,
            base_revision=transaction_input.base_revision,
            prospective_graph_sha256=(transaction_input.prospective_graph_sha256),
            commands_digest=transaction_input.commands_sha256,
            preview_digest=fresh_preview,
        )
        if (
            fresh_preview != durable_preview
            or fresh_preview != request.preview_digest
            or fresh_prospective != request.prospective_revision_sha256
            or result.mapping_sha256 != mapping.mapper_result_sha256
            or canonical_candidate.candidate_sha256 != mapping.mapper_candidate_sha256
            or transaction_input.commands != mapping.transaction_commands
            or tuple(command.command_hash for command in transaction_input.commands)
            != mapping.transaction_command_hashes
        ):
            raise ImportSubjectIntegrityError(
                "fresh mapper preview or full transaction differs from evidence"
            )
        return canonical_candidate, transaction_input

    @staticmethod
    def _require_unchanged_candidate(
        before: ImportCandidate,
        before_events: tuple[CandidateTransitionEvent, ...],
        after: ImportCandidate,
        after_events: tuple[CandidateTransitionEvent, ...],
    ) -> None:
        if before == after and before_events == after_events:
            return
        immutable_before = (
            before.candidate_id,
            before.candidate_digest,
            before.identity_scheme,
            before.artifact_id,
            before.artifact_sha256,
            before.artifact_kind,
            before.project_id,
            before.expected_project_revision,
            before.run_id,
            before.expected_run_revision,
            before.inspection_payload_json,
            before.inspection_payload_digest,
            before.inspection_receipt_digest,
            before.diagnostics,
            before.blockers,
            before.created_by,
            before.created_at,
        )
        immutable_after = (
            after.candidate_id,
            after.candidate_digest,
            after.identity_scheme,
            after.artifact_id,
            after.artifact_sha256,
            after.artifact_kind,
            after.project_id,
            after.expected_project_revision,
            after.run_id,
            after.expected_run_revision,
            after.inspection_payload_json,
            after.inspection_payload_digest,
            after.inspection_receipt_digest,
            after.diagnostics,
            after.blockers,
            after.created_by,
            after.created_at,
        )
        if immutable_before == immutable_after:
            raise ImportSubjectStale("candidate lifecycle changed during deterministic remapping")
        raise ImportSubjectIntegrityError(
            "candidate immutable identity changed during a read-only load"
        )

    @staticmethod
    def _require_unchanged_mapping(
        before: CanonicalMappingEvidence,
        before_events: tuple[MappingEvidenceEvent, ...],
        after: CanonicalMappingEvidence,
        after_events: tuple[MappingEvidenceEvent, ...],
    ) -> None:
        if before == after and before_events == after_events:
            return
        if (
            before.mapping_evidence_id == after.mapping_evidence_id
            and before.mapping_evidence_digest == after.mapping_evidence_digest
            and before.draft() == after.draft()
        ):
            raise ImportSubjectStale("mapping lifecycle changed during deterministic remapping")
        raise ImportSubjectIntegrityError(
            "mapping immutable identity changed during a read-only load"
        )


__all__ = ("ResolvedImportSubjectLoader",)
