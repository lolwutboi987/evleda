"""Typed records and stable failures for managed interchange artifacts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import hashlib
import re
from typing import ClassVar


MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_ARTIFACT_ID = re.compile(r"artifact_[0-9a-f]{32}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


class ArtifactStoreError(RuntimeError):
    """Base failure with an application-stable error code."""

    code: ClassVar[str] = "artifact_store_error"


class InvalidArtifactRequest(ArtifactStoreError):
    code = "invalid_request"


class ArtifactTooLarge(ArtifactStoreError):
    code = "upload_too_large"


class UnsupportedArtifactMediaType(ArtifactStoreError):
    code = "unsupported_media_type"


class ArtifactDigestMismatch(ArtifactStoreError):
    code = "artifact_digest_mismatch"


class ArtifactIntegrityError(ArtifactDigestMismatch):
    """Stored metadata or content no longer matches its immutable identity."""


class UnsafeArtifactStorage(ArtifactIntegrityError):
    """A managed storage node is a symlink or otherwise not an owned regular node."""


class ArtifactNotFound(ArtifactStoreError):
    code = "artifact_not_found"


class ArtifactIdempotencyConflict(ArtifactStoreError):
    code = "idempotency_conflict"


class KiCadArtifactSyntaxError(ArtifactStoreError):
    code = "kicad_syntax_error"


class KiCadArtifactVersionUnsupported(ArtifactStoreError):
    code = "kicad_version_unsupported"


class UnsupportedArtifactStoreSchema(ArtifactStoreError):
    code = "artifact_store_schema_unsupported"


class ArtifactStoreUnavailable(ArtifactStoreError):
    code = "artifact_store_unavailable"


class ArtifactKind(str, Enum):
    KICAD_PCB = "kicad_pcb"
    KICAD_PROJECT_BUNDLE = "kicad_project_bundle"


class ArtifactSource(str, Enum):
    USER_UPLOAD = "user-upload"


class QuarantineStatus(str, Enum):
    STORED_UNINSPECTED = "stored-uninspected"


def require_public_id(value: object, label: str) -> str:
    if not isinstance(value, str) or _PUBLIC_ID.fullmatch(value) is None:
        raise InvalidArtifactRequest(f"{label} must be a canonical public identifier")
    return value


def require_artifact_id(value: object) -> str:
    if not isinstance(value, str) or _ARTIFACT_ID.fullmatch(value) is None:
        raise InvalidArtifactRequest("artifact ID is invalid")
    return value


def require_sha256(value: object, label: str = "SHA-256") -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise InvalidArtifactRequest(f"{label} must be a lowercase SHA-256 digest")
    return value


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    """Immutable metadata; it intentionally contains no host filesystem path."""

    artifact_id: str
    kind: ArtifactKind
    media_type: str
    size_bytes: int
    sha256: str
    quarantine_status: QuarantineStatus
    actor_id: str
    source: ArtifactSource
    idempotency_key: str
    created_at: datetime

    def __post_init__(self) -> None:
        require_artifact_id(self.artifact_id)
        media_type_by_kind = {
            ArtifactKind.KICAD_PCB: "application/x-kicad-pcb",
            ArtifactKind.KICAD_PROJECT_BUNDLE: "application/zip",
        }
        if not isinstance(self.kind, ArtifactKind):
            raise InvalidArtifactRequest("artifact kind is invalid")
        if self.media_type != media_type_by_kind[self.kind]:
            raise UnsupportedArtifactMediaType(
                "artifact kind and media type do not form a supported KiCad upload"
            )
        if (
            not isinstance(self.size_bytes, int)
            or isinstance(self.size_bytes, bool)
            or not 1 <= self.size_bytes <= MAX_ARTIFACT_BYTES
        ):
            raise InvalidArtifactRequest("artifact byte length is outside the contract bounds")
        require_sha256(self.sha256)
        if self.quarantine_status is not QuarantineStatus.STORED_UNINSPECTED:
            raise InvalidArtifactRequest("quarantine status is invalid")
        require_public_id(self.actor_id, "actor ID")
        if self.source is not ArtifactSource.USER_UPLOAD:
            raise InvalidArtifactRequest("artifact source is invalid")
        require_public_id(self.idempotency_key, "idempotency key")
        if not isinstance(self.created_at, datetime) or self.created_at.tzinfo is None:
            raise InvalidArtifactRequest("artifact creation time must be timezone-aware")
        if self.created_at.utcoffset() is None:
            raise InvalidArtifactRequest("artifact creation time has an invalid UTC offset")

    def api_payload(self) -> dict[str, object]:
        """Return exactly the normative successful-upload response fields."""

        return {
            "artifactId": self.artifact_id,
            "kind": self.kind.value,
            "mediaType": self.media_type,
            "sizeBytes": self.size_bytes,
            "sha256": self.sha256,
            "quarantineStatus": self.quarantine_status.value,
            "createdAt": self.created_at.astimezone(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
        }


@dataclass(frozen=True, slots=True)
class ArtifactContent:
    record: ArtifactRecord
    payload: bytes

    def __post_init__(self) -> None:
        if not isinstance(self.payload, bytes):
            raise ArtifactIntegrityError("managed artifact content is not immutable bytes")
        if len(self.payload) != self.record.size_bytes:
            raise ArtifactIntegrityError("managed artifact byte length no longer matches metadata")
        if hashlib.sha256(self.payload).hexdigest() != self.record.sha256:
            raise ArtifactIntegrityError("managed artifact digest no longer matches metadata")
