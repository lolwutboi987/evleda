"""Issuer-owned, single-use authority for one exact kernel commit.

The live HMAC capability is intentionally process-local. The application owns
the issuer and its immutable release-approval registry; the kernel receives
only :class:`HmacCommitVerifier`. Verification copies caller-owned input into
an exact, non-virtual claims snapshot before any binding decision is made.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import RLock

from .model import InvariantViolation, canonical_json, stable_hash

COMMIT_AUTHORIZATION_SCOPE = "canonical-design-commit"
COMMIT_AUTHORIZATION_VERSION = 2
_AUTHORIZATION_DOMAIN = "flux-clone-kernel-commit-authorization-v2"
_COMMANDS_DOMAIN = "flux-clone-kernel-commit-command-hashes-v1"
_SEAL_DOMAIN = b"flux-clone-kernel-commit-authorization-seal-v2\0"
_AUTHORIZATION_ID_PREFIX = "commit-authorization-"


class CommitAuthorizationError(RuntimeError):
    """A commit capability is missing, invalid, expired, forged, or replayed."""


class InvalidCommitAuthorization(CommitAuthorizationError):
    """The capability is not an authentic commit-only capability."""


class ExpiredCommitAuthorization(CommitAuthorizationError):
    """The capability is not valid at the authority's current time."""


class ReplayedCommitAuthorization(CommitAuthorizationError):
    """The one-use nonce has already authorized a live commit."""


class CommitAuthorityClockRollback(CommitAuthorizationError):
    """The authority clock moved backwards and this incarnation is poisoned."""


def _require_exact_str(value: object, label: str) -> str:
    if type(value) is not str:
        raise InvariantViolation(f"{label} must be an exact string")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise InvariantViolation(f"{label} must contain valid Unicode") from exc
    return value


def _require_id(value: object, label: str) -> str:
    text = _require_exact_str(value, label)
    if (
        not text
        or text != text.strip()
        or any(character.isspace() for character in text)
        or any(unicodedata.category(character).startswith("C") for character in text)
        or unicodedata.normalize("NFC", text) != text
    ):
        raise InvariantViolation(f"{label} must be a canonical non-empty identifier")
    return text


def _require_sha256(value: object, label: str) -> str:
    text = _require_exact_str(value, label)
    if len(text) != 64 or any(character not in "0123456789abcdef" for character in text):
        raise InvariantViolation(f"{label} must be a lowercase SHA-256 digest")
    return text


def _require_bool(value: object, label: str) -> bool:
    if type(value) is not bool:
        raise InvariantViolation(f"{label} must be an exact boolean")
    return value


def _normalize_time(value: object, label: str) -> datetime:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise InvariantViolation(f"{label} must be an exact timezone-aware datetime")
    normalized = value.astimezone(UTC)
    return datetime(
        normalized.year,
        normalized.month,
        normalized.day,
        normalized.hour,
        normalized.minute,
        normalized.second,
        normalized.microsecond,
        tzinfo=UTC,
        fold=0,
    )


def _require_utc_time(value: object, label: str) -> datetime:
    if type(value) is not datetime:
        raise InvariantViolation(f"{label} must be an exact timezone-aware datetime")
    normalized = _normalize_time(value, label)
    if value != normalized or value.tzinfo is not UTC or value.fold != 0:
        raise InvariantViolation(f"{label} must be canonical UTC")
    return normalized


def _time_text(value: datetime) -> str:
    return _require_utc_time(value, "authorization timestamp").isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")


def commit_command_hashes_digest(command_hashes: tuple[str, ...]) -> str:
    """Digest an ordered command sequence in the commit capability domain."""

    if type(command_hashes) is not tuple or not command_hashes:
        raise InvariantViolation("commit authorization requires ordered command hashes")
    for command_hash in command_hashes:
        _require_sha256(command_hash, "commit authorization command hash")
    return stable_hash(command_hashes, domain=_COMMANDS_DOMAIN)


@dataclass(frozen=True, slots=True)
class ReleaseApprovalEvidence:
    """Exact server-owned approval snapshot accepted into the issuer registry."""

    approval_id: str
    run_id: str
    kind: str
    subject_digest: str
    approval_digest: str
    principal: str
    decided_at: datetime
    expires_at: datetime | None
    verification_report_hash: str
    verified_preview_digest: str
    commit_gate_passed: bool

    def __post_init__(self) -> None:
        if type(self) is not ReleaseApprovalEvidence:
            raise InvariantViolation("release approval evidence must be the exact concrete type")
        _require_id(self.approval_id, "release approval ID")
        _require_id(self.run_id, "release approval run ID")
        if _require_id(self.kind, "release approval kind") != "release":
            raise InvariantViolation("commit authority accepts release approvals only")
        _require_sha256(self.subject_digest, "release approval subject digest")
        _require_sha256(self.approval_digest, "release approval digest")
        _require_id(self.principal, "release approval principal")
        _require_utc_time(self.decided_at, "release approval decision time")
        if self.expires_at is not None:
            expiry = _require_utc_time(self.expires_at, "release approval expiry")
            if expiry <= self.decided_at:
                raise InvariantViolation("release approval expiry must follow its decision")
        _require_sha256(
            self.verification_report_hash,
            "release approval verification report hash",
        )
        _require_sha256(
            self.verified_preview_digest,
            "release approval verified preview digest",
        )
        if not _require_bool(self.commit_gate_passed, "release approval commit gate"):
            raise InvariantViolation("release approval requires a passing commit gate")


@dataclass(frozen=True, slots=True)
class _ReleaseApprovalSnapshot:
    """Issuer-private copy; no caller-owned approval object enters authority state."""

    approval_id: str
    run_id: str
    kind: str
    subject_digest: str
    approval_digest: str
    principal: str
    decided_at: datetime
    expires_at: datetime | None
    verification_report_hash: str
    verified_preview_digest: str
    commit_gate_passed: bool

    def __post_init__(self) -> None:
        if type(self) is not _ReleaseApprovalSnapshot:
            raise InvalidCommitAuthorization("registered approval snapshot type is invalid")
        # Reuse the public record's exact-value validation without retaining or
        # exposing that public object.
        ReleaseApprovalEvidence(
            approval_id=self.approval_id,
            run_id=self.run_id,
            kind=self.kind,
            subject_digest=self.subject_digest,
            approval_digest=self.approval_digest,
            principal=self.principal,
            decided_at=self.decided_at,
            expires_at=self.expires_at,
            verification_report_hash=self.verification_report_hash,
            verified_preview_digest=self.verified_preview_digest,
            commit_gate_passed=self.commit_gate_passed,
        )

    def public_copy(self) -> ReleaseApprovalEvidence:
        return ReleaseApprovalEvidence(
            approval_id=self.approval_id,
            run_id=self.run_id,
            kind=self.kind,
            subject_digest=self.subject_digest,
            approval_digest=self.approval_digest,
            principal=self.principal,
            decided_at=self.decided_at,
            expires_at=self.expires_at,
            verification_report_hash=self.verification_report_hash,
            verified_preview_digest=self.verified_preview_digest,
            commit_gate_passed=self.commit_gate_passed,
        )


def _snapshot_release_approval(
    approval: ReleaseApprovalEvidence,
) -> _ReleaseApprovalSnapshot:
    if type(approval) is not ReleaseApprovalEvidence:
        raise InvalidCommitAuthorization(
            "release registry requires exact ReleaseApprovalEvidence"
        )
    try:
        return _ReleaseApprovalSnapshot(
            approval_id=approval.approval_id,
            run_id=approval.run_id,
            kind=approval.kind,
            subject_digest=approval.subject_digest,
            approval_digest=approval.approval_digest,
            principal=approval.principal,
            decided_at=approval.decided_at,
            expires_at=approval.expires_at,
            verification_report_hash=approval.verification_report_hash,
            verified_preview_digest=approval.verified_preview_digest,
            commit_gate_passed=approval.commit_gate_passed,
        )
    except (AttributeError, InvariantViolation, TypeError, ValueError) as exc:
        raise InvalidCommitAuthorization(
            "release approval values are missing or not canonical"
        ) from exc


def _copy_release_approval(
    approval: _ReleaseApprovalSnapshot,
) -> _ReleaseApprovalSnapshot:
    return _ReleaseApprovalSnapshot(
        approval_id=approval.approval_id,
        run_id=approval.run_id,
        kind=approval.kind,
        subject_digest=approval.subject_digest,
        approval_digest=approval.approval_digest,
        principal=approval.principal,
        decided_at=approval.decided_at,
        expires_at=approval.expires_at,
        verification_report_hash=approval.verification_report_hash,
        verified_preview_digest=approval.verified_preview_digest,
        commit_gate_passed=approval.commit_gate_passed,
    )


def _authorization_payload(
    *,
    scope: str,
    version: int,
    key_id: str,
    project_id: str,
    base_revision: str,
    head_revision: str,
    transaction_id: str,
    command_hashes: tuple[str, ...],
    command_hashes_digest: str,
    preview_digest: str,
    prospective_graph_sha256: str,
    verification_report_hash: str,
    verified_preview_digest: str,
    commit_gate_passed: bool,
    release_subject_digest: str,
    human_approval_id: str,
    human_approval_run_id: str,
    human_approval_kind: str,
    human_approval_digest: str,
    human_approval_principal: str,
    human_approval_decided_at: datetime,
    human_approval_expires_at: datetime | None,
    issued_at: datetime,
    expires_at: datetime,
    nonce: str,
) -> dict[str, object]:
    return {
        "scope": scope,
        "version": version,
        "key_id": key_id,
        "project_id": project_id,
        "base_revision": base_revision,
        "head_revision": head_revision,
        "transaction_id": transaction_id,
        "command_hashes": command_hashes,
        "command_hashes_digest": command_hashes_digest,
        "preview_digest": preview_digest,
        "prospective_graph_sha256": prospective_graph_sha256,
        "verification_report_hash": verification_report_hash,
        "verified_preview_digest": verified_preview_digest,
        "commit_gate_passed": commit_gate_passed,
        "release_subject_digest": release_subject_digest,
        "human_approval_id": human_approval_id,
        "human_approval_run_id": human_approval_run_id,
        "human_approval_kind": human_approval_kind,
        "human_approval_digest": human_approval_digest,
        "human_approval_principal": human_approval_principal,
        "human_approval_decided_at": _time_text(human_approval_decided_at),
        "human_approval_expires_at": (
            _time_text(human_approval_expires_at)
            if human_approval_expires_at is not None
            else None
        ),
        "issued_at": _time_text(issued_at),
        "expires_at": _time_text(expires_at),
        "nonce": nonce,
    }


@dataclass(frozen=True, slots=True)
class CommitAuthorization:
    """Sealed caller-visible authority for one exact canonical transaction."""

    scope: str
    version: int
    key_id: str
    authorization_id: str
    project_id: str
    base_revision: str
    head_revision: str
    transaction_id: str
    command_hashes: tuple[str, ...]
    command_hashes_digest: str
    preview_digest: str
    prospective_graph_sha256: str
    verification_report_hash: str
    verified_preview_digest: str
    commit_gate_passed: bool
    release_subject_digest: str
    human_approval_id: str
    human_approval_run_id: str
    human_approval_kind: str
    human_approval_digest: str
    human_approval_principal: str
    human_approval_decided_at: datetime
    human_approval_expires_at: datetime | None
    issued_at: datetime
    expires_at: datetime
    nonce: str
    authorization_digest: str
    seal: str

    def __post_init__(self) -> None:
        if type(self) is not CommitAuthorization:
            raise InvariantViolation("commit authorization must be the exact concrete type")
        _validate_authorization_values(self)
        expected_digest = stable_hash(
            _payload_from_authorization(self),
            domain=_AUTHORIZATION_DOMAIN,
        )
        if not hmac.compare_digest(expected_digest, self.authorization_digest):
            raise InvariantViolation("commit authorization digest is inconsistent")
        if self.authorization_id != f"{_AUTHORIZATION_ID_PREFIX}{expected_digest[:32]}":
            raise InvariantViolation("commit authorization ID does not derive from its digest")

    def claims_payload(self) -> dict[str, object]:
        """Return a copy for diagnostics; verification never dispatches this method."""

        return _payload_from_authorization(self)


@dataclass(frozen=True, slots=True)
class CommitAuthorizationClaims:
    """Canonical exact-builtins snapshot authenticated by the verifier."""

    scope: str
    version: int
    key_id: str
    authorization_id: str
    project_id: str
    base_revision: str
    head_revision: str
    transaction_id: str
    command_hashes: tuple[str, ...]
    command_hashes_digest: str
    preview_digest: str
    prospective_graph_sha256: str
    verification_report_hash: str
    verified_preview_digest: str
    commit_gate_passed: bool
    release_subject_digest: str
    human_approval_id: str
    human_approval_run_id: str
    human_approval_kind: str
    human_approval_digest: str
    human_approval_principal: str
    human_approval_decided_at: datetime
    human_approval_expires_at: datetime | None
    issued_at: datetime
    expires_at: datetime
    nonce: str
    authorization_digest: str
    seal: str = field(repr=False)

    def __post_init__(self) -> None:
        if type(self) is not CommitAuthorizationClaims:
            raise InvariantViolation("commit claims must be the exact concrete type")
        _validate_authorization_values(self)


def _validate_authorization_values(
    authorization: CommitAuthorization | CommitAuthorizationClaims,
) -> None:
    _require_id(authorization.scope, "commit authorization scope")
    if type(authorization.version) is not int or authorization.version < 1:
        raise InvariantViolation("commit authorization version must be a positive exact integer")
    for value, label in (
        (authorization.key_id, "commit authorization key ID"),
        (authorization.authorization_id, "commit authorization ID"),
        (authorization.project_id, "commit authorization project ID"),
        (authorization.transaction_id, "commit authorization transaction ID"),
        (authorization.human_approval_id, "commit authorization human approval ID"),
        (authorization.human_approval_run_id, "commit authorization approval run ID"),
        (authorization.human_approval_kind, "commit authorization approval kind"),
        (authorization.human_approval_principal, "commit authorization human principal"),
    ):
        _require_id(value, label)
    for value, label in (
        (authorization.base_revision, "commit authorization base revision"),
        (authorization.head_revision, "commit authorization head revision"),
        (authorization.command_hashes_digest, "commit authorization command digest"),
        (authorization.preview_digest, "commit authorization preview digest"),
        (
            authorization.prospective_graph_sha256,
            "commit authorization prospective graph digest",
        ),
        (
            authorization.verification_report_hash,
            "commit authorization verification report hash",
        ),
        (
            authorization.verified_preview_digest,
            "commit authorization verified preview digest",
        ),
        (
            authorization.release_subject_digest,
            "commit authorization release subject digest",
        ),
        (
            authorization.human_approval_digest,
            "commit authorization human approval digest",
        ),
        (authorization.nonce, "commit authorization nonce"),
        (authorization.authorization_digest, "commit authorization digest"),
        (authorization.seal, "commit authorization seal"),
    ):
        _require_sha256(value, label)
    if not _require_bool(authorization.commit_gate_passed, "commit authorization gate"):
        raise InvariantViolation("commit authorization requires a passing gate")
    decided_at = _require_utc_time(
        authorization.human_approval_decided_at,
        "commit authorization approval decision time",
    )
    if authorization.human_approval_expires_at is not None:
        approval_expiry = _require_utc_time(
            authorization.human_approval_expires_at,
            "commit authorization approval expiry",
        )
        if approval_expiry <= decided_at:
            raise InvariantViolation("commit authorization approval expiry is invalid")
    issued_at = _require_utc_time(
        authorization.issued_at,
        "commit authorization issue time",
    )
    expires_at = _require_utc_time(
        authorization.expires_at,
        "commit authorization expiry",
    )
    if issued_at >= expires_at:
        raise InvariantViolation("commit authorization must expire after it is issued")
    expected_commands_digest = commit_command_hashes_digest(authorization.command_hashes)
    if not hmac.compare_digest(expected_commands_digest, authorization.command_hashes_digest):
        raise InvariantViolation("commit authorization ordered command digest is inconsistent")


def _payload_from_authorization(
    authorization: CommitAuthorization | CommitAuthorizationClaims,
) -> dict[str, object]:
    return _authorization_payload(
        scope=authorization.scope,
        version=authorization.version,
        key_id=authorization.key_id,
        project_id=authorization.project_id,
        base_revision=authorization.base_revision,
        head_revision=authorization.head_revision,
        transaction_id=authorization.transaction_id,
        command_hashes=authorization.command_hashes,
        command_hashes_digest=authorization.command_hashes_digest,
        preview_digest=authorization.preview_digest,
        prospective_graph_sha256=authorization.prospective_graph_sha256,
        verification_report_hash=authorization.verification_report_hash,
        verified_preview_digest=authorization.verified_preview_digest,
        commit_gate_passed=authorization.commit_gate_passed,
        release_subject_digest=authorization.release_subject_digest,
        human_approval_id=authorization.human_approval_id,
        human_approval_run_id=authorization.human_approval_run_id,
        human_approval_kind=authorization.human_approval_kind,
        human_approval_digest=authorization.human_approval_digest,
        human_approval_principal=authorization.human_approval_principal,
        human_approval_decided_at=authorization.human_approval_decided_at,
        human_approval_expires_at=authorization.human_approval_expires_at,
        issued_at=authorization.issued_at,
        expires_at=authorization.expires_at,
        nonce=authorization.nonce,
    )


def _snapshot_authorization(authorization: CommitAuthorization) -> CommitAuthorizationClaims:
    if type(authorization) is not CommitAuthorization:
        raise InvalidCommitAuthorization(
            "commit requires the exact CommitAuthorization capability type"
        )
    try:
        _validate_authorization_values(authorization)
        return CommitAuthorizationClaims(
            scope=str(authorization.scope),
            version=int(authorization.version),
            key_id=str(authorization.key_id),
            authorization_id=str(authorization.authorization_id),
            project_id=str(authorization.project_id),
            base_revision=str(authorization.base_revision),
            head_revision=str(authorization.head_revision),
            transaction_id=str(authorization.transaction_id),
            command_hashes=tuple(str(value) for value in authorization.command_hashes),
            command_hashes_digest=str(authorization.command_hashes_digest),
            preview_digest=str(authorization.preview_digest),
            prospective_graph_sha256=str(authorization.prospective_graph_sha256),
            verification_report_hash=str(authorization.verification_report_hash),
            verified_preview_digest=str(authorization.verified_preview_digest),
            commit_gate_passed=bool(authorization.commit_gate_passed),
            release_subject_digest=str(authorization.release_subject_digest),
            human_approval_id=str(authorization.human_approval_id),
            human_approval_run_id=str(authorization.human_approval_run_id),
            human_approval_kind=str(authorization.human_approval_kind),
            human_approval_digest=str(authorization.human_approval_digest),
            human_approval_principal=str(authorization.human_approval_principal),
            human_approval_decided_at=_require_utc_time(
                authorization.human_approval_decided_at,
                "commit authorization approval decision time",
            ),
            human_approval_expires_at=(
                _require_utc_time(
                    authorization.human_approval_expires_at,
                    "commit authorization approval expiry",
                )
                if authorization.human_approval_expires_at is not None
                else None
            ),
            issued_at=_require_utc_time(
                authorization.issued_at,
                "commit authorization issue time",
            ),
            expires_at=_require_utc_time(
                authorization.expires_at,
                "commit authorization expiry",
            ),
            nonce=str(authorization.nonce),
            authorization_digest=str(authorization.authorization_digest),
            seal=str(authorization.seal),
        )
    except (AttributeError, InvariantViolation, TypeError, ValueError) as exc:
        raise InvalidCommitAuthorization("commit authorization values are not canonical") from exc


@dataclass(frozen=True, slots=True)
class _VerifiedCommitClaims:
    claims: CommitAuthorizationClaims
    release_approval: _ReleaseApprovalSnapshot
    verified_at: datetime
    previously_consumed_authorization_digest: str | None
    authority_token: object = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if type(self) is not _VerifiedCommitClaims:
            raise InvalidCommitAuthorization("verified claims must be the exact private type")
        if type(self.claims) is not CommitAuthorizationClaims:
            raise InvalidCommitAuthorization("verified claims are not canonical")
        if type(self.release_approval) is not _ReleaseApprovalSnapshot:
            raise InvalidCommitAuthorization("verified approval is not canonical")
        _require_utc_time(self.verified_at, "commit authorization verification time")
        if self.previously_consumed_authorization_digest is not None:
            _require_sha256(
                self.previously_consumed_authorization_digest,
                "previously consumed commit authorization digest",
            )


@dataclass(frozen=True, slots=True)
class ConsumedCommitAuthorization:
    """Canonical evidence that the live verifier atomically consumed a capability."""

    claims: CommitAuthorizationClaims
    release_approval: ReleaseApprovalEvidence
    consumed_at: datetime

    def __post_init__(self) -> None:
        if type(self) is not ConsumedCommitAuthorization:
            raise InvariantViolation("consumed authorization must be the exact concrete type")
        if type(self.claims) is not CommitAuthorizationClaims:
            raise InvariantViolation("consumed authorization claims are not canonical")
        if type(self.release_approval) is not ReleaseApprovalEvidence:
            raise InvariantViolation("consumed release approval is not canonical")
        _require_utc_time(self.consumed_at, "commit authorization consumption time")


@dataclass(frozen=True, slots=True)
class _IssuedRecord:
    approval: _ReleaseApprovalSnapshot


class _AuthorityState:
    def __init__(
        self,
        *,
        key_id: str,
        secret: bytes,
        required_release_principal: str,
        clock: Callable[[], datetime],
    ) -> None:
        self.key_id = key_id
        self.secret = secret
        self.required_release_principal = required_release_principal
        self.clock = clock
        self.approvals: dict[str, _ReleaseApprovalSnapshot] = {}
        # An approval identifier is one-incarnation, one-shot registry state.
        # Revocation leaves a permanent tombstone and registration itself is
        # never idempotently reusable, even for byte-identical evidence.
        self.approval_ids_seen: set[str] = set()
        self.issued: dict[str, _IssuedRecord] = {}
        self.consumed: dict[str, str] = {}
        self.last_observed_at: datetime | None = None
        self.clock_poisoned = False
        self.token = object()
        self.lock = RLock()

    def observe_now_locked(self) -> datetime:
        if self.clock_poisoned:
            raise CommitAuthorityClockRollback(
                "commit authority clock previously moved backwards"
            )
        try:
            current = _normalize_time(self.clock(), "commit authority current time")
        except InvariantViolation as exc:
            raise InvalidCommitAuthorization("commit authority clock is invalid") from exc
        previous = self.last_observed_at
        if previous is not None and current < previous:
            self.clock_poisoned = True
            raise CommitAuthorityClockRollback("commit authority clock moved backwards")
        self.last_observed_at = current
        return current


class HmacCommitVerifier:
    """Verifier/consumer view; deliberately has no issuance or registry API."""

    __slots__ = ("__state", "__token")

    def __init__(self, state: _AuthorityState, token: object) -> None:
        if type(state) is not _AuthorityState or token is not state.token:
            raise InvalidCommitAuthorization("commit verifier must come from its issuer")
        self.__state = state
        self.__token = token

    @property
    def key_id(self) -> str:
        return self.__state.key_id

    def verify(self, authorization: CommitAuthorization) -> _VerifiedCommitClaims:
        claims = _snapshot_authorization(authorization)
        state = self.__state
        with state.lock:
            return self._verify_locked(claims, now=state.observe_now_locked())

    def consume(self, verified: _VerifiedCommitClaims) -> ConsumedCommitAuthorization:
        if type(verified) is not _VerifiedCommitClaims:
            raise InvalidCommitAuthorization("commit requires exact private verified claims")
        if verified.authority_token is not self.__token:
            raise InvalidCommitAuthorization("commit claims were verified by another issuer")
        state = self.__state
        with state.lock:
            try:
                current = self._verify_locked(
                    verified.claims,
                    now=state.observe_now_locked(),
                )
            except (AttributeError, InvariantViolation, TypeError, ValueError) as exc:
                raise InvalidCommitAuthorization(
                    "verified commit claims are missing or not canonical"
                ) from exc
            if current.previously_consumed_authorization_digest is not None:
                raise ReplayedCommitAuthorization(
                    "commit authorization nonce has already been consumed"
                )
            claims = current.claims
            state.consumed[claims.nonce] = claims.authorization_digest
            return ConsumedCommitAuthorization(
                claims=claims,
                release_approval=current.release_approval.public_copy(),
                consumed_at=current.verified_at,
            )

    def _verify_locked(
        self,
        claims: CommitAuthorizationClaims,
        *,
        now: datetime,
    ) -> _VerifiedCommitClaims:
        state = self.__state
        if (
            claims.scope != COMMIT_AUTHORIZATION_SCOPE
            or claims.version != COMMIT_AUTHORIZATION_VERSION
            or claims.key_id != state.key_id
        ):
            raise InvalidCommitAuthorization(
                "commit authorization scope, version, or key ID is not trusted"
            )
        payload = _payload_from_authorization(claims)
        expected_digest = stable_hash(payload, domain=_AUTHORIZATION_DOMAIN)
        if not hmac.compare_digest(expected_digest, claims.authorization_digest):
            raise InvalidCommitAuthorization("commit authorization digest is invalid")
        expected_id = f"{_AUTHORIZATION_ID_PREFIX}{expected_digest[:32]}"
        if not hmac.compare_digest(expected_id, claims.authorization_id):
            raise InvalidCommitAuthorization("commit authorization ID is invalid")
        expected_seal = _seal(
            state.secret,
            authorization_id=claims.authorization_id,
            authorization_digest=claims.authorization_digest,
            claims_payload=payload,
        )
        if not hmac.compare_digest(expected_seal, claims.seal):
            raise InvalidCommitAuthorization("commit authorization seal is invalid")
        if now < claims.issued_at:
            raise ExpiredCommitAuthorization("commit authorization issue time is in the future")
        if now >= claims.expires_at:
            raise ExpiredCommitAuthorization("commit authorization has expired")
        issued = state.issued.get(claims.authorization_digest)
        if issued is None:
            raise InvalidCommitAuthorization(
                "commit authorization is not present in this issuer incarnation"
            )
        approval = state.approvals.get(issued.approval.approval_id)
        if approval is None:
            raise InvalidCommitAuthorization("commit release approval was revoked or is unknown")
        if approval != issued.approval:
            raise InvalidCommitAuthorization(
                "commit release approval no longer has its issued registry incarnation"
            )
        _match_registered_approval(claims, approval, issued, now=now)
        return _VerifiedCommitClaims(
            claims=claims,
            release_approval=_copy_release_approval(approval),
            verified_at=now,
            previously_consumed_authorization_digest=state.consumed.get(claims.nonce),
            authority_token=self.__token,
        )


class HmacCommitAuthority:
    """Process-local approval registry and issuer with a verifier-only kernel view."""

    def __init__(
        self,
        *,
        key_id: str,
        secret: bytes,
        required_release_principal: str = "user:owner",
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        _require_id(key_id, "commit authority key ID")
        _require_id(required_release_principal, "required release principal")
        if type(secret) is not bytes or len(secret) < 32:
            raise ValueError("commit authority secret must contain at least 32 exact bytes")
        if clock is not None and not callable(clock):
            raise ValueError("commit authority clock must be callable")
        state = _AuthorityState(
            key_id=key_id,
            secret=bytes(secret),
            required_release_principal=required_release_principal,
            clock=clock or (lambda: datetime.now(UTC)),
        )
        self.__state = state
        self.__verifier = HmacCommitVerifier(state, state.token)

    @property
    def key_id(self) -> str:
        return self.__state.key_id

    @property
    def verifier(self) -> HmacCommitVerifier:
        return self.__verifier

    def register_release_approval(
        self,
        approval: ReleaseApprovalEvidence,
    ) -> ReleaseApprovalEvidence:
        snapshot = _snapshot_release_approval(approval)
        state = self.__state
        with state.lock:
            now = state.observe_now_locked()
            if snapshot.approval_id in state.approval_ids_seen:
                raise InvalidCommitAuthorization(
                    "release approval ID is permanently bound or revoked"
                )
            if snapshot.principal != state.required_release_principal:
                raise InvalidCommitAuthorization(
                    "release approval principal is not authorized to commit"
                )
            if snapshot.decided_at > now:
                raise InvalidCommitAuthorization("release approval decision is in the future")
            if snapshot.expires_at is not None and now >= snapshot.expires_at:
                raise ExpiredCommitAuthorization("release approval has expired")
            state.approval_ids_seen.add(snapshot.approval_id)
            state.approvals[snapshot.approval_id] = snapshot
            return snapshot.public_copy()

    def revoke_release_approval(self, approval_id: str) -> None:
        _require_id(approval_id, "release approval ID")
        state = self.__state
        with state.lock:
            state.observe_now_locked()
            state.approval_ids_seen.add(approval_id)
            state.approvals.pop(approval_id, None)

    def issue(
        self,
        *,
        project_id: str,
        base_revision: str,
        head_revision: str,
        transaction_id: str,
        command_hashes: tuple[str, ...],
        preview_digest: str,
        prospective_graph_sha256: str,
        approval_id: str,
        lifetime: timedelta = timedelta(seconds=30),
        nonce: str | None = None,
    ) -> CommitAuthorization:
        if type(lifetime) is not timedelta or lifetime <= timedelta(0):
            raise ValueError("commit authorization lifetime must be a positive exact timedelta")
        if lifetime > timedelta(seconds=30):
            raise ValueError("commit authorization lifetime cannot exceed 30 seconds")
        state = self.__state
        with state.lock:
            now = state.observe_now_locked()
            approval = state.approvals.get(_require_id(approval_id, "release approval ID"))
            if approval is None:
                raise InvalidCommitAuthorization("release approval is not registered")
            expected_subject = stable_hash(
                {
                    "base_revision": base_revision,
                    "preview_digest": preview_digest,
                    "report_hash": approval.verification_report_hash,
                },
                domain="flux-clone-release-v1",
            )
            if not hmac.compare_digest(approval.subject_digest, expected_subject):
                raise InvalidCommitAuthorization(
                    "registered release approval does not bind the exact commit subject"
                )
            if not hmac.compare_digest(approval.verified_preview_digest, preview_digest):
                raise InvalidCommitAuthorization(
                    "registered release approval does not bind the exact verified preview"
                )
            if approval.expires_at is not None and now >= approval.expires_at:
                raise ExpiredCommitAuthorization("release approval has expired")
            expiry = now + lifetime
            if approval.expires_at is not None:
                expiry = min(expiry, approval.expires_at)
            command_digest = commit_command_hashes_digest(command_hashes)
            nonce_value = nonce if nonce is not None else secrets.token_hex(32)
            _require_sha256(nonce_value, "commit authorization nonce")
            payload = _authorization_payload(
                scope=COMMIT_AUTHORIZATION_SCOPE,
                version=COMMIT_AUTHORIZATION_VERSION,
                key_id=state.key_id,
                project_id=project_id,
                base_revision=base_revision,
                head_revision=head_revision,
                transaction_id=transaction_id,
                command_hashes=command_hashes,
                command_hashes_digest=command_digest,
                preview_digest=preview_digest,
                prospective_graph_sha256=prospective_graph_sha256,
                verification_report_hash=approval.verification_report_hash,
                verified_preview_digest=approval.verified_preview_digest,
                commit_gate_passed=approval.commit_gate_passed,
                release_subject_digest=approval.subject_digest,
                human_approval_id=approval.approval_id,
                human_approval_run_id=approval.run_id,
                human_approval_kind=approval.kind,
                human_approval_digest=approval.approval_digest,
                human_approval_principal=approval.principal,
                human_approval_decided_at=approval.decided_at,
                human_approval_expires_at=approval.expires_at,
                issued_at=now,
                expires_at=expiry,
                nonce=nonce_value,
            )
            authorization_digest = stable_hash(payload, domain=_AUTHORIZATION_DOMAIN)
            authorization_id = f"{_AUTHORIZATION_ID_PREFIX}{authorization_digest[:32]}"
            seal = _seal(
                state.secret,
                authorization_id=authorization_id,
                authorization_digest=authorization_digest,
                claims_payload=payload,
            )
            authorization = CommitAuthorization(
                scope=COMMIT_AUTHORIZATION_SCOPE,
                version=COMMIT_AUTHORIZATION_VERSION,
                key_id=state.key_id,
                authorization_id=authorization_id,
                project_id=project_id,
                base_revision=base_revision,
                head_revision=head_revision,
                transaction_id=transaction_id,
                command_hashes=command_hashes,
                command_hashes_digest=command_digest,
                preview_digest=preview_digest,
                prospective_graph_sha256=prospective_graph_sha256,
                verification_report_hash=approval.verification_report_hash,
                verified_preview_digest=approval.verified_preview_digest,
                commit_gate_passed=approval.commit_gate_passed,
                release_subject_digest=approval.subject_digest,
                human_approval_id=approval.approval_id,
                human_approval_run_id=approval.run_id,
                human_approval_kind=approval.kind,
                human_approval_digest=approval.approval_digest,
                human_approval_principal=approval.principal,
                human_approval_decided_at=approval.decided_at,
                human_approval_expires_at=approval.expires_at,
                issued_at=now,
                expires_at=expiry,
                nonce=nonce_value,
                authorization_digest=authorization_digest,
                seal=seal,
            )
            record = _IssuedRecord(_copy_release_approval(approval))
            existing = state.issued.get(authorization_digest)
            if existing is not None and existing != record:
                raise InvalidCommitAuthorization(
                    "authorization digest collides with different approval evidence"
                )
            state.issued[authorization_digest] = record
            return authorization


def _match_registered_approval(
    claims: CommitAuthorizationClaims,
    approval: _ReleaseApprovalSnapshot,
    issued: _IssuedRecord,
    *,
    now: datetime,
) -> None:
    matches = (
        claims.human_approval_id
        == approval.approval_id
        == issued.approval.approval_id,
        claims.human_approval_run_id == approval.run_id,
        claims.human_approval_kind == approval.kind == "release",
        hmac.compare_digest(claims.human_approval_digest, approval.approval_digest),
        hmac.compare_digest(
            issued.approval.approval_digest,
            approval.approval_digest,
        ),
        claims.human_approval_principal == approval.principal,
        claims.human_approval_decided_at == approval.decided_at,
        claims.human_approval_expires_at == approval.expires_at,
        hmac.compare_digest(
            claims.verification_report_hash,
            approval.verification_report_hash,
        ),
        hmac.compare_digest(
            claims.verified_preview_digest,
            approval.verified_preview_digest,
        ),
        hmac.compare_digest(claims.release_subject_digest, approval.subject_digest),
        claims.commit_gate_passed is approval.commit_gate_passed is True,
    )
    if not all(matches):
        raise InvalidCommitAuthorization(
            "commit authorization no longer matches its server-owned release approval"
        )
    if approval.expires_at is not None and now >= approval.expires_at:
        raise ExpiredCommitAuthorization("registered release approval has expired")
    if approval.expires_at is not None and claims.expires_at > approval.expires_at:
        raise InvalidCommitAuthorization(
            "commit authorization outlives its registered release approval"
        )


def _seal(
    secret: bytes,
    *,
    authorization_id: str,
    authorization_digest: str,
    claims_payload: dict[str, object],
) -> str:
    message = _SEAL_DOMAIN + canonical_json(
        {
            "authorization_id": authorization_id,
            "authorization_digest": authorization_digest,
            "claims": claims_payload,
        }
    ).encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


__all__ = (
    "COMMIT_AUTHORIZATION_SCOPE",
    "COMMIT_AUTHORIZATION_VERSION",
    "CommitAuthorization",
    "CommitAuthorizationClaims",
    "CommitAuthorizationError",
    "CommitAuthorityClockRollback",
    "ConsumedCommitAuthorization",
    "ExpiredCommitAuthorization",
    "HmacCommitAuthority",
    "HmacCommitVerifier",
    "InvalidCommitAuthorization",
    "ReleaseApprovalEvidence",
    "ReplayedCommitAuthorization",
    "commit_command_hashes_digest",
)
