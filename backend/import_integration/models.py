"""Exact, inert records for resolved-import subject reconstruction."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from backend.canonical_import import (
    CanonicalImportCandidate,
    CanonicalImportTransactionInput,
    CanonicalMappingEvidence,
    ImportMappingResult,
    MappingEvidenceEvent,
    MappingEvidenceState,
)
from backend.design_kernel import stable_hash
from backend.import_approval import (
    CurrentAuthorityProvider,
    CurrentAuthoritySnapshot,
    import_preview_digest,
    prospective_revision_sha256,
)
from backend.interchange_artifacts import ArtifactContent, ArtifactKind, ArtifactRecord
from backend.kicad_import_candidates import (
    CandidateIdentityScheme,
    CandidateState,
    CandidateTransitionEvent,
    ImportCandidate,
)


class ImportIntegrationError(RuntimeError):
    """Base class for fail-closed import-integration failures."""

    code = "import_integration_failed"


class ImportIntegrationConfigurationError(ImportIntegrationError):
    """A mandatory trusted read adapter was not configured."""

    code = "import_integration_unconfigured"


class ImportSubjectInvalidRequest(ImportIntegrationError, ValueError):
    """The loader request is malformed, forged, or from another issuer."""

    code = "import_subject_invalid_request"


class ImportSubjectNotFound(ImportIntegrationError):
    """The initially requested candidate does not exist."""

    code = "import_subject_not_found"


class ImportSubjectUnavailable(ImportIntegrationError):
    """A required trusted read dependency is temporarily unavailable."""

    code = "import_subject_unavailable"


class ImportSubjectStale(ImportIntegrationError):
    """A mutable lifecycle or authority binding changed."""

    code = "import_subject_stale"


class ImportSubjectIntegrityError(ImportIntegrationError):
    """A trusted adapter returned malformed or contradictory evidence."""

    code = "import_subject_integrity_failed"


def _require_public_id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or any(character.isspace() for character in value)
        or any(unicodedata.category(character).startswith("C") for character in value)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ImportSubjectInvalidRequest(f"{label} must be an exact canonical public identifier")
    return value


def _require_sha256(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ImportSubjectInvalidRequest(f"{label} must be an exact lowercase SHA-256 digest")
    return value


def _require_nonnegative_int(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ImportSubjectInvalidRequest(f"{label} must be an exact non-negative integer")
    return value


@runtime_checkable
class HostOwnedArtifactReader(Protocol):
    """Trusted service adapter for exact host-owned bytes.

    Runtime protocol conformance is only a configuration-shape check.  The
    implementation remains a server trust dependency; every returned value is
    nevertheless validated as hostile evidence by the loader.
    """

    def read_exact(
        self,
        *,
        project_id: str,
        artifact_id: str,
        artifact_sha256: str,
        artifact_kind: ArtifactKind,
    ) -> ArtifactContent: ...


@runtime_checkable
class ResolvedCandidateReader(Protocol):
    """Trusted, narrow, read-only candidate repository boundary."""

    def get(self, candidate_id: str) -> ImportCandidate: ...

    def list_events(self, candidate_id: str) -> tuple[CandidateTransitionEvent, ...]: ...


@runtime_checkable
class ResolvedMappingReader(Protocol):
    """Trusted, narrow, read-only mapping-evidence repository boundary."""

    def get(self, mapping_evidence_id: str) -> CanonicalMappingEvidence: ...

    def list_for_candidate(
        self, import_candidate_id: str
    ) -> tuple[CanonicalMappingEvidence, ...]: ...

    def list_events(self, mapping_evidence_id: str) -> tuple[MappingEvidenceEvent, ...]: ...


@runtime_checkable
class DeterministicImportRemapper(Protocol):
    """Trusted server mapper that owns its actor, resolver, and policy choices."""

    def remap(
        self,
        *,
        artifact: ArtifactContent,
        candidate: ImportCandidate,
        authority: CurrentAuthoritySnapshot,
    ) -> ImportMappingResult: ...


_REQUEST_SEAL_AUTHORITY = object()


@dataclass(frozen=True, slots=True, eq=False, init=False)
class _RequestIssuance:
    """Process-local, immutable witness for one server-issued request digest."""

    request_digest: str
    issuer_id: str
    issuer_incarnation: str
    _issuer: ResolvedImportSubjectRequestIssuer = field(repr=False)

    def __init__(
        self,
        request_digest: str,
        *,
        authority: object,
        issuer: ResolvedImportSubjectRequestIssuer,
    ) -> None:
        if authority is not _REQUEST_SEAL_AUTHORITY:
            raise ImportSubjectInvalidRequest(
                "resolved-import requests can only be issued by the server issuer"
            )
        if type(issuer) is not ResolvedImportSubjectRequestIssuer:
            raise ImportSubjectInvalidRequest("request issuance requires the exact server issuer")
        _require_sha256(request_digest, "request issuance digest")
        object.__setattr__(self, "request_digest", request_digest)
        object.__setattr__(self, "issuer_id", issuer.issuer_id)
        object.__setattr__(
            self,
            "issuer_incarnation",
            issuer.issuer_incarnation,
        )
        object.__setattr__(self, "_issuer", issuer)

    def matches(
        self,
        *,
        request_digest: str,
        issuer_id: str,
        issuer_incarnation: str,
        issuer: ResolvedImportSubjectRequestIssuer,
    ) -> bool:
        return (
            self._issuer is issuer
            and self.request_digest == request_digest
            and self.issuer_id == issuer_id == issuer.issuer_id
            and self.issuer_incarnation == issuer_incarnation == issuer.issuer_incarnation
        )

    def matches_embedded_claim(
        self,
        *,
        request_digest: str,
        issuer_id: str,
        issuer_incarnation: str,
    ) -> bool:
        return self.matches(
            request_digest=request_digest,
            issuer_id=issuer_id,
            issuer_incarnation=issuer_incarnation,
            issuer=self._issuer,
        )


def _request_material(
    *,
    issuer_id: str,
    issuer_incarnation: str,
    candidate_id: str,
    candidate_digest: str,
    candidate_generation: int,
    candidate_last_event_sha256: str,
    resolution_receipt_sha256: str,
    mapping_evidence_id: str,
    mapping_evidence_sha256: str,
    mapping_evidence_generation: int,
    mapping_evidence_last_event_sha256: str,
    artifact_id: str,
    artifact_sha256: str,
    artifact_kind: ArtifactKind,
    project_id: str,
    project_revision: str,
    run_id: str,
    run_revision: int,
    coordination_context_digest: str,
    preview_digest: str,
    prospective_revision_digest: str,
    expected_authority: CurrentAuthoritySnapshot,
) -> dict[str, object]:
    return {
        "issuer_id": issuer_id,
        "issuer_incarnation": issuer_incarnation,
        "candidate": {
            "candidate_id": candidate_id,
            "candidate_digest": candidate_digest,
            "generation": candidate_generation,
            "last_event_sha256": candidate_last_event_sha256,
            "resolution_receipt_sha256": resolution_receipt_sha256,
        },
        "mapping": {
            "mapping_evidence_id": mapping_evidence_id,
            "mapping_evidence_sha256": mapping_evidence_sha256,
            "generation": mapping_evidence_generation,
            "last_event_sha256": mapping_evidence_last_event_sha256,
        },
        "artifact": {
            "artifact_id": artifact_id,
            "artifact_sha256": artifact_sha256,
            "artifact_kind": artifact_kind.value,
        },
        "coordination": {
            "project_id": project_id,
            "project_revision": project_revision,
            "run_id": run_id,
            "run_revision": run_revision,
            "coordination_context_digest": coordination_context_digest,
            "authority_snapshot_sha256": expected_authority.snapshot_digest,
        },
        "canonical": {
            "preview_digest": preview_digest,
            "prospective_revision_sha256": prospective_revision_digest,
        },
    }


@dataclass(frozen=True, slots=True, eq=False)
class ResolvedImportSubjectRequest:
    """Issuer-bound optimistic request; it is evidence, not authority."""

    request_id: str
    request_digest: str
    issuer_id: str
    issuer_incarnation: str
    candidate_id: str
    candidate_digest: str
    candidate_generation: int
    candidate_last_event_sha256: str
    resolution_receipt_sha256: str
    mapping_evidence_id: str
    mapping_evidence_sha256: str
    mapping_evidence_generation: int
    mapping_evidence_last_event_sha256: str
    artifact_id: str
    artifact_sha256: str
    artifact_kind: ArtifactKind
    project_id: str
    project_revision: str
    run_id: str
    run_revision: int
    coordination_context_digest: str
    preview_digest: str
    prospective_revision_sha256: str
    expected_authority: CurrentAuthoritySnapshot
    _issuance: _RequestIssuance = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if type(self) is not ResolvedImportSubjectRequest:
            raise ImportSubjectInvalidRequest(
                "resolved-import requests must use the exact request type"
            )
        for value, label in (
            (self.request_id, "request ID"),
            (self.issuer_id, "request issuer ID"),
            (self.issuer_incarnation, "request issuer incarnation"),
            (self.candidate_id, "candidate ID"),
            (self.mapping_evidence_id, "mapping evidence ID"),
            (self.artifact_id, "artifact ID"),
            (self.project_id, "project ID"),
            (self.run_id, "run ID"),
        ):
            _require_public_id(value, label)
        for value, label in (
            (self.request_digest, "request digest"),
            (self.candidate_digest, "candidate digest"),
            (self.candidate_last_event_sha256, "candidate event head"),
            (self.resolution_receipt_sha256, "candidate resolution receipt"),
            (self.mapping_evidence_sha256, "mapping evidence digest"),
            (
                self.mapping_evidence_last_event_sha256,
                "mapping evidence event head",
            ),
            (self.artifact_sha256, "artifact digest"),
            (self.project_revision, "project revision"),
            (
                self.coordination_context_digest,
                "coordination context digest",
            ),
            (self.preview_digest, "preview digest"),
            (
                self.prospective_revision_sha256,
                "prospective revision digest",
            ),
        ):
            _require_sha256(value, label)
        _require_nonnegative_int(self.candidate_generation, "candidate generation")
        _require_nonnegative_int(
            self.mapping_evidence_generation,
            "mapping evidence generation",
        )
        _require_nonnegative_int(self.run_revision, "run revision")
        if type(self.artifact_kind) is not ArtifactKind:
            raise ImportSubjectInvalidRequest("artifact kind must be exact")
        if type(self.expected_authority) is not CurrentAuthoritySnapshot:
            raise ImportSubjectInvalidRequest("expected authority must be CurrentAuthoritySnapshot")
        self.expected_authority.__post_init__()
        material = _request_material(
            issuer_id=self.issuer_id,
            issuer_incarnation=self.issuer_incarnation,
            candidate_id=self.candidate_id,
            candidate_digest=self.candidate_digest,
            candidate_generation=self.candidate_generation,
            candidate_last_event_sha256=self.candidate_last_event_sha256,
            resolution_receipt_sha256=self.resolution_receipt_sha256,
            mapping_evidence_id=self.mapping_evidence_id,
            mapping_evidence_sha256=self.mapping_evidence_sha256,
            mapping_evidence_generation=self.mapping_evidence_generation,
            mapping_evidence_last_event_sha256=(self.mapping_evidence_last_event_sha256),
            artifact_id=self.artifact_id,
            artifact_sha256=self.artifact_sha256,
            artifact_kind=self.artifact_kind,
            project_id=self.project_id,
            project_revision=self.project_revision,
            run_id=self.run_id,
            run_revision=self.run_revision,
            coordination_context_digest=self.coordination_context_digest,
            preview_digest=self.preview_digest,
            prospective_revision_digest=self.prospective_revision_sha256,
            expected_authority=self.expected_authority,
        )
        expected = stable_hash(
            material,
            domain="flux-clone-resolved-import-subject-request-v1",
        )
        if self.request_digest != expected:
            raise ImportSubjectInvalidRequest("request digest does not bind its complete subject")
        if self.request_id != f"resolved-import-request-{expected[:32]}":
            raise ImportSubjectInvalidRequest("request ID does not derive from its digest")
        if type(
            self._issuance
        ) is not _RequestIssuance or not self._issuance.matches_embedded_claim(
            request_digest=self.request_digest,
            issuer_id=self.issuer_id,
            issuer_incarnation=self.issuer_incarnation,
        ):
            raise ImportSubjectInvalidRequest("request lacks its exact server issuance witness")

    def was_issued_by(self, issuer: ResolvedImportSubjectRequestIssuer) -> bool:
        return self._issuance.matches(
            request_digest=self.request_digest,
            issuer_id=self.issuer_id,
            issuer_incarnation=self.issuer_incarnation,
            issuer=issuer,
        )


@dataclass(frozen=True, slots=True, eq=False)
class ResolvedImportSubjectRequestIssuer:
    """Server-held factory whose object identity fences request origin."""

    issuer_id: str
    issuer_incarnation: str

    def __post_init__(self) -> None:
        _require_public_id(self.issuer_id, "request issuer ID")
        _require_public_id(
            self.issuer_incarnation,
            "request issuer incarnation",
        )

    def issue(
        self,
        *,
        candidate: ImportCandidate,
        mapping_evidence: CanonicalMappingEvidence,
        authority: CurrentAuthoritySnapshot,
    ) -> ResolvedImportSubjectRequest:
        if type(candidate) is not ImportCandidate:
            raise ImportSubjectInvalidRequest("request issuance requires an exact ImportCandidate")
        if type(mapping_evidence) is not CanonicalMappingEvidence:
            raise ImportSubjectInvalidRequest(
                "request issuance requires exact CanonicalMappingEvidence"
            )
        if type(authority) is not CurrentAuthoritySnapshot:
            raise ImportSubjectInvalidRequest(
                "request issuance requires exact CurrentAuthoritySnapshot"
            )
        try:
            candidate.__post_init__()
            mapping_evidence.__post_init__()
            authority.__post_init__()
        except Exception as exc:
            raise ImportSubjectInvalidRequest(
                "request issuance source records are invalid"
            ) from exc
        if (
            candidate.identity_scheme is not CandidateIdentityScheme.CURRENT
            or candidate.state is not CandidateState.RESOLVED
            or candidate.generation != 1
            or mapping_evidence.state is not MappingEvidenceState.ACTIVE
            or mapping_evidence.generation != 0
            or candidate.resolution_receipt_digest is None
            or candidate.resolution_receipt_digest != mapping_evidence.mapping_evidence_digest
        ):
            raise ImportSubjectInvalidRequest(
                "request issuance requires one current resolved candidate and active mapping"
            )
        if (
            candidate.candidate_id != mapping_evidence.import_candidate_id
            or candidate.candidate_digest != mapping_evidence.import_candidate_digest
            or mapping_evidence.import_candidate_state is not CandidateState.PENDING
            or mapping_evidence.import_candidate_generation != 0
            or candidate.artifact_id != mapping_evidence.source_artifact_id
            or candidate.artifact_sha256 != mapping_evidence.source_artifact_sha256
            or candidate.artifact_kind is not mapping_evidence.source_artifact_kind
            or candidate.inspection_receipt_digest != mapping_evidence.inspection_receipt_digest
            or candidate.project_id != mapping_evidence.project_id
            or candidate.expected_project_revision != mapping_evidence.project_revision
            or candidate.run_id != mapping_evidence.run_id
            or candidate.expected_run_revision != mapping_evidence.run_revision
        ):
            raise ImportSubjectInvalidRequest(
                "mapping evidence does not bind the complete candidate subject"
            )
        if (
            authority.project_id != candidate.project_id
            or authority.project_head_revision != candidate.expected_project_revision
            or authority.run_id != candidate.run_id
            or authority.run_revision != candidate.expected_run_revision
            or authority.coordination_context_digest != mapping_evidence.coordination_context_digest
        ):
            raise ImportSubjectInvalidRequest(
                "request issuance authority does not bind the candidate and mapping"
            )
        command_hashes = mapping_evidence.transaction_command_hashes
        preview = import_preview_digest(
            base_revision=mapping_evidence.canonical_base_revision,
            transaction_id=mapping_evidence.transaction_id,
            prospective_graph_sha256=(mapping_evidence.canonical_graph_sha256),
            command_hashes=command_hashes,
        )
        prospective = prospective_revision_sha256(
            project_id=mapping_evidence.project_id,
            base_revision=mapping_evidence.canonical_base_revision,
            prospective_graph_sha256=(mapping_evidence.canonical_graph_sha256),
            commands_digest=mapping_evidence.transaction_commands_sha256,
            preview_digest=preview,
        )
        material = _request_material(
            issuer_id=self.issuer_id,
            issuer_incarnation=self.issuer_incarnation,
            candidate_id=candidate.candidate_id,
            candidate_digest=candidate.candidate_digest,
            candidate_generation=candidate.generation,
            candidate_last_event_sha256=candidate.last_event_digest,
            resolution_receipt_sha256=(candidate.resolution_receipt_digest),
            mapping_evidence_id=mapping_evidence.mapping_evidence_id,
            mapping_evidence_sha256=(mapping_evidence.mapping_evidence_digest),
            mapping_evidence_generation=mapping_evidence.generation,
            mapping_evidence_last_event_sha256=(mapping_evidence.last_event_digest),
            artifact_id=candidate.artifact_id,
            artifact_sha256=candidate.artifact_sha256,
            artifact_kind=candidate.artifact_kind,
            project_id=candidate.project_id,
            project_revision=candidate.expected_project_revision,
            run_id=candidate.run_id,
            run_revision=candidate.expected_run_revision,
            coordination_context_digest=(mapping_evidence.coordination_context_digest),
            preview_digest=preview,
            prospective_revision_digest=prospective,
            expected_authority=authority,
        )
        digest = stable_hash(
            material,
            domain="flux-clone-resolved-import-subject-request-v1",
        )
        return ResolvedImportSubjectRequest(
            request_id=f"resolved-import-request-{digest[:32]}",
            request_digest=digest,
            issuer_id=self.issuer_id,
            issuer_incarnation=self.issuer_incarnation,
            candidate_id=candidate.candidate_id,
            candidate_digest=candidate.candidate_digest,
            candidate_generation=candidate.generation,
            candidate_last_event_sha256=candidate.last_event_digest,
            resolution_receipt_sha256=(candidate.resolution_receipt_digest),
            mapping_evidence_id=mapping_evidence.mapping_evidence_id,
            mapping_evidence_sha256=(mapping_evidence.mapping_evidence_digest),
            mapping_evidence_generation=mapping_evidence.generation,
            mapping_evidence_last_event_sha256=(mapping_evidence.last_event_digest),
            artifact_id=candidate.artifact_id,
            artifact_sha256=candidate.artifact_sha256,
            artifact_kind=candidate.artifact_kind,
            project_id=candidate.project_id,
            project_revision=candidate.expected_project_revision,
            run_id=candidate.run_id,
            run_revision=candidate.expected_run_revision,
            coordination_context_digest=(mapping_evidence.coordination_context_digest),
            preview_digest=preview,
            prospective_revision_sha256=prospective,
            expected_authority=authority,
            _issuance=_RequestIssuance(
                digest,
                authority=_REQUEST_SEAL_AUTHORITY,
                issuer=self,
            ),
        )


def _subject_material(
    *,
    request_digest: str,
    artifact: ArtifactContent,
    candidate: ImportCandidate,
    candidate_events: tuple[CandidateTransitionEvent, ...],
    mapping_evidence: CanonicalMappingEvidence,
    mapping_events: tuple[MappingEvidenceEvent, ...],
    canonical_candidate: CanonicalImportCandidate,
    transaction_input: CanonicalImportTransactionInput,
    mapping_result_sha256: str,
    authority: CurrentAuthoritySnapshot,
    preview_digest: str,
    prospective_revision_digest: str,
) -> dict[str, object]:
    return {
        "request_digest": request_digest,
        "artifact": {
            "artifact_id": artifact.record.artifact_id,
            "sha256": artifact.record.sha256,
            "kind": artifact.record.kind.value,
            "size_bytes": artifact.record.size_bytes,
            "owner_actor": artifact.record.actor_id,
        },
        "candidate": {
            "candidate_id": candidate.candidate_id,
            "candidate_digest": candidate.candidate_digest,
            "generation": candidate.generation,
            "last_event_sha256": candidate.last_event_digest,
            "event_digests": tuple(event.event_digest for event in candidate_events),
        },
        "mapping": {
            "mapping_evidence_id": mapping_evidence.mapping_evidence_id,
            "mapping_evidence_sha256": (mapping_evidence.mapping_evidence_digest),
            "generation": mapping_evidence.generation,
            "last_event_sha256": mapping_evidence.last_event_digest,
            "event_digests": tuple(event.event_digest for event in mapping_events),
            "mapping_result_sha256": mapping_result_sha256,
            "canonical_candidate_sha256": (canonical_candidate.candidate_sha256),
            "provenance_set_sha256": (canonical_candidate.provenance_set_sha256),
        },
        "transaction": {
            "transaction_id": transaction_input.transaction_id,
            "base_revision": transaction_input.base_revision,
            "prospective_graph_sha256": (transaction_input.prospective_graph_sha256),
            "command_hashes": tuple(command.command_hash for command in transaction_input.commands),
            "commands_sha256": transaction_input.commands_sha256,
            "preview_digest": preview_digest,
            "prospective_revision_sha256": prospective_revision_digest,
        },
        "authority_snapshot_sha256": authority.snapshot_digest,
        "authority": {
            "project_event_head_sha256": (authority.project_event_head_sha256),
            "run_incarnation": authority.run_incarnation,
            "run_event_head_sha256": authority.run_event_head_sha256,
            "coordination_incarnation": authority.coordination_incarnation,
            "coordination_event_head_sha256": (authority.coordination_event_head_sha256),
            "target_store_id": authority.target_store_id,
            "target_store_incarnation": (authority.target_store_incarnation),
        },
        "authority_flags": {
            "authorizes_approval": False,
            "authorizes_staging": False,
            "authorizes_internal_commit": False,
            "authorizes_manufacturing_release": False,
        },
    }


def resolved_import_subject_sha256(
    *,
    request_digest: str,
    artifact: ArtifactContent,
    candidate: ImportCandidate,
    candidate_events: tuple[CandidateTransitionEvent, ...],
    mapping_evidence: CanonicalMappingEvidence,
    mapping_events: tuple[MappingEvidenceEvent, ...],
    canonical_candidate: CanonicalImportCandidate,
    transaction_input: CanonicalImportTransactionInput,
    mapping_result_sha256: str,
    authority: CurrentAuthoritySnapshot,
    preview_digest: str,
    prospective_revision_digest: str,
) -> str:
    """Hash one already-validated inert subject using its sole canonical body."""

    return stable_hash(
        _subject_material(
            request_digest=request_digest,
            artifact=artifact,
            candidate=candidate,
            candidate_events=candidate_events,
            mapping_evidence=mapping_evidence,
            mapping_events=mapping_events,
            canonical_candidate=canonical_candidate,
            transaction_input=transaction_input,
            mapping_result_sha256=mapping_result_sha256,
            authority=authority,
            preview_digest=preview_digest,
            prospective_revision_digest=prospective_revision_digest,
        ),
        domain="flux-clone-resolved-import-subject-v1",
    )


@dataclass(frozen=True, slots=True)
class ResolvedImportSubject:
    """Read-only exact snapshot with no approval, staging, or release authority."""

    request_id: str
    request_digest: str
    artifact: ArtifactContent
    candidate: ImportCandidate
    candidate_events: tuple[CandidateTransitionEvent, ...]
    mapping_evidence: CanonicalMappingEvidence
    mapping_events: tuple[MappingEvidenceEvent, ...]
    canonical_candidate: CanonicalImportCandidate
    transaction_input: CanonicalImportTransactionInput
    mapping_result_sha256: str
    authority: CurrentAuthoritySnapshot
    preview_digest: str
    prospective_revision_sha256: str
    subject_sha256: str
    authorizes_approval: bool = False
    authorizes_staging: bool = False
    authorizes_internal_commit: bool = False
    authorizes_manufacturing_release: bool = False

    def __post_init__(self) -> None:
        if type(self) is not ResolvedImportSubject:
            raise ImportSubjectIntegrityError("resolved subject must use the exact concrete type")
        _require_public_id(self.request_id, "resolved subject request ID")
        for value, label in (
            (self.request_digest, "resolved subject request digest"),
            (self.mapping_result_sha256, "mapper result digest"),
            (self.preview_digest, "resolved subject preview digest"),
            (
                self.prospective_revision_sha256,
                "resolved subject prospective revision",
            ),
            (self.subject_sha256, "resolved subject digest"),
        ):
            _require_sha256(value, label)
        if (
            type(self.artifact) is not ArtifactContent
            or type(self.artifact.record) is not ArtifactRecord
            or type(self.candidate) is not ImportCandidate
            or type(self.mapping_evidence) is not CanonicalMappingEvidence
            or type(self.canonical_candidate) is not CanonicalImportCandidate
            or type(self.transaction_input) is not CanonicalImportTransactionInput
            or type(self.authority) is not CurrentAuthoritySnapshot
        ):
            raise ImportSubjectIntegrityError("resolved subject contains a non-concrete record")
        if (
            type(self.candidate_events) is not tuple
            or any(type(event) is not CandidateTransitionEvent for event in self.candidate_events)
            or type(self.mapping_events) is not tuple
            or any(type(event) is not MappingEvidenceEvent for event in self.mapping_events)
        ):
            raise ImportSubjectIntegrityError(
                "resolved subject event histories must be exact tuples"
            )
        try:
            self.artifact.record.__post_init__()
            self.artifact.__post_init__()
            self.candidate.__post_init__()
            self.mapping_evidence.__post_init__()
            self.canonical_candidate.__post_init__()
            self.transaction_input.__post_init__()
            self.authority.__post_init__()
            for event in self.candidate_events:
                event.__post_init__()
            for event in self.mapping_events:
                event.__post_init__()
            for command in self.transaction_input.commands:
                command.__post_init__()
        except Exception as exc:
            raise ImportSubjectIntegrityError(
                "resolved subject contains malformed exact evidence"
            ) from exc
        if self.request_id != f"resolved-import-request-{self.request_digest[:32]}":
            raise ImportSubjectIntegrityError(
                "resolved subject request ID does not derive from its digest"
            )
        if any(
            type(value) is not bool or value is not False
            for value in (
                self.authorizes_approval,
                self.authorizes_staging,
                self.authorizes_internal_commit,
                self.authorizes_manufacturing_release,
            )
        ):
            raise ImportSubjectIntegrityError("resolved subject cannot carry authority")
        command_hashes = tuple(command.command_hash for command in self.transaction_input.commands)
        expected_preview = import_preview_digest(
            base_revision=self.transaction_input.base_revision,
            transaction_id=self.transaction_input.transaction_id,
            prospective_graph_sha256=(self.transaction_input.prospective_graph_sha256),
            command_hashes=command_hashes,
        )
        expected_prospective = prospective_revision_sha256(
            project_id=self.canonical_candidate.project_id,
            base_revision=self.transaction_input.base_revision,
            prospective_graph_sha256=(self.transaction_input.prospective_graph_sha256),
            commands_digest=self.transaction_input.commands_sha256,
            preview_digest=expected_preview,
        )
        if (
            self.mapping_result_sha256 != self.mapping_evidence.mapper_result_sha256
            or self.canonical_candidate.candidate_sha256
            != self.mapping_evidence.mapper_candidate_sha256
            or self.transaction_input.transaction_id != self.mapping_evidence.transaction_id
            or self.transaction_input.base_revision != self.mapping_evidence.canonical_base_revision
            or self.transaction_input.prospective_graph_sha256
            != self.mapping_evidence.canonical_graph_sha256
            or self.transaction_input.commands != self.mapping_evidence.transaction_commands
            or command_hashes != self.mapping_evidence.transaction_command_hashes
            or self.transaction_input.commands_sha256
            != self.mapping_evidence.transaction_commands_sha256
            or self.preview_digest != expected_preview
            or self.prospective_revision_sha256 != expected_prospective
            or self.candidate.candidate_id != self.mapping_evidence.import_candidate_id
            or self.candidate.candidate_digest != self.mapping_evidence.import_candidate_digest
            or self.candidate.resolution_receipt_digest
            != self.mapping_evidence.mapping_evidence_digest
            or self.artifact.record.artifact_id != self.candidate.artifact_id
            or self.artifact.record.sha256 != self.candidate.artifact_sha256
            or self.artifact.record.kind is not self.candidate.artifact_kind
            or self.authority.project_id != self.candidate.project_id
            or self.authority.project_head_revision != self.candidate.expected_project_revision
            or self.authority.run_id != self.candidate.run_id
            or self.authority.run_revision != self.candidate.expected_run_revision
            or self.authority.coordination_context_digest
            != self.mapping_evidence.coordination_context_digest
            or not self.candidate_events
            or self.candidate_events[-1].event_digest != self.candidate.last_event_digest
            or not self.mapping_events
            or self.mapping_events[-1].event_digest != self.mapping_evidence.last_event_digest
        ):
            raise ImportSubjectIntegrityError(
                "resolved subject evidence is not exactly cross-bound"
            )
        expected = resolved_import_subject_sha256(
            request_digest=self.request_digest,
            artifact=self.artifact,
            candidate=self.candidate,
            candidate_events=self.candidate_events,
            mapping_evidence=self.mapping_evidence,
            mapping_events=self.mapping_events,
            canonical_candidate=self.canonical_candidate,
            transaction_input=self.transaction_input,
            mapping_result_sha256=self.mapping_result_sha256,
            authority=self.authority,
            preview_digest=self.preview_digest,
            prospective_revision_digest=self.prospective_revision_sha256,
        )
        if self.subject_sha256 != expected:
            raise ImportSubjectIntegrityError(
                "resolved subject digest does not bind its exact evidence"
            )


__all__ = (
    "CurrentAuthorityProvider",
    "CurrentAuthoritySnapshot",
    "DeterministicImportRemapper",
    "HostOwnedArtifactReader",
    "ImportIntegrationConfigurationError",
    "ImportIntegrationError",
    "ImportSubjectIntegrityError",
    "ImportSubjectInvalidRequest",
    "ImportSubjectNotFound",
    "ImportSubjectStale",
    "ImportSubjectUnavailable",
    "ResolvedCandidateReader",
    "ResolvedImportSubject",
    "ResolvedImportSubjectRequest",
    "ResolvedImportSubjectRequestIssuer",
    "ResolvedMappingReader",
)
