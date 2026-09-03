"""External-key Ed25519 attestations for durable canonical commits."""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from datetime import UTC, datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from backend.design_kernel import (
    ConsumedCommitAuthorization,
    DesignRevision,
    DesignTransaction,
    TransactionState,
    commit_command_hashes_digest,
    stable_hash,
)
from backend.design_kernel.model import canonical_json

from .models import (
    ApprovalDecision,
    ApprovalEvidence,
    DurableCommitAttestation,
    IntegrityError,
)

_SIGNATURE_DOMAIN = b"flux-clone-durable-commit-attestation-v1\0"


def _id(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or any(character.isspace() for character in value)
        or any(unicodedata.category(character).startswith("C") for character in value)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ValueError(
            f"{label} must be an exact whitespace-free, control-free NFC identifier"
        )
    return value


def _digest(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be an exact lowercase SHA-256 digest")
    return value


def _utc(value: datetime, label: str) -> datetime:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} must be an exact timezone-aware datetime")
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


def _time_text(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _utc(value, "attestation timestamp").isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")


def attestation_unsigned_payload(
    attestation: DurableCommitAttestation,
) -> dict[str, object]:
    """Build the one non-virtual signed representation of an attestation."""

    if type(attestation) is not DurableCommitAttestation:
        raise IntegrityError("durable attestation must be the exact concrete type")
    values = {
        name: getattr(attestation, name)
        for name in attestation.__dataclass_fields__
        if name != "signature"
    }
    return _unsigned_payload_from_values(values)


def _signature_message(payload: Mapping[str, object]) -> bytes:
    return _SIGNATURE_DOMAIN + canonical_json(dict(payload)).encode("utf-8")


class Ed25519CommitAttestationSigner:
    """Private-key signer held by the application, never by repository restore."""

    __slots__ = ("__key_id", "__private_key")

    def __init__(self, *, key_id: str, private_key: Ed25519PrivateKey) -> None:
        self.__key_id = _id(key_id, "attestation signing key ID")
        if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
            private_key, Ed25519PrivateKey
        ):
            raise ValueError("attestation signer requires an Ed25519 private key")
        self.__private_key = private_key

    @classmethod
    def generate(cls, *, key_id: str) -> Ed25519CommitAttestationSigner:
        return cls(key_id=key_id, private_key=Ed25519PrivateKey.generate())

    @classmethod
    def from_private_bytes(
        cls,
        *,
        key_id: str,
        private_key: bytes,
    ) -> Ed25519CommitAttestationSigner:
        if type(private_key) is not bytes or len(private_key) != 32:
            raise ValueError("Ed25519 private key must be exactly 32 bytes")
        return cls(
            key_id=key_id,
            private_key=Ed25519PrivateKey.from_private_bytes(private_key),
        )

    @property
    def key_id(self) -> str:
        return self.__key_id

    def private_key_bytes(self) -> bytes:
        """Export for an external key provider; never persist this in SQLite."""

        return self.__private_key.private_bytes_raw()

    def public_key_bytes(self) -> bytes:
        return self.__private_key.public_key().public_bytes_raw()

    def sign_commit(
        self,
        *,
        revision: DesignRevision,
        transaction: DesignTransaction,
        approval: ApprovalEvidence,
        authorization: ConsumedCommitAuthorization,
        verification_input_hash: str,
        verification_rule_set_hash: str,
    ) -> DurableCommitAttestation:
        if type(revision) is not DesignRevision:
            raise ValueError("attestation revision must be the exact DesignRevision type")
        if type(transaction) is not DesignTransaction:
            raise ValueError("attestation transaction must be exact DesignTransaction")
        if type(approval) is not ApprovalEvidence:
            raise ValueError("attestation approval must be exact ApprovalEvidence")
        if type(authorization) is not ConsumedCommitAuthorization:
            raise ValueError("attestation authorization must be exact consumed evidence")
        _digest(verification_input_hash, "verification input hash")
        _digest(verification_rule_set_hash, "verification rule-set hash")
        if transaction.state is not TransactionState.COMMITTED:
            raise ValueError("durable attestation requires a committed transaction")
        if approval.decision is not ApprovalDecision.APPROVED:
            raise ValueError("durable attestation requires approved evidence")
        claims = authorization.claims
        release = authorization.release_approval
        command_hashes = tuple(command.command_hash for command in transaction.commands)
        values: dict[str, object] = {
            "schema_version": 1,
            "scope": "canonical-design-durable-commit",
            "algorithm": "ed25519",
            "attestation_key_id": self.__key_id,
            "project_id": revision.graph.project_id,
            "base_revision": transaction.base_revision,
            "head_revision": transaction.base_revision,
            "parent_revision": revision.parent_revision,
            "revision_hash": revision.revision_hash,
            "sequence": revision.sequence,
            "transaction_id": transaction.transaction_id,
            "command_hashes": command_hashes,
            "command_hashes_digest": commit_command_hashes_digest(command_hashes),
            "preview_digest": transaction.preview_digest,
            "verified_preview_digest": transaction.verification_preview_digest,
            "prospective_graph_sha256": transaction.staged_graph.graph_hash,
            "verification_report_hash": transaction.verification_report_hash,
            "verification_input_hash": verification_input_hash,
            "verification_rule_set_hash": verification_rule_set_hash,
            "commit_gate_passed": transaction.commit_gate_passed,
            "release_subject_digest": approval.release_subject_digest,
            "approval_id": approval.approval_id,
            "approval_run_id": release.run_id,
            "approval_kind": release.kind,
            "approval_digest": approval.approval_digest,
            "approval_principal": approval.actor,
            "approval_decided_at": _utc(approval.decided_at, "approval decision time"),
            "approval_expires_at": release.expires_at,
            "authorization_key_id": claims.key_id,
            "authorization_id": claims.authorization_id,
            "authorization_digest": claims.authorization_digest,
            "authorization_nonce": claims.nonce,
            "authorization_issued_at": claims.issued_at,
            "authorization_expires_at": claims.expires_at,
            "authorization_consumed_at": authorization.consumed_at,
        }
        _validate_cross_bindings(values, revision, transaction, approval, authorization)
        unsigned = _unsigned_payload_from_values(values)
        signature = self.__private_key.sign(_signature_message(unsigned)).hex()
        return DurableCommitAttestation(**values, signature=signature)  # type: ignore[arg-type]


class Ed25519CommitAttestationKeyring:
    """External public-key verifier injected into SQLiteProjectStore."""

    __slots__ = ("__keys",)

    def __init__(self, public_keys: Mapping[str, bytes]) -> None:
        if (
            not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
                public_keys, Mapping
            )
            or not public_keys
        ):
            raise ValueError("attestation keyring requires at least one public key")
        keys: dict[str, Ed25519PublicKey] = {}
        encoded_keys: dict[str, bytes] = {}
        for key_id, public_key in public_keys.items():
            _id(key_id, "attestation verification key ID")
            if type(public_key) is not bytes or len(public_key) != 32:
                raise ValueError("Ed25519 public keys must be exact 32-byte values")
            existing = encoded_keys.get(key_id)
            if existing is not None and existing != public_key:
                raise ValueError(
                    f"attestation key ID {key_id!r} has conflicting public keys"
                )
            encoded_keys[key_id] = public_key
            keys[str(key_id)] = Ed25519PublicKey.from_public_bytes(bytes(public_key))
        self.__keys = keys

    @classmethod
    def from_signers(
        cls,
        *signers: Ed25519CommitAttestationSigner,
    ) -> Ed25519CommitAttestationKeyring:
        if not signers or any(
            type(signer) is not Ed25519CommitAttestationSigner for signer in signers
        ):
            raise ValueError("keyring requires exact Ed25519 attestation signers")
        public_keys: dict[str, bytes] = {}
        for signer in signers:
            public_key = signer.public_key_bytes()
            existing = public_keys.get(signer.key_id)
            if existing is not None and existing != public_key:
                raise ValueError(
                    f"attestation key ID {signer.key_id!r} has conflicting public keys"
                )
            public_keys[signer.key_id] = public_key
        return cls(public_keys)

    def verify(self, attestation: DurableCommitAttestation) -> None:
        if type(attestation) is not DurableCommitAttestation:
            raise IntegrityError("durable commit attestation type is not trusted")
        public_key = self.__keys.get(attestation.attestation_key_id)
        if public_key is None:
            raise IntegrityError("durable commit attestation key is not trusted")
        try:
            public_key.verify(
                bytes.fromhex(attestation.signature),
                _signature_message(attestation_unsigned_payload(attestation)),
            )
        except (InvalidSignature, ValueError) as exc:
            raise IntegrityError("durable commit attestation signature is invalid") from exc


def _unsigned_payload_from_values(values: Mapping[str, object]) -> dict[str, object]:
    payload = dict(values)
    for field in (
        "approval_decided_at",
        "approval_expires_at",
        "authorization_issued_at",
        "authorization_expires_at",
        "authorization_consumed_at",
    ):
        value = payload[field]
        if value is not None and type(value) is not datetime:
            raise ValueError(f"{field} is not an exact datetime")
        payload[field] = _time_text(value)
    return payload


def _validate_cross_bindings(
    values: Mapping[str, object],
    revision: DesignRevision,
    transaction: DesignTransaction,
    approval: ApprovalEvidence,
    authorization: ConsumedCommitAuthorization,
) -> None:
    claims = authorization.claims
    release = authorization.release_approval
    expected_release = stable_hash(
        {
            "base_revision": transaction.base_revision,
            "preview_digest": transaction.preview_digest,
            "report_hash": transaction.verification_report_hash,
        },
        domain="flux-clone-release-v1",
    )
    checks = (
        revision.graph.project_id == claims.project_id,
        revision.parent_revision == transaction.base_revision,
        revision.revision_hash == transaction.committed_revision_hash,
        revision.graph == transaction.staged_graph,
        revision.graph_hash == claims.prospective_graph_sha256,
        revision.verification_report_hash == transaction.verification_report_hash,
        revision.approval_preview_digest == transaction.preview_digest,
        transaction.transaction_id == claims.transaction_id,
        transaction.base_revision == claims.base_revision == claims.head_revision,
        tuple(command.command_hash for command in transaction.commands) == claims.command_hashes,
        commit_command_hashes_digest(claims.command_hashes)
        == claims.command_hashes_digest,
        transaction.preview_digest == claims.preview_digest == claims.verified_preview_digest,
        transaction.verification_report_hash == claims.verification_report_hash,
        transaction.commit_gate_passed is claims.commit_gate_passed is True,
        expected_release == claims.release_subject_digest == approval.release_subject_digest,
        approval.approval_id == claims.human_approval_id == release.approval_id,
        release.run_id == claims.human_approval_run_id,
        release.kind == claims.human_approval_kind == "release",
        approval.approval_digest == claims.human_approval_digest == release.approval_digest,
        approval.actor == claims.human_approval_principal == release.principal,
        approval.decided_at == claims.human_approval_decided_at == release.decided_at,
        release.expires_at == claims.human_approval_expires_at,
        approval.verification_report_hash == claims.verification_report_hash,
        approval.preview_digest == claims.preview_digest,
        release.verification_report_hash == claims.verification_report_hash,
        release.verified_preview_digest == claims.verified_preview_digest,
        release.subject_digest == claims.release_subject_digest,
        release.commit_gate_passed is claims.commit_gate_passed is True,
        values["approval_run_id"] == release.run_id,
    )
    if not all(checks):
        raise ValueError("durable attestation inputs do not reproduce one exact commit")


__all__ = (
    "Ed25519CommitAttestationKeyring",
    "Ed25519CommitAttestationSigner",
    "attestation_unsigned_payload",
)
