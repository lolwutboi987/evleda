"""Restart-safe content-addressed quarantine storage for KiCad uploads."""

from __future__ import annotations

import binascii
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sqlite3
import stat
import struct
from threading import RLock
from typing import Iterator
import unicodedata
import uuid
import zipfile
import zlib

from backend.kicad_io.errors import KiCadIOError, KiCadSyntaxError
from backend.kicad_io.sexpr import Atom, Quoted, head, parse
from backend.kicad_project import (
    BundleLimits,
    KiCadProjectError,
    ProjectBundleInput,
    UnsupportedPolicy as ProjectUnsupportedPolicy,
    round_trip_project_bundle,
)

from .models import (
    MAX_ARTIFACT_BYTES,
    ArtifactContent,
    ArtifactDigestMismatch,
    ArtifactIdempotencyConflict,
    ArtifactIntegrityError,
    ArtifactKind,
    ArtifactNotFound,
    ArtifactRecord,
    ArtifactSource,
    ArtifactStoreError,
    ArtifactStoreUnavailable,
    ArtifactTooLarge,
    InvalidArtifactRequest,
    KiCadArtifactSyntaxError,
    KiCadArtifactVersionUnsupported,
    QuarantineStatus,
    UnsafeArtifactStorage,
    UnsupportedArtifactMediaType,
    UnsupportedArtifactStoreSchema,
    require_artifact_id,
    require_public_id,
    require_sha256,
)


STORE_SCHEMA_VERSION = 2
_APPLICATION_ID = 0x46514154  # "FAQT": Flux Artifact Quarantine
_SCHEMA_NAME = "flux-clone-interchange-artifacts"
_METADATA_DOMAIN = "flux-clone.quarantine-artifact.v1"
_KICAD_VERSION = re.compile(r"([0-9]+)(?:\.[0-9A-Za-z.+-]+)*")
_SAFE_PROJECT_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_WINDOWS_RESERVED_STEM = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])", re.I)
_BUNDLE_LIMITS = BundleLimits()
_BUNDLE_ENTRY_LIMITS = {
    ".kicad_pro": _BUNDLE_LIMITS.maximum_project_bytes,
    ".kicad_sch": _BUNDLE_LIMITS.maximum_schematic_bytes,
    ".kicad_pcb": _BUNDLE_LIMITS.maximum_board_bytes,
}
_ZIP_ALLOWED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
_ZIP_MAX_COMPRESSION_RATIO = 100
_ZIP_EOCD = struct.Struct("<4s4H2LH")
_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP_LOCAL_FILE_SIGNATURE = b"PK\x03\x04"


class QuarantineArtifactStore:
    """Own immutable blobs and their versioned, digest-bound metadata.

    ``root`` is trusted host configuration, never request data. All request-facing
    methods accept raw bytes and identifiers only; no filename, URL, path, command,
    or output destination can reach a filesystem operation.
    """

    def __init__(
        self,
        root: str | Path,
        *,
        maximum_bytes: int = MAX_ARTIFACT_BYTES,
        busy_timeout_ms: int = 5_000,
    ) -> None:
        if (
            not isinstance(maximum_bytes, int)
            or isinstance(maximum_bytes, bool)
            or not 1 <= maximum_bytes <= MAX_ARTIFACT_BYTES
        ):
            raise ValueError(f"maximum_bytes must be between 1 and {MAX_ARTIFACT_BYTES}")
        if (
            not isinstance(busy_timeout_ms, int)
            or isinstance(busy_timeout_ms, bool)
            or busy_timeout_ms < 0
        ):
            raise ValueError("busy_timeout_ms must be a non-negative integer")
        self._maximum_bytes = maximum_bytes
        self._lock = RLock()
        self._closed = False
        candidate = Path(root)
        try:
            if candidate.is_symlink():
                raise UnsafeArtifactStorage("managed artifact root cannot be a symlink")
            candidate.mkdir(parents=True, exist_ok=True)
            if candidate.is_symlink() or not candidate.is_dir():
                raise UnsafeArtifactStorage("managed artifact root is not an owned directory")
            self._root = candidate.resolve(strict=True)
            self._objects = self._root / "objects"
            self._temporary = self._root / "temporary"
            self._ensure_owned_directory(self._objects)
            self._ensure_owned_directory(self._temporary)
            self._database_path = self._root / "artifacts.sqlite3"
            if self._database_path.is_symlink():
                raise UnsafeArtifactStorage("managed artifact database cannot be a symlink")
            if self._database_path.exists() and not self._database_path.is_file():
                raise UnsafeArtifactStorage("managed artifact database is not a regular file")
            self._connection = sqlite3.connect(
                str(self._database_path),
                isolation_level=None,
                check_same_thread=False,
                timeout=busy_timeout_ms / 1_000,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._initialize_schema()
        except ArtifactStoreError:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise
        except (OSError, sqlite3.Error) as exc:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise ArtifactStoreUnavailable(
                "managed artifact storage could not be initialized"
            ) from exc

    @property
    def maximum_bytes(self) -> int:
        return self._maximum_bytes

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._connection.close()
                self._closed = True

    def __enter__(self) -> QuarantineArtifactStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @contextmanager
    def _transaction(self, *, write: bool) -> Iterator[None]:
        with self._lock:
            self._require_open()
            try:
                self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield
            except Exception:
                self._connection.execute("ROLLBACK")
                raise
            else:
                self._connection.execute("COMMIT")

    def put(
        self,
        payload: bytes,
        *,
        actor_id: str,
        source_sha256: str,
        declared_length: int,
        idempotency_key: str,
        kind: ArtifactKind | str = ArtifactKind.KICAD_PCB,
        media_type: str = "application/x-kicad-pcb",
        source: ArtifactSource | str = ArtifactSource.USER_UPLOAD,
        maximum_bytes: int | None = None,
    ) -> ArtifactRecord:
        """Validate and atomically quarantine one raw user-uploaded KiCad artifact.

        The optional per-call limit may only reduce the host-configured ceiling.
        An idempotent retry returns the original artifact after re-verifying its blob.
        """

        self._require_open()
        actor = require_public_id(actor_id, "actor ID")
        key = require_public_id(idempotency_key, "idempotency key")
        digest = require_sha256(source_sha256, "source SHA-256")
        artifact_kind = self._require_kind(kind)
        artifact_source = self._require_source(source)
        expected_media_type = {
            ArtifactKind.KICAD_PCB: "application/x-kicad-pcb",
            ArtifactKind.KICAD_PROJECT_BUNDLE: "application/zip",
        }[artifact_kind]
        if media_type != expected_media_type:
            raise UnsupportedArtifactMediaType(
                "artifact kind and media type do not form a supported KiCad upload"
            )
        if not isinstance(payload, bytes):
            raise InvalidArtifactRequest("artifact body must be raw immutable bytes")
        if (
            not isinstance(declared_length, int)
            or isinstance(declared_length, bool)
            or declared_length < 1
        ):
            raise InvalidArtifactRequest("Content-Length must be a positive integer")
        effective_limit = self._effective_limit(maximum_bytes)
        if declared_length > effective_limit or len(payload) > effective_limit:
            raise ArtifactTooLarge("artifact exceeds the configured upload byte limit")
        if len(payload) != declared_length:
            raise InvalidArtifactRequest("received byte length does not match Content-Length")
        computed = hashlib.sha256(payload).hexdigest()
        if computed != digest:
            raise ArtifactDigestMismatch("received bytes do not match the supplied SHA-256")
        if artifact_kind is ArtifactKind.KICAD_PCB:
            self._validate_kicad_pcb_envelope(payload)
        else:
            self._validate_kicad_project_bundle(payload)

        created_at = datetime.now(timezone.utc)
        try:
            with self._transaction(write=True):
                existing = self._idempotent_row(actor, artifact_source, key)
                if existing is not None:
                    record = self._record_from_row(existing)
                    self._require_same_request(
                        record,
                        digest=digest,
                        size_bytes=len(payload),
                        kind=artifact_kind,
                        media_type=media_type,
                    )
                    self._read_verified_payload(record)
                    return record

                self._install_object(digest, payload)
                record = ArtifactRecord(
                    artifact_id=f"artifact_{uuid.uuid4().hex}",
                    kind=artifact_kind,
                    media_type=media_type,
                    size_bytes=len(payload),
                    sha256=digest,
                    quarantine_status=QuarantineStatus.STORED_UNINSPECTED,
                    actor_id=actor,
                    source=artifact_source,
                    idempotency_key=key,
                    created_at=created_at,
                )
                created_text = self._datetime_text(record.created_at)
                metadata_hash = self._metadata_sha256(record, created_text=created_text)
                self._connection.execute(
                    """
                    INSERT INTO quarantine_artifacts (
                        artifact_id, sha256, kind, media_type, size_bytes,
                        quarantine_status, actor_id, source, idempotency_key,
                        created_at, metadata_sha256
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.artifact_id,
                        record.sha256,
                        record.kind.value,
                        record.media_type,
                        record.size_bytes,
                        record.quarantine_status.value,
                        record.actor_id,
                        record.source.value,
                        record.idempotency_key,
                        created_text,
                        metadata_hash,
                    ),
                )
                return record
        except ArtifactStoreError:
            raise
        except sqlite3.IntegrityError as exc:
            raise ArtifactIntegrityError(
                "artifact metadata violated an immutable constraint"
            ) from exc
        except sqlite3.Error as exc:
            raise ArtifactStoreUnavailable("managed artifact metadata write failed") from exc

    def read(self, artifact_id: str, sha256: str, *, actor_id: str) -> ArtifactContent:
        """Resolve ID plus digest for one actor, then verify metadata and bytes again."""

        self._require_open()
        identifier = require_artifact_id(artifact_id)
        expected_digest = require_sha256(sha256, "artifact SHA-256")
        actor = require_public_id(actor_id, "actor ID")
        try:
            with self._transaction(write=False):
                row = self._connection.execute(
                    "SELECT * FROM quarantine_artifacts WHERE artifact_id = ?",
                    (identifier,),
                ).fetchone()
                if row is None:
                    raise ArtifactNotFound("managed artifact was not found")
                record = self._record_from_row(row)
                if record.actor_id != actor:
                    raise ArtifactNotFound("managed artifact was not found")
                if record.sha256 != expected_digest:
                    raise ArtifactDigestMismatch("artifact ID is not bound to the supplied SHA-256")
                return ArtifactContent(record, self._read_verified_payload(record))
        except ArtifactStoreError:
            raise
        except sqlite3.Error as exc:
            raise ArtifactStoreUnavailable("managed artifact metadata read failed") from exc

    def _initialize_schema(self) -> None:
        user_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        application_id = int(self._connection.execute("PRAGMA application_id").fetchone()[0])
        tables = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if user_version == 0 and not tables:
            if application_id not in {0, _APPLICATION_ID}:
                raise UnsupportedArtifactStoreSchema("database belongs to another application")
            self._connection.executescript(
                f"""
                PRAGMA application_id = {_APPLICATION_ID};
                PRAGMA user_version = {STORE_SCHEMA_VERSION};
                CREATE TABLE artifact_store_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_name TEXT NOT NULL,
                    schema_version INTEGER NOT NULL
                ) STRICT;
                INSERT INTO artifact_store_meta VALUES
                    (1, '{_SCHEMA_NAME}', {STORE_SCHEMA_VERSION});
                CREATE TABLE quarantine_artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    kind TEXT NOT NULL
                        CHECK (kind IN ('kicad_pcb', 'kicad_project_bundle')),
                    media_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL
                        CHECK (size_bytes BETWEEN 1 AND {MAX_ARTIFACT_BYTES}),
                    quarantine_status TEXT NOT NULL
                        CHECK (quarantine_status = 'stored-uninspected'),
                    actor_id TEXT NOT NULL,
                    source TEXT NOT NULL CHECK (source = 'user-upload'),
                    idempotency_key TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    metadata_sha256 TEXT NOT NULL,
                    CHECK (
                        (kind = 'kicad_pcb'
                            AND media_type = 'application/x-kicad-pcb')
                        OR (kind = 'kicad_project_bundle'
                            AND media_type = 'application/zip')
                    ),
                    UNIQUE (actor_id, source, idempotency_key)
                ) STRICT;
                CREATE TRIGGER quarantine_artifacts_no_update
                BEFORE UPDATE ON quarantine_artifacts
                BEGIN
                    SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
                END;
                CREATE TRIGGER quarantine_artifacts_no_delete
                BEFORE DELETE ON quarantine_artifacts
                BEGIN
                    SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
                END;
                """
            )
            return
        expected = {"artifact_store_meta", "quarantine_artifacts"}
        if not expected.issubset(tables):
            raise UnsupportedArtifactStoreSchema("artifact store schema is incomplete")
        if application_id == _APPLICATION_ID and user_version == 1:
            meta = self._connection.execute(
                "SELECT schema_name, schema_version FROM artifact_store_meta WHERE singleton = 1"
            ).fetchone()
            if (
                meta is None
                or meta["schema_name"] != _SCHEMA_NAME
                or meta["schema_version"] != 1
            ):
                raise UnsupportedArtifactStoreSchema("artifact store metadata is unsupported")
            rows = self._connection.execute("SELECT * FROM quarantine_artifacts").fetchall()
            for row in rows:
                self._record_from_row(row)
            self._migrate_schema_v1_to_v2()
            user_version = STORE_SCHEMA_VERSION
        if application_id != _APPLICATION_ID or user_version != STORE_SCHEMA_VERSION:
            raise UnsupportedArtifactStoreSchema("artifact store schema version is unsupported")
        meta = self._connection.execute(
            "SELECT schema_name, schema_version FROM artifact_store_meta WHERE singleton = 1"
        ).fetchone()
        if (
            meta is None
            or meta["schema_name"] != _SCHEMA_NAME
            or meta["schema_version"] != STORE_SCHEMA_VERSION
        ):
            raise UnsupportedArtifactStoreSchema("artifact store metadata is unsupported")

    def _migrate_schema_v1_to_v2(self) -> None:
        """Widen the immutable kind/media constraint without rebinding v1 records."""

        self._connection.executescript(
            f"""
            BEGIN IMMEDIATE;
            DROP TRIGGER IF EXISTS quarantine_artifacts_no_update;
            DROP TRIGGER IF EXISTS quarantine_artifacts_no_delete;
            ALTER TABLE quarantine_artifacts RENAME TO quarantine_artifacts_v1;
            CREATE TABLE quarantine_artifacts (
                artifact_id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                kind TEXT NOT NULL
                    CHECK (kind IN ('kicad_pcb', 'kicad_project_bundle')),
                media_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL
                    CHECK (size_bytes BETWEEN 1 AND {MAX_ARTIFACT_BYTES}),
                quarantine_status TEXT NOT NULL
                    CHECK (quarantine_status = 'stored-uninspected'),
                actor_id TEXT NOT NULL,
                source TEXT NOT NULL CHECK (source = 'user-upload'),
                idempotency_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                metadata_sha256 TEXT NOT NULL,
                CHECK (
                    (kind = 'kicad_pcb'
                        AND media_type = 'application/x-kicad-pcb')
                    OR (kind = 'kicad_project_bundle'
                        AND media_type = 'application/zip')
                ),
                UNIQUE (actor_id, source, idempotency_key)
            ) STRICT;
            INSERT INTO quarantine_artifacts
                SELECT * FROM quarantine_artifacts_v1;
            DROP TABLE quarantine_artifacts_v1;
            UPDATE artifact_store_meta
                SET schema_version = {STORE_SCHEMA_VERSION}
                WHERE singleton = 1;
            PRAGMA user_version = {STORE_SCHEMA_VERSION};
            CREATE TRIGGER quarantine_artifacts_no_update
            BEFORE UPDATE ON quarantine_artifacts
            BEGIN
                SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
            END;
            CREATE TRIGGER quarantine_artifacts_no_delete
            BEFORE DELETE ON quarantine_artifacts
            BEGIN
                SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
            END;
            COMMIT;
            """
        )

    def _effective_limit(self, requested: int | None) -> int:
        if requested is None:
            return self._maximum_bytes
        if (
            not isinstance(requested, int)
            or isinstance(requested, bool)
            or not 1 <= requested <= self._maximum_bytes
        ):
            raise InvalidArtifactRequest(
                "per-request byte limit must be positive and no greater than the store limit"
            )
        return requested

    @staticmethod
    def _require_kind(value: ArtifactKind | str) -> ArtifactKind:
        if value is ArtifactKind.KICAD_PCB or value == ArtifactKind.KICAD_PCB.value:
            return ArtifactKind.KICAD_PCB
        if (
            value is ArtifactKind.KICAD_PROJECT_BUNDLE
            or value == ArtifactKind.KICAD_PROJECT_BUNDLE.value
        ):
            return ArtifactKind.KICAD_PROJECT_BUNDLE
        raise UnsupportedArtifactMediaType("artifact kind is not a supported KiCad upload")

    @staticmethod
    def _require_source(value: ArtifactSource | str) -> ArtifactSource:
        if value is ArtifactSource.USER_UPLOAD or value == ArtifactSource.USER_UPLOAD.value:
            return ArtifactSource.USER_UPLOAD
        raise InvalidArtifactRequest("artifact source must be user-upload")

    @staticmethod
    def _validate_kicad_pcb_envelope(payload: bytes) -> None:
        try:
            root = parse(payload)
        except KiCadSyntaxError as exc:
            raise KiCadArtifactSyntaxError(
                "upload is not one bounded UTF-8 KiCad S-expression"
            ) from exc
        if not isinstance(root, tuple) or head(root) != "kicad_pcb":
            raise KiCadArtifactSyntaxError("upload root must be exactly kicad_pcb")
        versions: list[str] = []
        for child in root[1:]:
            if head(child) != "generator_version":
                continue
            if not isinstance(child, tuple) or len(child) != 2:
                raise KiCadArtifactSyntaxError("generator_version requires exactly one value")
            value = child[1]
            if not isinstance(value, (Atom, Quoted)):
                raise KiCadArtifactSyntaxError("generator_version must be scalar text")
            versions.append(value.value)
        if len(versions) != 1:
            raise KiCadArtifactSyntaxError("upload requires exactly one generator_version")
        match = _KICAD_VERSION.fullmatch(versions[0])
        if match is None or int(match.group(1)) != 10:
            raise KiCadArtifactVersionUnsupported(
                "only declared KiCad generator version 10 is accepted"
            )

    @classmethod
    def _validate_kicad_project_bundle(cls, payload: bytes) -> None:
        """Inspect and round-trip one bounded ZIP entirely from immutable bytes."""

        central_directory_offset = cls._validate_zip_end_record(payload)
        try:
            with zipfile.ZipFile(BytesIO(payload), mode="r", allowZip64=False) as archive:
                infos = archive.infolist()
                if len(infos) != len(_BUNDLE_ENTRY_LIMITS):
                    raise KiCadArtifactSyntaxError(
                        "project bundle must contain exactly three file entries"
                    )
                if archive.start_dir != central_directory_offset:
                    raise KiCadArtifactSyntaxError(
                        "project bundle central-directory offsets are not canonical"
                    )
                source = cls._read_project_bundle_entries(archive, infos)
        except ArtifactStoreError:
            raise
        except (
            binascii.Error,
            EOFError,
            NotImplementedError,
            OSError,
            OverflowError,
            RuntimeError,
            ValueError,
            zipfile.BadZipFile,
            zipfile.LargeZipFile,
            zlib.error,
        ) as exc:
            raise KiCadArtifactSyntaxError(
                "project bundle is not one bounded, readable ZIP archive"
            ) from exc

        try:
            result = round_trip_project_bundle(
                source,
                unsupported_policy=ProjectUnsupportedPolicy.MANIFEST,
                limits=_BUNDLE_LIMITS,
            )
        except (KiCadProjectError, KiCadIOError) as exc:
            message = str(exc).casefold()
            if "generator_version" in message or "kicad 10" in message:
                raise KiCadArtifactVersionUnsupported(
                    "project bundle must use the supported KiCad 10 exchange version"
                ) from exc
            raise KiCadArtifactSyntaxError(
                "project bundle contents do not form one valid KiCad project"
            ) from exc

        evidence = (
            result.imported.evidence,
            result.exported.evidence,
            result.reparsed.evidence,
            result.evidence,
        )
        if any(
            item.kicad_execution != "not-run"
            or item.manufacturing_release_eligible is not False
            for item in evidence
        ):
            raise ArtifactIntegrityError(
                "project codec evidence exceeded the quarantine validation authority"
            )
        if not result.evidence.semantic_parity or not result.evidence.diagnostics_parity:
            raise KiCadArtifactSyntaxError(
                "project bundle failed deterministic codec round-trip parity"
            )

    @staticmethod
    def _validate_zip_end_record(payload: bytes) -> int:
        """Bound central-directory allocation before ``zipfile`` creates entry objects."""

        if len(payload) < _ZIP_EOCD.size or not payload.startswith(
            _ZIP_LOCAL_FILE_SIGNATURE
        ):
            raise KiCadArtifactSyntaxError("project bundle is not a canonical ZIP archive")
        lower_bound = max(0, len(payload) - _ZIP_EOCD.size - 65_535)
        cursor = len(payload) - _ZIP_EOCD.size
        record: tuple[bytes, int, int, int, int, int, int, int] | None = None
        record_offset = -1
        while cursor >= lower_bound:
            candidate = payload.rfind(
                _ZIP_EOCD_SIGNATURE,
                lower_bound,
                cursor + len(_ZIP_EOCD_SIGNATURE),
            )
            if candidate < 0:
                break
            if candidate + _ZIP_EOCD.size <= len(payload):
                unpacked = _ZIP_EOCD.unpack_from(payload, candidate)
                if candidate + _ZIP_EOCD.size + unpacked[-1] == len(payload):
                    record = unpacked
                    record_offset = candidate
                    break
            cursor = candidate - 1
        if record is None:
            raise KiCadArtifactSyntaxError("project bundle ZIP end record is invalid")
        (
            _,
            disk_number,
            central_directory_disk,
            disk_entries,
            total_entries,
            central_directory_size,
            central_directory_offset,
            _,
        ) = record
        if disk_number != 0 or central_directory_disk != 0 or disk_entries != total_entries:
            raise KiCadArtifactSyntaxError("multi-disk project bundles are forbidden")
        if total_entries != len(_BUNDLE_ENTRY_LIMITS):
            raise KiCadArtifactSyntaxError(
                "project bundle must contain exactly three root-level files"
            )
        if (
            total_entries == 0xFFFF
            or central_directory_size == 0xFFFFFFFF
            or central_directory_offset == 0xFFFFFFFF
        ):
            raise KiCadArtifactSyntaxError("ZIP64 project bundles are not accepted")
        if central_directory_offset + central_directory_size != record_offset:
            raise KiCadArtifactSyntaxError(
                "project bundle contains prefixed, trailing, or malformed ZIP data"
            )
        return central_directory_offset

    @classmethod
    def _read_project_bundle_entries(
        cls,
        archive: zipfile.ZipFile,
        infos: list[zipfile.ZipInfo],
    ) -> ProjectBundleInput:
        normalized_names: set[str] = set()
        entries: dict[str, zipfile.ZipInfo] = {}
        stems: set[str] = set()
        header_offsets: set[int] = set()
        declared_total = 0
        for info in infos:
            name = info.orig_filename
            if not isinstance(name, str) or name != info.filename:
                raise KiCadArtifactSyntaxError("project bundle entry name is ambiguous")
            cls._validate_bundle_entry_metadata(info, name)
            normalized = unicodedata.normalize("NFC", name).casefold()
            if normalized in normalized_names:
                raise KiCadArtifactSyntaxError(
                    "project bundle contains duplicate normalized entry names"
                )
            normalized_names.add(normalized)
            if info.header_offset in header_offsets:
                raise KiCadArtifactSyntaxError(
                    "project bundle entries cannot alias one local file record"
                )
            header_offsets.add(info.header_offset)

            extension = next(
                (candidate for candidate in _BUNDLE_ENTRY_LIMITS if name.endswith(candidate)),
                None,
            )
            if extension is None or extension in entries:
                raise KiCadArtifactSyntaxError(
                    "project bundle entries are outside the exact KiCad project allow-list"
                )
            stem = name[: -len(extension)]
            if (
                _SAFE_PROJECT_STEM.fullmatch(stem) is None
                or _WINDOWS_RESERVED_STEM.fullmatch(stem) is not None
            ):
                raise KiCadArtifactSyntaxError("project bundle stem is not a safe basename")
            stems.add(stem)
            entries[extension] = info

            entry_limit = _BUNDLE_ENTRY_LIMITS[extension]
            if info.file_size > entry_limit:
                raise ArtifactTooLarge(f"{extension} entry exceeds its bundle byte limit")
            declared_total += info.file_size
            if declared_total > _BUNDLE_LIMITS.maximum_total_bytes:
                raise ArtifactTooLarge("expanded project bundle exceeds its aggregate byte limit")
            if info.file_size > info.compress_size * _ZIP_MAX_COMPRESSION_RATIO:
                raise ArtifactTooLarge(
                    "project bundle entry has a suspicious compression ratio"
                )

        if set(entries) != set(_BUNDLE_ENTRY_LIMITS) or len(stems) != 1:
            raise KiCadArtifactSyntaxError(
                "project bundle requires one shared stem and all three KiCad project files"
            )
        stem = next(iter(stems))
        payloads: dict[str, bytes] = {}
        actual_total = 0
        for extension in _BUNDLE_ENTRY_LIMITS:
            info = entries[extension]
            limit = _BUNDLE_ENTRY_LIMITS[extension]
            try:
                with archive.open(info, mode="r") as member:
                    content = member.read(limit + 1)
                    trailing = member.read(1)
            except (
                binascii.Error,
                EOFError,
                NotImplementedError,
                OSError,
                RuntimeError,
                ValueError,
                zipfile.BadZipFile,
                zlib.error,
            ) as exc:
                raise KiCadArtifactSyntaxError(
                    "project bundle member failed bounded decompression or CRC validation"
                ) from exc
            if len(content) > limit:
                raise ArtifactTooLarge(f"{extension} entry exceeds its bundle byte limit")
            if trailing or len(content) != info.file_size:
                raise KiCadArtifactSyntaxError(
                    "project bundle member length does not match its ZIP metadata"
                )
            if (binascii.crc32(content) & 0xFFFFFFFF) != info.CRC:
                raise KiCadArtifactSyntaxError("project bundle member CRC is invalid")
            actual_total += len(content)
            if actual_total > _BUNDLE_LIMITS.maximum_total_bytes:
                raise ArtifactTooLarge("expanded project bundle exceeds its aggregate byte limit")
            payloads[extension] = content
        if actual_total != declared_total:
            raise KiCadArtifactSyntaxError(
                "expanded project bundle length does not match its ZIP metadata"
            )
        return ProjectBundleInput(
            stem,
            payloads[".kicad_pro"],
            payloads[".kicad_sch"],
            payloads[".kicad_pcb"],
        )

    @staticmethod
    def _validate_bundle_entry_metadata(info: zipfile.ZipInfo, name: str) -> None:
        if (
            not name
            or "\x00" in name
            or unicodedata.normalize("NFC", name) != name
            or any(unicodedata.category(character).startswith("C") for character in name)
        ):
            raise KiCadArtifactSyntaxError("project bundle entry name is not canonical text")
        if (
            PurePosixPath(name).is_absolute()
            or PureWindowsPath(name).is_absolute()
            or PureWindowsPath(name).drive
            or "/" in name
            or "\\" in name
            or ".." in PurePosixPath(name).parts
            or ".." in PureWindowsPath(name).parts
        ):
            raise KiCadArtifactSyntaxError(
                "project bundle entries must be root-level safe basenames"
            )
        if info.is_dir() or name.endswith(("/", "\\")) or info.external_attr & 0x10:
            raise KiCadArtifactSyntaxError("directories are forbidden in project bundles")
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(unix_mode)
        if file_type not in {0, stat.S_IFREG}:
            raise KiCadArtifactSyntaxError(
                "symlink and special-file entries are forbidden in project bundles"
            )
        if info.flag_bits & (0x0001 | 0x0040 | 0x2000):
            raise KiCadArtifactSyntaxError("encrypted project bundle entries are forbidden")
        if info.compress_type not in _ZIP_ALLOWED_COMPRESSION:
            raise KiCadArtifactSyntaxError(
                "project bundle uses an unsupported ZIP compression method"
            )
        if info.file_size < 0 or info.compress_size < 0 or info.header_offset < 0:
            raise KiCadArtifactSyntaxError("project bundle entry metadata is invalid")
        cls_extra = info.extra
        cursor = 0
        while cursor < len(cls_extra):
            if cursor + 4 > len(cls_extra):
                raise KiCadArtifactSyntaxError("project bundle ZIP extra field is malformed")
            field_id, field_size = struct.unpack_from("<HH", cls_extra, cursor)
            cursor += 4
            if cursor + field_size > len(cls_extra):
                raise KiCadArtifactSyntaxError("project bundle ZIP extra field is malformed")
            if field_id == 0x7075:
                raise KiCadArtifactSyntaxError(
                    "alternate Unicode path names are forbidden in project bundles"
                )
            cursor += field_size

    def _install_object(self, digest: str, payload: bytes) -> None:
        destination = self._object_path(digest, create_shard=True)
        if destination.exists() or destination.is_symlink():
            self._verify_object(destination, digest=digest, size_bytes=len(payload))
            return
        temporary = self._temporary / f"upload-{uuid.uuid4().hex}.tmp"
        descriptor: int | None = None
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
            descriptor = os.open(temporary, flags, 0o600)
            view = memoryview(payload)
            written = 0
            while written < len(view):
                count = os.write(descriptor, view[written:])
                if count <= 0:
                    raise ArtifactStoreUnavailable("managed artifact object write was incomplete")
                written += count
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            try:
                os.link(temporary, destination, follow_symlinks=False)
            except FileExistsError:
                self._verify_object(destination, digest=digest, size_bytes=len(payload))
            self._fsync_directory(destination.parent)
        except ArtifactStoreError:
            raise
        except OSError as exc:
            raise ArtifactStoreUnavailable("managed artifact object installation failed") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        self._verify_object(destination, digest=digest, size_bytes=len(payload))

    def _object_path(self, digest: str, *, create_shard: bool) -> Path:
        require_sha256(digest)
        self._ensure_owned_directory(self._objects)
        shard = self._objects / digest[:2]
        if create_shard:
            self._ensure_owned_directory(shard)
        elif not shard.exists() or shard.is_symlink() or not shard.is_dir():
            raise UnsafeArtifactStorage("managed artifact shard is not an owned directory")
        path = shard / f"{digest}.blob"
        self._assert_contained(path)
        return path

    def _read_verified_payload(self, record: ArtifactRecord) -> bytes:
        path = self._object_path(record.sha256, create_shard=False)
        return self._verify_object(path, digest=record.sha256, size_bytes=record.size_bytes)

    def _verify_object(self, path: Path, *, digest: str, size_bytes: int) -> bytes:
        self._assert_contained(path)
        if path.is_symlink():
            raise UnsafeArtifactStorage("managed artifact object cannot be a symlink")
        try:
            before = path.stat(follow_symlinks=False)
        except FileNotFoundError as exc:
            raise ArtifactIntegrityError("managed artifact object is missing") from exc
        except OSError as exc:
            raise ArtifactIntegrityError("managed artifact object could not be verified") from exc
        if not stat.S_ISREG(before.st_mode) or before.st_size != size_bytes:
            raise ArtifactIntegrityError("managed artifact object length or type is invalid")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or opened.st_size != size_bytes:
                    raise ArtifactIntegrityError("managed artifact object changed before read")
                chunks: list[bytes] = []
                remaining = size_bytes + 1
                while remaining > 0:
                    chunk = os.read(descriptor, min(1_048_576, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                after = os.fstat(descriptor)
            finally:
                os.close(descriptor)
        except ArtifactStoreError:
            raise
        except OSError as exc:
            raise ArtifactIntegrityError(
                "managed artifact object could not be read safely"
            ) from exc
        payload = b"".join(chunks)
        if (
            len(payload) != size_bytes
            or after.st_size != size_bytes
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise ArtifactIntegrityError("managed artifact object changed during read")
        if path.is_symlink():
            raise UnsafeArtifactStorage("managed artifact object became a symlink")
        if hashlib.sha256(payload).hexdigest() != digest:
            raise ArtifactIntegrityError("managed artifact object digest is invalid")
        return payload

    def _idempotent_row(
        self,
        actor_id: str,
        source: ArtifactSource,
        idempotency_key: str,
    ) -> sqlite3.Row | None:
        return self._connection.execute(
            """
            SELECT * FROM quarantine_artifacts
            WHERE actor_id = ? AND source = ? AND idempotency_key = ?
            """,
            (actor_id, source.value, idempotency_key),
        ).fetchone()

    @staticmethod
    def _require_same_request(
        record: ArtifactRecord,
        *,
        digest: str,
        size_bytes: int,
        kind: ArtifactKind,
        media_type: str,
    ) -> None:
        if (
            record.sha256 != digest
            or record.size_bytes != size_bytes
            or record.kind is not kind
            or record.media_type != media_type
        ):
            raise ArtifactIdempotencyConflict(
                "idempotency key was already used for a different artifact input"
            )

    def _record_from_row(self, row: sqlite3.Row) -> ArtifactRecord:
        try:
            created_text = row["created_at"]
            if not isinstance(created_text, str) or not created_text.endswith("Z"):
                raise ValueError("invalid timestamp")
            record = ArtifactRecord(
                artifact_id=row["artifact_id"],
                kind=ArtifactKind(row["kind"]),
                media_type=row["media_type"],
                size_bytes=row["size_bytes"],
                sha256=row["sha256"],
                quarantine_status=QuarantineStatus(row["quarantine_status"]),
                actor_id=row["actor_id"],
                source=ArtifactSource(row["source"]),
                idempotency_key=row["idempotency_key"],
                created_at=datetime.fromisoformat(created_text.removesuffix("Z") + "+00:00"),
            )
            declared_hash = row["metadata_sha256"]
            require_sha256(declared_hash, "metadata SHA-256")
            if self._metadata_sha256(record, created_text=created_text) != declared_hash:
                raise ValueError("metadata digest mismatch")
            return record
        except (KeyError, TypeError, ValueError, ArtifactStoreError) as exc:
            raise ArtifactIntegrityError(
                "managed artifact metadata failed integrity verification"
            ) from exc

    @staticmethod
    def _metadata_sha256(record: ArtifactRecord, *, created_text: str) -> str:
        value = {
            "actorId": record.actor_id,
            "artifactId": record.artifact_id,
            "createdAt": created_text,
            "domain": _METADATA_DOMAIN,
            "idempotencyKey": record.idempotency_key,
            "kind": record.kind.value,
            "mediaType": record.media_type,
            "quarantineStatus": record.quarantine_status.value,
            "sha256": record.sha256,
            "sizeBytes": record.size_bytes,
            "source": record.source.value,
        }
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _datetime_text(value: datetime) -> str:
        return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace(
            "+00:00", "Z"
        )

    def _ensure_owned_directory(self, path: Path) -> None:
        self._assert_contained(path)
        try:
            if path.is_symlink():
                raise UnsafeArtifactStorage("managed artifact directory cannot be a symlink")
            path.mkdir(parents=False, exist_ok=True)
            if path.is_symlink() or not path.is_dir():
                raise UnsafeArtifactStorage("managed artifact node is not an owned directory")
        except ArtifactStoreError:
            raise
        except OSError as exc:
            raise ArtifactStoreUnavailable(
                "managed artifact directory could not be prepared"
            ) from exc

    def _assert_contained(self, path: Path) -> None:
        try:
            common = os.path.commonpath((str(self._root), str(path.resolve(strict=False))))
        except (OSError, ValueError) as exc:
            raise UnsafeArtifactStorage("managed artifact path could not be contained") from exc
        if common != str(self._root):
            raise UnsafeArtifactStorage("managed artifact path escaped its owned root")

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        if os.name == "nt":
            return
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _require_open(self) -> None:
        if self._closed:
            raise ArtifactStoreUnavailable("managed artifact store is closed")
