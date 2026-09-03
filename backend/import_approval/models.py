"""Immutable records for human-approved canonical-import staging.

The records in this module are deliberately not ``DesignKernel`` approvals.
They authorize only presenting an exact, already-mapped command set to an
internal staging boundary.  Commit verification, commit approval, and
manufacturing release remain separate authority domains.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol, cast, runtime_checkable

from backend.canonical_import import CanonicalImportTransactionInput
from backend.design_kernel import stable_hash

_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_REQUEST_PREFIX = "import-map-request-"
_APPROVAL_PREFIX = "import-map-approval-"
_AUTHORIZATION_PREFIX = "import-stage-authorization-"


class ImportApprovalError(RuntimeError):
    """Base class for fail-closed import-approval failures."""


class ImportApprovalInvariantError(ImportApprovalError, ValueError):
    """An approval record or caller-supplied value is malformed."""


class ImportApprovalEvidenceMismatch(ImportApprovalError):
    """The candidate, mapping, command, or context evidence is not exact."""


class ImportApprovalActorMismatch(ImportApprovalError):
    """The authenticated actor is not the human actor bound to the request."""


class ImportApprovalStale(ImportApprovalError):
    """A canonical revision, run, coordination context, or generation changed."""


class ImportApprovalExpired(ImportApprovalError):
    """The exact mapping approval is no longer live."""


class ImportApprovalLifecycleError(ImportApprovalError):
    """An approval transition or replay is not legal."""


class ImportApprovalIntegrityError(ImportApprovalError):
    """The durable approval ledger or a sealed record failed verification."""


class MappingDecision(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ImportApprovalLifecycle(StrEnum):
    REQUESTED = "requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    AUTHORIZED = "authorized"
    EXPIRED = "expired"
    INVALIDATED = "invalidated"


class ImportApprovalScope(StrEnum):
    """The only authority this package can issue."""

    MAPPING_TO_CANONICAL_STAGE = "mapping-to-canonical-stage"


class PrincipalRole(StrEnum):
    """Roles accepted at this narrow authority boundary."""

    HUMAN_REVIEWER = "human-reviewer"
    TRUSTED_MAPPER = "trusted-mapper"
    STAGING_SERVICE = "staging-service"


@dataclass(frozen=True, slots=True, eq=False)
class AuthenticatedPrincipal:
    """Opaque provider-issued identity evidence.

    Equality is deliberately identity-based.  A caller-created object with the
    same visible claims is not the provider-issued principal and is rejected at
    the contract boundary.
    """

    principal_id: str
    role: PrincipalRole
    authority_id: str
    authentication_event_sha256: str

    def __post_init__(self) -> None:
        _require_id(self.principal_id, "principal ID")
        _require_id(self.authority_id, "principal authority ID")
        if type(self.role) is not PrincipalRole:
            raise ImportApprovalInvariantError("principal role is invalid")
        _require_sha256(
            self.authentication_event_sha256,
            "principal authentication event digest",
        )

    @property
    def principal_digest(self) -> str:
        return stable_hash(
            {
                "principal_id": self.principal_id,
                "role": self.role.value,
                "authority_id": self.authority_id,
                "authentication_event_sha256": self.authentication_event_sha256,
            },
            domain="flux-clone-authenticated-principal-v1",
        )


@runtime_checkable
class TrustedPrincipalProvider(Protocol):
    """Server-owned adapter that attests an opaque principal object."""

    def attest_principal(
        self,
        *,
        principal: AuthenticatedPrincipal,
        role: PrincipalRole,
    ) -> AuthenticatedPrincipal: ...

    def principal_authority_snapshot_sha256(self) -> str: ...


@dataclass(frozen=True, slots=True)
class CurrentAuthoritySnapshot:
    """Trusted live project, run, coordination, and stage-target authority."""

    project_id: str
    project_head_revision: str
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

    def __post_init__(self) -> None:
        for value, label in (
            (self.project_id, "authority project ID"),
            (self.run_id, "authority run ID"),
            (self.run_incarnation, "authority run incarnation"),
            (self.coordination_incarnation, "authority coordination incarnation"),
            (self.target_store_id, "authority target-store ID"),
            (self.target_store_incarnation, "authority target-store incarnation"),
        ):
            _require_id(value, label)
        for value, label in (
            (self.project_head_revision, "authority project head"),
            (self.project_event_head_sha256, "authority project event head"),
            (self.run_event_head_sha256, "authority run event head"),
            (self.coordination_context_digest, "authority coordination context"),
            (self.coordination_event_head_sha256, "authority coordination event head"),
        ):
            _require_sha256(value, label)
        _require_nonnegative_int(self.run_revision, "authority run revision")

    @property
    def snapshot_digest(self) -> str:
        return stable_hash(self, domain="flux-clone-current-import-authority-v1")


@runtime_checkable
class CurrentAuthorityProvider(Protocol):
    """Trusted adapter that re-reads current authority from server-owned state."""

    def current_authority(
        self,
        *,
        project_id: str,
        run_id: str,
    ) -> CurrentAuthoritySnapshot: ...


@dataclass(frozen=True, slots=True)
class ApprovalSourceSnapshot:
    """Coherent version tokens for every mutable approval source."""

    candidate_id: str
    candidate_version_sha256: str
    mapping_evidence_id: str
    mapping_version_sha256: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    snapshot_sha256: str

    def __post_init__(self) -> None:
        _require_id(self.candidate_id, "source-snapshot candidate ID")
        _require_id(self.mapping_evidence_id, "source-snapshot mapping ID")
        for value, label in (
            (self.candidate_version_sha256, "source-snapshot candidate version"),
            (self.mapping_version_sha256, "source-snapshot mapping version"),
            (self.authority_snapshot_sha256, "source-snapshot authority version"),
            (
                self.principal_authority_snapshot_sha256,
                "source-snapshot principal-authority version",
            ),
            (self.snapshot_sha256, "source-snapshot digest"),
        ):
            _require_sha256(value, label)
        expected = stable_hash(
            {
                "candidate_id": self.candidate_id,
                "candidate_version_sha256": self.candidate_version_sha256,
                "mapping_evidence_id": self.mapping_evidence_id,
                "mapping_version_sha256": self.mapping_version_sha256,
                "authority_snapshot_sha256": self.authority_snapshot_sha256,
                "principal_authority_snapshot_sha256": (
                    self.principal_authority_snapshot_sha256
                ),
            },
            domain="flux-clone-import-approval-source-snapshot-v1",
        )
        if self.snapshot_sha256 != expected:
            raise ImportApprovalInvariantError(
                "approval source-snapshot digest is inconsistent"
            )

    @classmethod
    def create(
        cls,
        *,
        candidate_id: str,
        candidate_version_sha256: str,
        mapping_evidence_id: str,
        mapping_version_sha256: str,
        authority_snapshot_sha256: str,
        principal_authority_snapshot_sha256: str,
    ) -> ApprovalSourceSnapshot:
        material = {
            "candidate_id": candidate_id,
            "candidate_version_sha256": candidate_version_sha256,
            "mapping_evidence_id": mapping_evidence_id,
            "mapping_version_sha256": mapping_version_sha256,
            "authority_snapshot_sha256": authority_snapshot_sha256,
            "principal_authority_snapshot_sha256": (
                principal_authority_snapshot_sha256
            ),
        }
        return cls(
            **material,
            snapshot_sha256=stable_hash(
                material,
                domain="flux-clone-import-approval-source-snapshot-v1",
            ),
        )


@runtime_checkable
class ApprovalSourceCASProvider(Protocol):
    """Trusted atomic freshness fence across candidate/mapping/authority stores."""

    def compare_and_swap_source_snapshot(
        self,
        *,
        expected: ApprovalSourceSnapshot,
        operation_id: str,
    ) -> ApprovalSourceSnapshot: ...


@dataclass(frozen=True, slots=True)
class ApprovalLedgerAnchor:
    """External monotonic anchor for the sealed approval-ledger head."""

    sequence: int
    digest: str

    def __post_init__(self) -> None:
        _require_nonnegative_int(self.sequence, "approval anchor sequence")
        _require_sha256(self.digest, "approval anchor digest")
        if self.sequence == 0 and self.digest != "0" * 64:
            raise ImportApprovalInvariantError(
                "an empty approval anchor must use the zero digest"
            )
        if self.sequence > 0 and self.digest == "0" * 64:
            raise ImportApprovalInvariantError(
                "a non-empty approval anchor cannot use the zero digest"
            )


@runtime_checkable
class ApprovalLedgerAnchorStore(Protocol):
    """Independently durable, monotonic compare-and-swap anchor store."""

    def read_anchor(self, *, issuer_id: str) -> ApprovalLedgerAnchor: ...

    def compare_and_swap_anchor(
        self,
        *,
        issuer_id: str,
        expected: ApprovalLedgerAnchor,
        replacement: ApprovalLedgerAnchor,
    ) -> ApprovalLedgerAnchor: ...


_REQUIRED_LIMITATIONS = (
    "canonical-stage-only",
    "deterministic-verification-and-commit-approval-still-required",
    "kicad-execution-not-run",
    "manufacturing-release-not-authorized",
)


@dataclass(frozen=True, order=True, slots=True)
class ReviewQuestionAnswer:
    question_id: str
    question: str
    answer: str

    def __post_init__(self) -> None:
        _require_id(self.question_id, "review question ID")
        _require_text(self.question, "review question")
        _require_text(self.answer, "review answer")


@dataclass(frozen=True, slots=True)
class ReviewManifest:
    """Exact human-facing material signed by the mapping decision."""

    semantic_diff_json: str
    semantic_diff_sha256: str
    commands_sha256: str
    provenance_set_sha256: str
    advisories_sha256: str
    limitations: tuple[str, ...]
    questions_and_answers: tuple[ReviewQuestionAnswer, ...]
    challenge_sha256: str
    manifest_sha256: str

    def __post_init__(self) -> None:
        if type(self.semantic_diff_json) is not str:
            raise ImportApprovalInvariantError("review semantic diff must be canonical JSON")
        try:
            payload = json.loads(self.semantic_diff_json)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ImportApprovalInvariantError("review semantic diff must be valid JSON") from exc
        from backend.design_kernel.model import canonical_json

        if type(payload) is not dict or canonical_json(payload) != self.semantic_diff_json:
            raise ImportApprovalInvariantError(
                "review semantic diff must be a canonical JSON object"
            )
        for value, label in (
            (self.semantic_diff_sha256, "review semantic-diff digest"),
            (self.commands_sha256, "review commands digest"),
            (self.provenance_set_sha256, "review provenance digest"),
            (self.advisories_sha256, "review advisories digest"),
            (self.challenge_sha256, "review challenge digest"),
            (self.manifest_sha256, "review manifest digest"),
        ):
            _require_sha256(value, label)
        expected_diff = stable_hash(
            payload,
            domain="flux-clone-import-review-semantic-diff-v1",
        )
        if self.semantic_diff_sha256 != expected_diff:
            raise ImportApprovalInvariantError("review semantic-diff digest is inconsistent")
        if (
            type(self.limitations) is not tuple
            or tuple(sorted(set(self.limitations))) != self.limitations
        ):
            raise ImportApprovalInvariantError("review limitations must be sorted and unique")
        for limitation in self.limitations:
            _require_text(limitation, "review limitation")
        if not set(_REQUIRED_LIMITATIONS).issubset(self.limitations):
            raise ImportApprovalInvariantError(
                "review manifest omits a mandatory stage-only limitation"
            )
        if (
            type(self.questions_and_answers) is not tuple
            or not self.questions_and_answers
            or any(
                type(item) is not ReviewQuestionAnswer
                for item in self.questions_and_answers
            )
            or tuple(sorted(set(self.questions_and_answers)))
            != self.questions_and_answers
        ):
            raise ImportApprovalInvariantError(
                "review questions and answers must be a non-empty sorted unique tuple"
            )
        expected = stable_hash(
            {
                "semantic_diff_json": self.semantic_diff_json,
                "semantic_diff_sha256": self.semantic_diff_sha256,
                "commands_sha256": self.commands_sha256,
                "provenance_set_sha256": self.provenance_set_sha256,
                "advisories_sha256": self.advisories_sha256,
                "limitations": self.limitations,
                "questions_and_answers": self.questions_and_answers,
                "challenge_sha256": self.challenge_sha256,
            },
            domain="flux-clone-import-review-manifest-v1",
        )
        if self.manifest_sha256 != expected:
            raise ImportApprovalInvariantError("review manifest digest is inconsistent")

    @classmethod
    def create(
        cls,
        *,
        semantic_diff: dict[str, object],
        commands_sha256: str,
        provenance_set_sha256: str,
        advisories_sha256: str,
        limitations: tuple[str, ...],
        questions_and_answers: tuple[ReviewQuestionAnswer, ...],
        challenge_sha256: str,
    ) -> ReviewManifest:
        from backend.design_kernel.model import canonical_json

        _require_plain_json(semantic_diff, "review semantic diff")

        semantic_diff_json = canonical_json(semantic_diff)
        semantic_diff_sha256 = stable_hash(
            semantic_diff,
            domain="flux-clone-import-review-semantic-diff-v1",
        )
        material = {
            "semantic_diff_json": semantic_diff_json,
            "semantic_diff_sha256": semantic_diff_sha256,
            "commands_sha256": commands_sha256,
            "provenance_set_sha256": provenance_set_sha256,
            "advisories_sha256": advisories_sha256,
            "limitations": limitations,
            "questions_and_answers": questions_and_answers,
            "challenge_sha256": challenge_sha256,
        }
        return cls(
            semantic_diff_json=semantic_diff_json,
            semantic_diff_sha256=semantic_diff_sha256,
            commands_sha256=commands_sha256,
            provenance_set_sha256=provenance_set_sha256,
            advisories_sha256=advisories_sha256,
            limitations=limitations,
            questions_and_answers=questions_and_answers,
            challenge_sha256=challenge_sha256,
            manifest_sha256=stable_hash(
                material,
                domain="flux-clone-import-review-manifest-v1",
            ),
        )


def _require_id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or _PUBLIC_ID.fullmatch(value) is None
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise ImportApprovalInvariantError(f"{label} must be a canonical public identifier")
    return value


def require_approval_id(value: object, label: str) -> str:
    """Validate an approval-ledger public identifier at a package boundary."""

    return _require_id(value, label)


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ImportApprovalInvariantError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_nonnegative_int(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ImportApprovalInvariantError(f"{label} must be a non-negative integer")
    return value


def _require_time(value: object, label: str) -> datetime:
    if (
        type(value) is not datetime
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ImportApprovalInvariantError(f"{label} must be timezone-aware")
    return value


def _time_text(value: datetime) -> str:
    _require_time(value, "timestamp")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def approval_time_text(value: datetime) -> str:
    """Return the exact canonical UTC form used in signed approval material."""

    return _time_text(value)


def _require_text(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value.strip()
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise ImportApprovalInvariantError(
            f"{label} must be non-empty text without control characters"
        )
    return value


def _require_plain_json(value: object, label: str) -> None:
    value_type = type(value)
    if value is None or value_type in {bool, int, float, str}:
        return
    if value_type is list:
        for item in cast(list[object], value):
            _require_plain_json(item, label)
        return
    if value_type is dict:
        for key, item in cast(dict[object, object], value).items():
            if type(key) is not str:
                raise ImportApprovalInvariantError(
                    f"{label} keys must be exact strings"
                )
            _require_plain_json(item, label)
        return
    raise ImportApprovalInvariantError(
        f"{label} must contain only exact JSON builtins"
    )


def commands_sha256(command_hashes: tuple[str, ...]) -> str:
    """Return the canonical mapper command-set digest."""

    if type(command_hashes) is not tuple or not command_hashes:
        raise ImportApprovalInvariantError("ordered command hashes must be a non-empty tuple")
    for value in command_hashes:
        _require_sha256(value, "command hash")
    return stable_hash(
        command_hashes,
        domain="flux-clone-canonical-import-commands-v1",
    )


def import_preview_digest(
    *,
    base_revision: str,
    transaction_id: str,
    prospective_graph_sha256: str,
    command_hashes: tuple[str, ...],
) -> str:
    """Reproduce the DesignKernel v2 preview identity without mutating a kernel."""

    _require_sha256(base_revision, "preview base revision")
    _require_id(transaction_id, "preview transaction ID")
    _require_sha256(prospective_graph_sha256, "preview prospective graph digest")
    commands_sha256(command_hashes)
    return stable_hash(
        {
            "base_revision": base_revision,
            "transaction_id": transaction_id,
            "staged_graph_hash": prospective_graph_sha256,
            "command_hashes": command_hashes,
        },
        domain="flux-clone-preview-v2",
    )


def prospective_revision_sha256(
    *,
    project_id: str,
    base_revision: str,
    prospective_graph_sha256: str,
    commands_digest: str,
    preview_digest: str,
) -> str:
    """Identify the exact pre-commit canonical state without claiming a commit.

    A real ``DesignRevision`` cannot exist until deterministic verification and
    an independent commit approval have been supplied.  This digest therefore
    names the prospective state only; it is intentionally not accepted by the
    kernel as a committed revision hash.
    """

    _require_id(project_id, "prospective project ID")
    for value, label in (
        (base_revision, "prospective base revision"),
        (prospective_graph_sha256, "prospective graph digest"),
        (commands_digest, "prospective commands digest"),
        (preview_digest, "prospective preview digest"),
    ):
        _require_sha256(value, label)
    return stable_hash(
        {
            "project_id": project_id,
            "base_revision": base_revision,
            "prospective_graph_sha256": prospective_graph_sha256,
            "commands_sha256": commands_digest,
            "preview_digest": preview_digest,
            "committed": False,
        },
        domain="flux-clone-canonical-import-prospective-state-v1",
    )


def mapping_generation_fence_sha256(
    *,
    candidate_id: str,
    candidate_sha256: str,
    candidate_generation: int,
    mapping_evidence_id: str,
    mapping_evidence_sha256: str,
    mapping_evidence_generation: int,
    canonical_candidate_sha256: str,
    mapper_result_sha256: str,
) -> str:
    """Stable negative-decision fence requiring new candidate/mapping evidence."""

    _require_id(candidate_id, "fenced candidate ID")
    _require_id(mapping_evidence_id, "fenced mapping evidence ID")
    _require_nonnegative_int(candidate_generation, "fenced candidate generation")
    _require_nonnegative_int(
        mapping_evidence_generation,
        "fenced mapping evidence generation",
    )
    for value, label in (
        (candidate_sha256, "fenced candidate digest"),
        (mapping_evidence_sha256, "fenced mapping evidence digest"),
        (canonical_candidate_sha256, "fenced canonical candidate digest"),
        (mapper_result_sha256, "fenced mapper result digest"),
    ):
        _require_sha256(value, label)
    return stable_hash(
        {
            "candidate_id": candidate_id,
            "candidate_sha256": candidate_sha256,
            "candidate_generation": candidate_generation,
            "mapping_evidence_id": mapping_evidence_id,
            "mapping_evidence_sha256": mapping_evidence_sha256,
            "mapping_evidence_generation": mapping_evidence_generation,
            "canonical_candidate_sha256": canonical_candidate_sha256,
            "mapper_result_sha256": mapper_result_sha256,
        },
        domain="flux-clone-import-approval-generation-fence-v1",
    )


@dataclass(frozen=True, slots=True)
class ImportApprovalContext:
    """Exact live authority and coordination context for one import mapping."""

    project_id: str
    base_revision: str
    prospective_graph_sha256: str
    run_id: str
    run_revision: int
    project_event_head_sha256: str
    run_incarnation: str
    run_event_head_sha256: str
    coordination_incarnation: str
    coordination_context_digest: str
    coordination_event_head_sha256: str
    target_store_id: str
    target_store_incarnation: str
    uploader_principal: AuthenticatedPrincipal
    authorized_human_principal: AuthenticatedPrincipal
    mapping_command_principal: AuthenticatedPrincipal
    staging_service_principal: AuthenticatedPrincipal

    def __post_init__(self) -> None:
        for value, label in (
            (self.project_id, "approval project ID"),
            (self.run_id, "approval run ID"),
            (self.run_incarnation, "approval run incarnation"),
            (self.coordination_incarnation, "coordination incarnation"),
            (self.target_store_id, "approval target-store ID"),
            (self.target_store_incarnation, "approval target-store incarnation"),
        ):
            _require_id(value, label)
        for value, label in (
            (self.base_revision, "approval base revision"),
            (self.prospective_graph_sha256, "approval prospective graph digest"),
            (self.project_event_head_sha256, "approval project event head"),
            (self.run_event_head_sha256, "approval run event head"),
            (self.coordination_context_digest, "coordination context digest"),
            (self.coordination_event_head_sha256, "coordination event head"),
        ):
            _require_sha256(value, label)
        _require_nonnegative_int(self.run_revision, "approval run revision")
        for principal, role, label in (
            (self.uploader_principal, PrincipalRole.HUMAN_REVIEWER, "uploader"),
            (
                self.authorized_human_principal,
                PrincipalRole.HUMAN_REVIEWER,
                "authorized reviewer",
            ),
            (
                self.mapping_command_principal,
                PrincipalRole.TRUSTED_MAPPER,
                "mapping command principal",
            ),
            (
                self.staging_service_principal,
                PrincipalRole.STAGING_SERVICE,
                "staging service principal",
            ),
        ):
            if type(principal) is not AuthenticatedPrincipal or principal.role is not role:
                raise ImportApprovalInvariantError(f"{label} has the wrong principal role")

    @property
    def authorized_human_actor(self) -> str:
        return self.authorized_human_principal.principal_id

    @property
    def mapping_command_actor(self) -> str:
        return self.mapping_command_principal.principal_id

    @property
    def staging_service_actor(self) -> str:
        return self.staging_service_principal.principal_id

    @property
    def authority_snapshot(self) -> CurrentAuthoritySnapshot:
        return CurrentAuthoritySnapshot(
            project_id=self.project_id,
            project_head_revision=self.base_revision,
            project_event_head_sha256=self.project_event_head_sha256,
            run_id=self.run_id,
            run_revision=self.run_revision,
            run_incarnation=self.run_incarnation,
            run_event_head_sha256=self.run_event_head_sha256,
            coordination_context_digest=self.coordination_context_digest,
            coordination_incarnation=self.coordination_incarnation,
            coordination_event_head_sha256=self.coordination_event_head_sha256,
            target_store_id=self.target_store_id,
            target_store_incarnation=self.target_store_incarnation,
        )


def _mapping_subject_material(request: MappingApprovalRequest) -> dict[str, object]:
    return {
        "scope": request.scope.value,
        "issuer_id": request.issuer_id,
        "candidate": {
            "candidate_id": request.candidate_id,
            "candidate_sha256": request.candidate_sha256,
            "generation": request.candidate_generation,
            "last_event_sha256": request.candidate_last_event_sha256,
            "inspection_receipt_sha256": request.inspection_receipt_sha256,
            "resolution_receipt_sha256": request.resolution_receipt_sha256,
        },
        "mapping": {
            "mapping_evidence_id": request.mapping_evidence_id,
            "mapping_evidence_sha256": request.mapping_evidence_sha256,
            "mapping_evidence_generation": request.mapping_evidence_generation,
            "mapping_evidence_last_event_sha256": (
                request.mapping_evidence_last_event_sha256
            ),
            "canonical_candidate_sha256": request.canonical_candidate_sha256,
            "mapper_result_sha256": request.mapper_result_sha256,
            "mapping_generation_fence_sha256": (
                request.mapping_generation_fence_sha256
            ),
            "source_snapshot_sha256": request.source_snapshot_sha256,
        },
        "canonical_state": {
            "project_id": request.project_id,
            "base_revision": request.base_revision,
            "prospective_graph_sha256": request.prospective_graph_sha256,
            "prospective_revision_sha256": request.prospective_revision_sha256,
        },
        "commands": {
            "transaction_id": request.transaction_id,
            "command_hashes": request.command_hashes,
            "commands_sha256": request.commands_sha256,
            "preview_digest": request.preview_digest,
            "review_manifest_sha256": request.review_manifest.manifest_sha256,
        },
        "authority": {
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
        },
    }


@dataclass(frozen=True, slots=True)
class MappingApprovalRequest:
    """Human-review request for one exact resolved import mapping."""

    request_id: str
    issuer_id: str
    candidate_id: str
    candidate_sha256: str
    candidate_generation: int
    candidate_last_event_sha256: str
    inspection_receipt_sha256: str
    resolution_receipt_sha256: str
    mapping_evidence_id: str
    mapping_evidence_sha256: str
    mapping_evidence_generation: int
    mapping_evidence_last_event_sha256: str
    canonical_candidate_sha256: str
    mapper_result_sha256: str
    mapping_generation_fence_sha256: str
    source_snapshot_sha256: str
    project_id: str
    base_revision: str
    prospective_graph_sha256: str
    prospective_revision_sha256: str
    transaction_id: str
    command_hashes: tuple[str, ...]
    commands_sha256: str
    preview_digest: str
    review_manifest: ReviewManifest
    operation_key: str
    uploader_actor: str
    authorized_human_actor: str
    mapping_command_actor: str
    staging_service_actor: str
    uploader_principal_sha256: str
    reviewer_principal_sha256: str
    mapper_principal_sha256: str
    staging_service_principal_sha256: str
    run_id: str
    run_revision: int
    project_event_head_sha256: str
    run_incarnation: str
    run_event_head_sha256: str
    coordination_incarnation: str
    coordination_context_digest: str
    coordination_event_head_sha256: str
    target_store_id: str
    target_store_incarnation: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    requested_at: datetime
    expires_at: datetime
    lifecycle_generation: int
    subject_digest: str
    request_digest: str
    issuer_seal: str
    scope: ImportApprovalScope = ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE

    def __post_init__(self) -> None:
        for value, label in (
            (self.request_id, "mapping request ID"),
            (self.issuer_id, "mapping request issuer ID"),
            (self.candidate_id, "durable candidate ID"),
            (self.project_id, "mapping request project ID"),
            (self.transaction_id, "mapping request transaction ID"),
            (self.mapping_evidence_id, "durable mapping evidence ID"),
            (self.operation_key, "mapping request operation key"),
            (self.uploader_actor, "mapping request uploader"),
            (self.authorized_human_actor, "mapping request human actor"),
            (self.mapping_command_actor, "mapping request command actor"),
            (self.staging_service_actor, "mapping request staging service"),
            (self.run_id, "mapping request run ID"),
            (self.run_incarnation, "mapping request run incarnation"),
            (self.coordination_incarnation, "mapping request coordination incarnation"),
            (self.target_store_id, "mapping request target-store ID"),
            (
                self.target_store_incarnation,
                "mapping request target-store incarnation",
            ),
        ):
            _require_id(value, label)
        for value, label in (
            (self.candidate_sha256, "durable candidate digest"),
            (self.candidate_last_event_sha256, "durable candidate event digest"),
            (self.inspection_receipt_sha256, "inspection receipt digest"),
            (self.resolution_receipt_sha256, "resolution receipt digest"),
            (self.mapping_evidence_sha256, "durable mapping evidence digest"),
            (
                self.mapping_evidence_last_event_sha256,
                "durable mapping evidence event digest",
            ),
            (self.canonical_candidate_sha256, "canonical candidate digest"),
            (self.mapper_result_sha256, "mapper result digest"),
            (
                self.mapping_generation_fence_sha256,
                "mapping generation fence digest",
            ),
            (self.source_snapshot_sha256, "approval source-snapshot digest"),
            (self.base_revision, "mapping request base revision"),
            (self.prospective_graph_sha256, "prospective graph digest"),
            (self.prospective_revision_sha256, "prospective state digest"),
            (self.commands_sha256, "mapping request commands digest"),
            (self.preview_digest, "mapping request preview digest"),
            (self.uploader_principal_sha256, "mapping request uploader principal"),
            (self.reviewer_principal_sha256, "mapping request reviewer principal"),
            (self.mapper_principal_sha256, "mapping request mapper principal"),
            (
                self.staging_service_principal_sha256,
                "mapping request staging-service principal",
            ),
            (self.project_event_head_sha256, "mapping request project event head"),
            (self.run_event_head_sha256, "mapping request run event head"),
            (self.coordination_context_digest, "mapping request coordination digest"),
            (
                self.coordination_event_head_sha256,
                "mapping request coordination event head",
            ),
            (self.authority_snapshot_sha256, "mapping request authority snapshot"),
            (
                self.principal_authority_snapshot_sha256,
                "mapping request principal-authority snapshot",
            ),
            (self.subject_digest, "mapping request subject digest"),
            (self.request_digest, "mapping request digest"),
            (self.issuer_seal, "mapping request issuer seal"),
        ):
            _require_sha256(value, label)
        _require_nonnegative_int(self.candidate_generation, "durable candidate generation")
        _require_nonnegative_int(
            self.mapping_evidence_generation,
            "durable mapping evidence generation",
        )
        _require_nonnegative_int(self.run_revision, "mapping request run revision")
        if type(self.review_manifest) is not ReviewManifest:
            raise ImportApprovalInvariantError("mapping request review manifest is invalid")
        if self.review_manifest.commands_sha256 != self.commands_sha256:
            raise ImportApprovalInvariantError(
                "mapping request review manifest does not bind its commands"
            )
        expected_fence = mapping_generation_fence_sha256(
            candidate_id=self.candidate_id,
            candidate_sha256=self.candidate_sha256,
            candidate_generation=self.candidate_generation,
            mapping_evidence_id=self.mapping_evidence_id,
            mapping_evidence_sha256=self.mapping_evidence_sha256,
            mapping_evidence_generation=self.mapping_evidence_generation,
            canonical_candidate_sha256=self.canonical_candidate_sha256,
            mapper_result_sha256=self.mapper_result_sha256,
        )
        if self.mapping_generation_fence_sha256 != expected_fence:
            raise ImportApprovalInvariantError(
                "mapping request generation fence is inconsistent"
            )
        source_snapshot = ApprovalSourceSnapshot.create(
            candidate_id=self.candidate_id,
            candidate_version_sha256=stable_hash(
                {
                    "candidate_id": self.candidate_id,
                    "candidate_sha256": self.candidate_sha256,
                    "generation": self.candidate_generation,
                    "last_event_sha256": self.candidate_last_event_sha256,
                    "state": "resolved",
                },
                domain="flux-clone-import-approval-candidate-version-v1",
            ),
            mapping_evidence_id=self.mapping_evidence_id,
            mapping_version_sha256=stable_hash(
                {
                    "mapping_evidence_id": self.mapping_evidence_id,
                    "mapping_evidence_sha256": self.mapping_evidence_sha256,
                    "generation": self.mapping_evidence_generation,
                    "last_event_sha256": self.mapping_evidence_last_event_sha256,
                    "state": "active",
                },
                domain="flux-clone-import-approval-mapping-version-v1",
            ),
            authority_snapshot_sha256=self.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                self.principal_authority_snapshot_sha256
            ),
        )
        if source_snapshot.snapshot_sha256 != self.source_snapshot_sha256:
            raise ImportApprovalInvariantError(
                "mapping request source snapshot is inconsistent"
            )
        authority = CurrentAuthoritySnapshot(
            project_id=self.project_id,
            project_head_revision=self.base_revision,
            project_event_head_sha256=self.project_event_head_sha256,
            run_id=self.run_id,
            run_revision=self.run_revision,
            run_incarnation=self.run_incarnation,
            run_event_head_sha256=self.run_event_head_sha256,
            coordination_context_digest=self.coordination_context_digest,
            coordination_incarnation=self.coordination_incarnation,
            coordination_event_head_sha256=self.coordination_event_head_sha256,
            target_store_id=self.target_store_id,
            target_store_incarnation=self.target_store_incarnation,
        )
        if authority.snapshot_digest != self.authority_snapshot_sha256:
            raise ImportApprovalInvariantError(
                "mapping request authority snapshot is inconsistent"
            )
        if len(
            {
                self.mapping_command_actor,
                self.staging_service_actor,
                self.authorized_human_actor,
            }
        ) != 3:
            raise ImportApprovalInvariantError(
                "reviewer, mapper, and staging service must be distinct"
            )
        if type(self.lifecycle_generation) is not int or self.lifecycle_generation != 0:
            raise ImportApprovalInvariantError("a new mapping request must be generation zero")
        if type(self.scope) is not ImportApprovalScope or (
            self.scope is not ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE
        ):
            raise ImportApprovalInvariantError("mapping approval scope must be stage-only")
        requested_at = _require_time(self.requested_at, "mapping request time")
        expires_at = _require_time(self.expires_at, "mapping request expiry")
        if expires_at <= requested_at:
            raise ImportApprovalInvariantError("mapping request expiry must follow its request")
        expected_commands = commands_sha256(self.command_hashes)
        if self.commands_sha256 != expected_commands:
            raise ImportApprovalInvariantError("mapping request commands digest is inconsistent")
        expected_preview = import_preview_digest(
            base_revision=self.base_revision,
            transaction_id=self.transaction_id,
            prospective_graph_sha256=self.prospective_graph_sha256,
            command_hashes=self.command_hashes,
        )
        if self.preview_digest != expected_preview:
            raise ImportApprovalInvariantError("mapping request preview digest is inconsistent")
        expected_prospective = prospective_revision_sha256(
            project_id=self.project_id,
            base_revision=self.base_revision,
            prospective_graph_sha256=self.prospective_graph_sha256,
            commands_digest=self.commands_sha256,
            preview_digest=self.preview_digest,
        )
        if self.prospective_revision_sha256 != expected_prospective:
            raise ImportApprovalInvariantError("mapping request prospective state is inconsistent")
        expected_subject = stable_hash(
            _mapping_subject_material(self),
            domain="flux-clone-import-mapping-approval-subject-v1",
        )
        if self.subject_digest != expected_subject:
            raise ImportApprovalInvariantError("mapping request subject digest is inconsistent")
        expected_request = stable_hash(
            {
                "subject_digest": self.subject_digest,
                "requested_at": _time_text(self.requested_at),
                "expires_at": _time_text(self.expires_at),
                "lifecycle_generation": self.lifecycle_generation,
                "operation_key": self.operation_key,
            },
            domain="flux-clone-import-mapping-approval-request-v1",
        )
        if self.request_digest != expected_request:
            raise ImportApprovalInvariantError("mapping request digest is inconsistent")
        if self.request_id != f"{_REQUEST_PREFIX}{self.request_digest[:32]}":
            raise ImportApprovalInvariantError("mapping request ID does not derive from its digest")


@dataclass(frozen=True, slots=True)
class HumanMappingApproval:
    """Authenticated human decision about a mapping, not a commit or release."""

    approval_id: str
    issuer_id: str
    request_id: str
    request_digest: str
    subject_digest: str
    decision: MappingDecision
    decided_by: str
    decided_principal_sha256: str
    decided_at: datetime
    expires_at: datetime
    lifecycle_generation: int
    approval_digest: str
    issuer_seal: str
    reason: str | None = None
    scope: ImportApprovalScope = ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE
    authorizes_internal_commit: bool = False
    authorizes_manufacturing_release: bool = False

    def __post_init__(self) -> None:
        for value, label in (
            (self.approval_id, "mapping approval ID"),
            (self.issuer_id, "mapping approval issuer ID"),
            (self.request_id, "mapping approval request ID"),
            (self.decided_by, "mapping approval actor"),
        ):
            _require_id(value, label)
        for value, label in (
            (self.request_digest, "mapping approval request digest"),
            (self.subject_digest, "mapping approval subject digest"),
            (self.decided_principal_sha256, "mapping approval principal digest"),
            (self.approval_digest, "mapping approval digest"),
            (self.issuer_seal, "mapping approval issuer seal"),
        ):
            _require_sha256(value, label)
        if type(self.decision) is not MappingDecision:
            raise ImportApprovalInvariantError("mapping approval decision is invalid")
        if type(self.lifecycle_generation) is not int or self.lifecycle_generation != 1:
            raise ImportApprovalInvariantError("a human mapping decision must be generation one")
        decided_at = _require_time(self.decided_at, "mapping approval decision time")
        expires_at = _require_time(self.expires_at, "mapping approval expiry")
        if decided_at >= expires_at:
            raise ImportApprovalInvariantError("mapping approval cannot be decided at expiry")
        if self.reason is not None:
            _require_text(self.reason, "mapping approval reason")
        if self.decision is MappingDecision.REJECTED and self.reason is None:
            raise ImportApprovalInvariantError("a rejected mapping requires a reason")
        if type(self.scope) is not ImportApprovalScope or (
            self.scope is not ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE
        ):
            raise ImportApprovalInvariantError("mapping decision scope must be stage-only")
        if self.authorizes_internal_commit is not False:
            raise ImportApprovalInvariantError(
                "mapping approval cannot authorize an internal commit"
            )
        if self.authorizes_manufacturing_release is not False:
            raise ImportApprovalInvariantError(
                "mapping approval cannot authorize manufacturing release"
            )
        expected = stable_hash(
            {
                "issuer_id": self.issuer_id,
                "request_id": self.request_id,
                "request_digest": self.request_digest,
                "subject_digest": self.subject_digest,
                "scope": self.scope.value,
                "decision": self.decision.value,
                "decided_by": self.decided_by,
                "decided_principal_sha256": self.decided_principal_sha256,
                "decided_at": _time_text(self.decided_at),
                "expires_at": _time_text(self.expires_at),
                "lifecycle_generation": self.lifecycle_generation,
                "reason": self.reason,
                "authorizes_internal_commit": self.authorizes_internal_commit,
                "authorizes_manufacturing_release": (
                    self.authorizes_manufacturing_release
                ),
            },
            domain="flux-clone-human-import-mapping-approval-v1",
        )
        if self.approval_digest != expected:
            raise ImportApprovalInvariantError("mapping approval digest is inconsistent")
        if self.approval_id != f"{_APPROVAL_PREFIX}{self.approval_digest[:32]}":
            raise ImportApprovalInvariantError(
                "mapping approval ID does not derive from its digest"
            )


@dataclass(frozen=True, slots=True)
class AuthorizedImportStagingInput:
    """Sealed, stage-only input for an exact canonical import transaction.

    Consumers must validate this object through its issuing
    :class:`ImportApprovalContract` immediately before staging.  The embedded
    transaction input remains unverified and uncommitted; this record is never
    suitable as ``DesignKernel.commit`` or manufacturing-release approval.
    """

    authorization_id: str
    issuer_id: str
    request_id: str
    request_digest: str
    subject_digest: str
    mapping_approval_id: str
    mapping_approval_digest: str
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
    project_id: str
    base_revision: str
    prospective_graph_sha256: str
    prospective_revision_sha256: str
    transaction_id: str
    command_hashes: tuple[str, ...]
    commands_sha256: str
    preview_digest: str
    review_manifest_sha256: str
    operation_key: str
    uploader_actor: str
    authorized_human_actor: str
    mapping_command_actor: str
    staging_service_actor: str
    uploader_principal_sha256: str
    reviewer_principal_sha256: str
    mapper_principal_sha256: str
    staging_service_principal_sha256: str
    run_id: str
    run_revision: int
    project_event_head_sha256: str
    run_incarnation: str
    run_event_head_sha256: str
    coordination_incarnation: str
    coordination_context_digest: str
    coordination_event_head_sha256: str
    target_store_id: str
    target_store_incarnation: str
    authority_snapshot_sha256: str
    principal_authority_snapshot_sha256: str
    issued_at: datetime
    expires_at: datetime
    lifecycle_generation: int
    transaction_input: CanonicalImportTransactionInput
    authorization_digest: str
    issuer_seal: str
    scope: ImportApprovalScope = ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE
    authorizes_internal_commit: bool = False
    authorizes_manufacturing_release: bool = False
    commit_approval_id: None = None
    release_approval_id: None = None

    def __post_init__(self) -> None:
        for value, label in (
            (self.authorization_id, "staging authorization ID"),
            (self.issuer_id, "staging authorization issuer ID"),
            (self.request_id, "staging authorization request ID"),
            (self.mapping_approval_id, "mapping approval ID"),
            (self.candidate_id, "staging candidate ID"),
            (self.mapping_evidence_id, "staging mapping evidence ID"),
            (self.project_id, "staging project ID"),
            (self.transaction_id, "staging transaction ID"),
            (self.operation_key, "staging operation key"),
            (self.uploader_actor, "staging uploader actor"),
            (self.authorized_human_actor, "staging human actor"),
            (self.mapping_command_actor, "staging command actor"),
            (self.staging_service_actor, "staging service actor"),
            (self.run_id, "staging run ID"),
            (self.run_incarnation, "staging run incarnation"),
            (self.coordination_incarnation, "staging coordination incarnation"),
            (self.target_store_id, "staging target-store ID"),
            (self.target_store_incarnation, "staging target-store incarnation"),
        ):
            _require_id(value, label)
        for value, label in (
            (self.request_digest, "staging request digest"),
            (self.subject_digest, "staging subject digest"),
            (self.mapping_approval_digest, "mapping approval digest"),
            (self.candidate_sha256, "staging candidate digest"),
            (self.candidate_last_event_sha256, "staging candidate event digest"),
            (self.mapping_evidence_sha256, "staging mapping evidence digest"),
            (
                self.mapping_evidence_last_event_sha256,
                "staging mapping evidence event digest",
            ),
            (self.canonical_candidate_sha256, "staging canonical candidate digest"),
            (self.mapper_result_sha256, "staging mapper result digest"),
            (self.source_snapshot_sha256, "staging source-snapshot digest"),
            (self.base_revision, "staging base revision"),
            (self.prospective_graph_sha256, "staging prospective graph digest"),
            (self.prospective_revision_sha256, "staging prospective state digest"),
            (self.commands_sha256, "staging commands digest"),
            (self.preview_digest, "staging preview digest"),
            (self.review_manifest_sha256, "staging review manifest digest"),
            (self.uploader_principal_sha256, "staging uploader principal"),
            (self.reviewer_principal_sha256, "staging reviewer principal"),
            (self.mapper_principal_sha256, "staging mapper principal"),
            (
                self.staging_service_principal_sha256,
                "staging service principal",
            ),
            (self.project_event_head_sha256, "staging project event head"),
            (self.run_event_head_sha256, "staging run event head"),
            (self.coordination_context_digest, "staging coordination context digest"),
            (self.coordination_event_head_sha256, "staging coordination event head"),
            (self.authority_snapshot_sha256, "staging authority snapshot"),
            (
                self.principal_authority_snapshot_sha256,
                "staging principal-authority snapshot",
            ),
            (self.authorization_digest, "staging authorization digest"),
            (self.issuer_seal, "staging authorization issuer seal"),
        ):
            _require_sha256(value, label)
        _require_nonnegative_int(self.candidate_generation, "staging candidate generation")
        _require_nonnegative_int(
            self.mapping_evidence_generation,
            "staging mapping evidence generation",
        )
        _require_nonnegative_int(self.run_revision, "staging run revision")
        if type(self.lifecycle_generation) is not int or self.lifecycle_generation != 2:
            raise ImportApprovalInvariantError("staging authorization must be generation two")
        issued_at = _require_time(self.issued_at, "staging authorization issue time")
        expires_at = _require_time(self.expires_at, "staging authorization expiry")
        if issued_at >= expires_at:
            raise ImportApprovalInvariantError("staging authorization cannot issue at expiry")
        if type(self.scope) is not ImportApprovalScope or (
            self.scope is not ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE
        ):
            raise ImportApprovalInvariantError("staging authorization scope is invalid")
        if self.authorizes_internal_commit is not False or self.commit_approval_id is not None:
            raise ImportApprovalInvariantError("staging input cannot carry commit authority")
        if (
            self.authorizes_manufacturing_release is not False
            or self.release_approval_id is not None
        ):
            raise ImportApprovalInvariantError("staging input cannot carry release authority")
        if type(self.transaction_input) is not CanonicalImportTransactionInput:
            raise ImportApprovalInvariantError(
                "staging input must embed CanonicalImportTransactionInput"
            )
        transaction = self.transaction_input
        transaction_hashes = tuple(command.command_hash for command in transaction.commands)
        if (
            transaction.transaction_id != self.transaction_id
            or transaction.base_revision != self.base_revision
            or transaction.authorized_actor != self.mapping_command_actor
            or transaction.candidate_sha256 != self.canonical_candidate_sha256
            or transaction.prospective_graph_sha256 != self.prospective_graph_sha256
            or transaction.commands_sha256 != self.commands_sha256
            or transaction_hashes != self.command_hashes
        ):
            raise ImportApprovalInvariantError(
                "embedded staging transaction does not match its authorization bindings"
            )
        if commands_sha256(self.command_hashes) != self.commands_sha256:
            raise ImportApprovalInvariantError("staging command digest is inconsistent")
        if import_preview_digest(
            base_revision=self.base_revision,
            transaction_id=self.transaction_id,
            prospective_graph_sha256=self.prospective_graph_sha256,
            command_hashes=self.command_hashes,
        ) != self.preview_digest:
            raise ImportApprovalInvariantError("staging preview digest is inconsistent")
        if prospective_revision_sha256(
            project_id=self.project_id,
            base_revision=self.base_revision,
            prospective_graph_sha256=self.prospective_graph_sha256,
            commands_digest=self.commands_sha256,
            preview_digest=self.preview_digest,
        ) != self.prospective_revision_sha256:
            raise ImportApprovalInvariantError("staging prospective state digest is inconsistent")
        authority = CurrentAuthoritySnapshot(
            project_id=self.project_id,
            project_head_revision=self.base_revision,
            project_event_head_sha256=self.project_event_head_sha256,
            run_id=self.run_id,
            run_revision=self.run_revision,
            run_incarnation=self.run_incarnation,
            run_event_head_sha256=self.run_event_head_sha256,
            coordination_context_digest=self.coordination_context_digest,
            coordination_incarnation=self.coordination_incarnation,
            coordination_event_head_sha256=self.coordination_event_head_sha256,
            target_store_id=self.target_store_id,
            target_store_incarnation=self.target_store_incarnation,
        )
        if authority.snapshot_digest != self.authority_snapshot_sha256:
            raise ImportApprovalInvariantError(
                "staging authority snapshot is inconsistent"
            )
        source_snapshot = ApprovalSourceSnapshot.create(
            candidate_id=self.candidate_id,
            candidate_version_sha256=stable_hash(
                {
                    "candidate_id": self.candidate_id,
                    "candidate_sha256": self.candidate_sha256,
                    "generation": self.candidate_generation,
                    "last_event_sha256": self.candidate_last_event_sha256,
                    "state": "resolved",
                },
                domain="flux-clone-import-approval-candidate-version-v1",
            ),
            mapping_evidence_id=self.mapping_evidence_id,
            mapping_version_sha256=stable_hash(
                {
                    "mapping_evidence_id": self.mapping_evidence_id,
                    "mapping_evidence_sha256": self.mapping_evidence_sha256,
                    "generation": self.mapping_evidence_generation,
                    "last_event_sha256": self.mapping_evidence_last_event_sha256,
                    "state": "active",
                },
                domain="flux-clone-import-approval-mapping-version-v1",
            ),
            authority_snapshot_sha256=self.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                self.principal_authority_snapshot_sha256
            ),
        )
        if source_snapshot.snapshot_sha256 != self.source_snapshot_sha256:
            raise ImportApprovalInvariantError(
                "staging source snapshot is inconsistent"
            )
        expected = stable_hash(
            {
                "issuer_id": self.issuer_id,
                "request_id": self.request_id,
                "request_digest": self.request_digest,
                "subject_digest": self.subject_digest,
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
                "base_revision": self.base_revision,
                "prospective_graph_sha256": self.prospective_graph_sha256,
                "prospective_revision_sha256": self.prospective_revision_sha256,
                "transaction_id": self.transaction_id,
                "command_hashes": self.command_hashes,
                "commands_sha256": self.commands_sha256,
                "preview_digest": self.preview_digest,
                "review_manifest_sha256": self.review_manifest_sha256,
                "operation_key": self.operation_key,
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
                "issued_at": _time_text(self.issued_at),
                "expires_at": _time_text(self.expires_at),
                "lifecycle_generation": self.lifecycle_generation,
                "scope": self.scope.value,
                "authorizes_internal_commit": self.authorizes_internal_commit,
                "authorizes_manufacturing_release": (
                    self.authorizes_manufacturing_release
                ),
                "commit_approval_id": self.commit_approval_id,
                "release_approval_id": self.release_approval_id,
            },
            domain="flux-clone-authorized-import-staging-input-v1",
        )
        if self.authorization_digest != expected:
            raise ImportApprovalInvariantError("staging authorization digest is inconsistent")
        if self.authorization_id != (
            f"{_AUTHORIZATION_PREFIX}{self.authorization_digest[:32]}"
        ):
            raise ImportApprovalInvariantError(
                "staging authorization ID does not derive from its digest"
            )

    @property
    def stage_receipt_digest(self) -> str:
        """Disabled until a durable project-store stage journal issues a receipt."""

        raise ImportApprovalLifecycleError(
            "an authorization digest is not proof of staging; a durable stage journal "
            "must issue the stage receipt"
        )


@dataclass(frozen=True, slots=True)
class ImportApprovalStatus:
    """Read-only lifecycle snapshot used for reconciliation after a crash."""

    request: MappingApprovalRequest
    state: ImportApprovalLifecycle
    generation: int
    approval: HumanMappingApproval | None = None
    authorization: AuthorizedImportStagingInput | None = None
    invalidated_by: str | None = None
    invalidated_principal_sha256: str | None = None
    invalidation_reason: str | None = None

    def __post_init__(self) -> None:
        if type(self.request) is not MappingApprovalRequest:
            raise ImportApprovalInvariantError("approval status request is invalid")
        if type(self.state) is not ImportApprovalLifecycle:
            raise ImportApprovalInvariantError("approval status state is invalid")
        _require_nonnegative_int(self.generation, "approval status generation")
        if self.approval is not None and type(self.approval) is not HumanMappingApproval:
            raise ImportApprovalInvariantError("approval status decision is invalid")
        if (
            self.authorization is not None
            and type(self.authorization) is not AuthorizedImportStagingInput
        ):
            raise ImportApprovalInvariantError("approval status authorization is invalid")
        if self.invalidated_by is not None:
            _require_id(self.invalidated_by, "approval invalidation actor")
        if self.invalidated_principal_sha256 is not None:
            _require_sha256(
                self.invalidated_principal_sha256,
                "approval invalidation principal digest",
            )
        if self.invalidation_reason is not None:
            _require_text(self.invalidation_reason, "approval invalidation reason")
        invalidation_fields = (
            self.invalidated_by,
            self.invalidated_principal_sha256,
            self.invalidation_reason,
        )
        if self.state is ImportApprovalLifecycle.INVALIDATED:
            if any(value is None for value in invalidation_fields):
                raise ImportApprovalInvariantError(
                    "invalidated lifecycle evidence lacks actor and reason"
                )
            if (
                self.invalidated_by != self.request.staging_service_actor
                or self.invalidated_principal_sha256
                != self.request.staging_service_principal_sha256
            ):
                raise ImportApprovalInvariantError(
                    "invalidation is not bound to the request's staging principal"
                )
        elif any(value is not None for value in invalidation_fields):
            raise ImportApprovalInvariantError(
                "non-invalidated lifecycle carries invalidation evidence"
            )
        evidence_generation = (
            2 if self.authorization is not None else 1 if self.approval is not None else 0
        )
        if self.state is ImportApprovalLifecycle.REQUESTED:
            valid_shape = evidence_generation == 0 and self.generation == 0
        elif self.state in {
            ImportApprovalLifecycle.APPROVED,
            ImportApprovalLifecycle.REJECTED,
        }:
            valid_shape = evidence_generation == 1 and self.generation == 1
        elif self.state is ImportApprovalLifecycle.AUTHORIZED:
            valid_shape = evidence_generation == 2 and self.generation == 2
        else:
            valid_shape = self.generation == evidence_generation + 1
        if not valid_shape:
            raise ImportApprovalInvariantError(
                "approval lifecycle state, generation, and evidence shape disagree"
            )

        approval = self.approval
        authorization = self.authorization
        if approval is None:
            if self.state not in {
                ImportApprovalLifecycle.REQUESTED,
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            }:
                raise ImportApprovalInvariantError(
                    "approval lifecycle state requires a human decision"
                )
        else:
            self._validate_approval_binding(self.request, approval)
            if approval.decision is MappingDecision.REJECTED:
                if self.state is not ImportApprovalLifecycle.REJECTED:
                    raise ImportApprovalInvariantError(
                        "a rejected decision must remain a terminal rejected lifecycle"
                    )
            elif self.state not in {
                ImportApprovalLifecycle.APPROVED,
                ImportApprovalLifecycle.AUTHORIZED,
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            }:
                raise ImportApprovalInvariantError(
                    "an approved decision contradicts the lifecycle state"
                )

        if authorization is None:
            if self.state is ImportApprovalLifecycle.AUTHORIZED:
                raise ImportApprovalInvariantError(
                    "authorized lifecycle evidence lacks its authorization"
                )
        else:
            if approval is None or approval.decision is not MappingDecision.APPROVED:
                raise ImportApprovalInvariantError(
                    "staging authorization requires its exact approved decision"
                )
            if self.state not in {
                ImportApprovalLifecycle.AUTHORIZED,
                ImportApprovalLifecycle.EXPIRED,
                ImportApprovalLifecycle.INVALIDATED,
            }:
                raise ImportApprovalInvariantError(
                    "staging authorization contradicts the lifecycle state"
                )
            self._validate_authorization_binding(
                self.request,
                approval,
                authorization,
            )

    @staticmethod
    def _validate_approval_binding(
        request: MappingApprovalRequest,
        approval: HumanMappingApproval,
    ) -> None:
        if (
            approval.issuer_id != request.issuer_id
            or approval.request_id != request.request_id
            or approval.request_digest != request.request_digest
            or approval.subject_digest != request.subject_digest
            or approval.scope is not request.scope
            or approval.decided_by != request.authorized_human_actor
            or approval.decided_principal_sha256
            != request.reviewer_principal_sha256
            or approval.expires_at != request.expires_at
            or approval.decided_at < request.requested_at
        ):
            raise ImportApprovalInvariantError(
                "human decision is not bound to the exact request, reviewer, and expiry"
            )

    @staticmethod
    def _validate_authorization_binding(
        request: MappingApprovalRequest,
        approval: HumanMappingApproval,
        authorization: AuthorizedImportStagingInput,
    ) -> None:
        request_bindings = (
            (authorization.issuer_id, request.issuer_id),
            (authorization.request_id, request.request_id),
            (authorization.request_digest, request.request_digest),
            (authorization.subject_digest, request.subject_digest),
            (authorization.candidate_id, request.candidate_id),
            (authorization.candidate_sha256, request.candidate_sha256),
            (authorization.candidate_generation, request.candidate_generation),
            (
                authorization.candidate_last_event_sha256,
                request.candidate_last_event_sha256,
            ),
            (authorization.mapping_evidence_id, request.mapping_evidence_id),
            (
                authorization.mapping_evidence_sha256,
                request.mapping_evidence_sha256,
            ),
            (
                authorization.mapping_evidence_generation,
                request.mapping_evidence_generation,
            ),
            (
                authorization.mapping_evidence_last_event_sha256,
                request.mapping_evidence_last_event_sha256,
            ),
            (
                authorization.canonical_candidate_sha256,
                request.canonical_candidate_sha256,
            ),
            (authorization.mapper_result_sha256, request.mapper_result_sha256),
            (authorization.source_snapshot_sha256, request.source_snapshot_sha256),
            (authorization.project_id, request.project_id),
            (authorization.base_revision, request.base_revision),
            (
                authorization.prospective_graph_sha256,
                request.prospective_graph_sha256,
            ),
            (
                authorization.prospective_revision_sha256,
                request.prospective_revision_sha256,
            ),
            (authorization.transaction_id, request.transaction_id),
            (authorization.command_hashes, request.command_hashes),
            (authorization.commands_sha256, request.commands_sha256),
            (authorization.preview_digest, request.preview_digest),
            (
                authorization.review_manifest_sha256,
                request.review_manifest.manifest_sha256,
            ),
            (authorization.operation_key, request.operation_key),
            (authorization.uploader_actor, request.uploader_actor),
            (
                authorization.authorized_human_actor,
                request.authorized_human_actor,
            ),
            (authorization.mapping_command_actor, request.mapping_command_actor),
            (authorization.staging_service_actor, request.staging_service_actor),
            (
                authorization.uploader_principal_sha256,
                request.uploader_principal_sha256,
            ),
            (
                authorization.reviewer_principal_sha256,
                request.reviewer_principal_sha256,
            ),
            (
                authorization.mapper_principal_sha256,
                request.mapper_principal_sha256,
            ),
            (
                authorization.staging_service_principal_sha256,
                request.staging_service_principal_sha256,
            ),
            (authorization.run_id, request.run_id),
            (authorization.run_revision, request.run_revision),
            (
                authorization.project_event_head_sha256,
                request.project_event_head_sha256,
            ),
            (authorization.run_incarnation, request.run_incarnation),
            (authorization.run_event_head_sha256, request.run_event_head_sha256),
            (
                authorization.coordination_incarnation,
                request.coordination_incarnation,
            ),
            (
                authorization.coordination_context_digest,
                request.coordination_context_digest,
            ),
            (
                authorization.coordination_event_head_sha256,
                request.coordination_event_head_sha256,
            ),
            (authorization.target_store_id, request.target_store_id),
            (
                authorization.target_store_incarnation,
                request.target_store_incarnation,
            ),
            (
                authorization.authority_snapshot_sha256,
                request.authority_snapshot_sha256,
            ),
            (
                authorization.principal_authority_snapshot_sha256,
                request.principal_authority_snapshot_sha256,
            ),
            (authorization.expires_at, request.expires_at),
        )
        if (
            any(actual != expected for actual, expected in request_bindings)
            or authorization.scope is not request.scope
            or authorization.mapping_approval_id != approval.approval_id
            or authorization.mapping_approval_digest != approval.approval_digest
            or authorization.issued_at < approval.decided_at
            or authorization.issued_at < request.requested_at
        ):
            raise ImportApprovalInvariantError(
                "staging authorization is not bound to the exact request and decision"
            )


__all__ = (
    "ApprovalLedgerAnchor",
    "ApprovalLedgerAnchorStore",
    "ApprovalSourceCASProvider",
    "ApprovalSourceSnapshot",
    "AuthenticatedPrincipal",
    "AuthorizedImportStagingInput",
    "CurrentAuthorityProvider",
    "CurrentAuthoritySnapshot",
    "HumanMappingApproval",
    "ImportApprovalActorMismatch",
    "ImportApprovalContext",
    "ImportApprovalError",
    "ImportApprovalEvidenceMismatch",
    "ImportApprovalExpired",
    "ImportApprovalInvariantError",
    "ImportApprovalIntegrityError",
    "ImportApprovalLifecycle",
    "ImportApprovalLifecycleError",
    "ImportApprovalScope",
    "ImportApprovalStale",
    "ImportApprovalStatus",
    "MappingApprovalRequest",
    "MappingDecision",
    "PrincipalRole",
    "ReviewManifest",
    "ReviewQuestionAnswer",
    "TrustedPrincipalProvider",
    "commands_sha256",
    "import_preview_digest",
    "prospective_revision_sha256",
)
