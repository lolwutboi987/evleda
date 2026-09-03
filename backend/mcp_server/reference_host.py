"""Least-privilege local MCP host for the finalized USB-C reference PCB.

Run with ``python -m backend.mcp_server.reference_host``.  Launch arguments are
trusted host configuration; MCP tool arguments can select neither paths nor
commands.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import stat
import sys
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import BinaryIO, NoReturn, cast

from backend.kicad_compile import verify_compiled_project
from backend.kicad_worker import (
    BundleResolutionError,
    CommandRunner,
    LocalKiCadCliService,
    ManagedKiCadBundle,
    PublishedArtifact,
    WorkerPolicy,
)
from backend.mcp_gateway import (
    ActorKind,
    CapabilityDenied,
    CapabilitySafeGateway,
    DesignPatch,
    ExportArtifact,
    ExportFormat,
    NotFound,
    PatchPreview,
    Principal,
    ProfileName,
    ProjectSnapshot,
    RevisionConflict,
    StageRecord,
    ToolName,
    VerificationReport,
)
from backend.reference_design import (
    PROJECT_ID,
    ReferenceArtifactSet,
    build_reference_artifact_set,
)
from evleda.reference import PackagedReference, load_packaged_reference

from .server import HostConfig, MCPStdioServer, serve_stdio

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_KICAD_VERSION = re.compile(r"^10\.[0-9]+\.[0-9]+$")
_JOURNAL_KEY_FILENAME = "journal-hmac-v1.key"
_JOURNAL_FILENAME = "kicad-worker-v1.sqlite3"
_JOURNAL_KEY_BYTES = 32
_JOURNAL_BINDING_COLUMNS = (
    "singleton",
    "schema_version",
    "journal_id",
    "key_id",
    "binding_mac",
)
_PUBLICATION_COLUMNS = (
    "project_id",
    "project_revision",
    "idempotency_key",
    "media_type",
    "artifact_id",
    "artifact_sha256",
    "size_bytes",
    "record_sha256",
)
_PUBLISH_MEDIA_TYPES = frozenset(
    {
        "application/vnd.gerber+zip",
        "application/vnd.ipc2581+xml",
        "application/vnd.kicad.project+zip",
        "image/png",
        "image/svg+xml",
    }
)
_SOURCE_CHECKOUT_ROOT = Path(__file__).resolve().parents[2]


class ReferenceHostConfigurationError(RuntimeError):
    """Trusted local host configuration is incomplete or unsafe."""


class ReferenceArtifactPublicationError(RuntimeError):
    """A host-side artifact could not be published without weakening integrity."""


def _require_absolute_path(value: object, label: str) -> Path:
    if not isinstance(value, Path) or not value.is_absolute():
        raise ReferenceHostConfigurationError(f"{label} must be an absolute pathlib.Path")
    return value


@dataclass(frozen=True, slots=True)
class LocalJournalKey:
    """Stable local key material whose repr never discloses the secret."""

    key: bytes = field(repr=False)
    key_id: str
    path: Path

    def __post_init__(self) -> None:
        if type(self.key) is not bytes or len(self.key) != _JOURNAL_KEY_BYTES:
            raise ReferenceHostConfigurationError("local journal key must be exactly 32 bytes")
        if type(self.key_id) is not str or _IDENTIFIER.fullmatch(self.key_id) is None:
            raise ReferenceHostConfigurationError("local journal key ID is invalid")
        _require_absolute_path(cast(object, self.path), "local journal key path")


@dataclass(frozen=True, slots=True)
class ReferenceHostSettings:
    """Closed launch-time configuration for one local reference endpoint."""

    state_root: Path
    actor_id: str = "local-reference-agent"
    kicad_executable: Path | None = None
    kicad_executable_sha256: str | None = None
    kicad_version: str | None = None
    worker_id: str = "local-kicad-cli-reference-v1"
    timeout_seconds: int = 120
    max_stdout_bytes: int = 1_048_576
    max_stderr_bytes: int = 1_048_576
    max_report_bytes: int = 32 * 1_048_576
    max_bundle_bytes: int = 128 * 1_048_576
    refill_zones_on_temp_copy: bool = False

    def __post_init__(self) -> None:
        if type(self) is not ReferenceHostSettings:
            raise TypeError("settings must use the exact ReferenceHostSettings type")
        _require_absolute_path(cast(object, self.state_root), "state_root")
        _assert_external_state_root(self.state_root)
        for value, label in (
            (self.actor_id, "actor_id"),
            (self.worker_id, "worker_id"),
        ):
            if type(value) is not str or _IDENTIFIER.fullmatch(value) is None:
                raise ReferenceHostConfigurationError(f"{label} must be a stable identifier")
        pins = (
            self.kicad_executable,
            self.kicad_executable_sha256,
            self.kicad_version,
        )
        if any(value is not None for value in pins) and any(value is None for value in pins):
            raise ReferenceHostConfigurationError(
                "KiCad verification requires executable, SHA-256, and version together"
            )
        if self.kicad_executable is not None:
            _require_absolute_path(
                cast(object, self.kicad_executable),
                "kicad_executable",
            )
            digest = self.kicad_executable_sha256
            version = self.kicad_version
            if type(digest) is not str or _SHA256.fullmatch(digest) is None:
                raise ReferenceHostConfigurationError(
                    "kicad_executable_sha256 must be a lowercase SHA-256 digest"
                )
            if type(version) is not str or _KICAD_VERSION.fullmatch(version) is None:
                raise ReferenceHostConfigurationError(
                    "kicad_version must pin an exact KiCad 10 patch version"
                )
        for name in (
            "timeout_seconds",
            "max_stdout_bytes",
            "max_stderr_bytes",
            "max_report_bytes",
            "max_bundle_bytes",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ReferenceHostConfigurationError(f"{name} must be a positive integer")
        if type(self.refill_zones_on_temp_copy) is not bool:
            raise ReferenceHostConfigurationError(
                "refill_zones_on_temp_copy must be an exact boolean"
            )

    @property
    def kicad_configured(self) -> bool:
        return self.kicad_executable is not None


def default_reference_state_root() -> Path:
    """Return an external per-user state location, never the source checkout."""

    if os.name == "nt":
        candidate = os.environ.get("LOCALAPPDATA")
        base = Path(candidate) if candidate and Path(candidate).is_absolute() else Path.home()
        if candidate is None or not Path(candidate).is_absolute():
            base = base / "AppData" / "Local"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        candidate = os.environ.get("XDG_STATE_HOME")
        base = (
            Path(candidate)
            if candidate and Path(candidate).is_absolute()
            else Path.home() / ".local" / "state"
        )
    return (base / "EvlEDA" / "reference-mcp-v1").resolve()


def _assert_external_state_root(root: Path) -> Path:
    """Reject source-tree state before a server creates any runtime bytes."""

    if not root.is_absolute():
        raise ReferenceHostConfigurationError("state directory must be an absolute path")
    unresolved = root.resolve(strict=False)
    if unresolved == _SOURCE_CHECKOUT_ROOT or _SOURCE_CHECKOUT_ROOT in unresolved.parents:
        raise ReferenceHostConfigurationError(
            "private runtime state cannot be stored inside the source checkout"
        )
    return unresolved


def _prepare_private_directory(root: Path) -> Path:
    _assert_external_state_root(root)
    try:
        if root.is_symlink():
            raise ReferenceHostConfigurationError("state directory cannot be a symlink")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.is_symlink() or not root.is_dir():
            raise ReferenceHostConfigurationError("state directory is not a regular directory")
        resolved = root.resolve(strict=True)
        if os.name != "nt" and stat.S_IMODE(resolved.stat().st_mode) & 0o077:
            raise ReferenceHostConfigurationError(
                "state directory permissions must deny group and other access"
            )
        return resolved
    except ReferenceHostConfigurationError:
        raise
    except OSError as exc:
        raise ReferenceHostConfigurationError("state directory is unavailable") from exc


def _read_private_key(path: Path) -> bytes:
    if path.is_symlink():
        raise ReferenceHostConfigurationError("journal key file cannot be a symlink")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise ReferenceHostConfigurationError(
                    "journal key file must be a regular file"
                )
            if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ReferenceHostConfigurationError(
                    "journal key permissions must deny group and other access"
                )
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                key = stream.read(_JOURNAL_KEY_BYTES + 1)
        finally:
            os.close(descriptor)
    except ReferenceHostConfigurationError:
        raise
    except OSError as exc:
        raise ReferenceHostConfigurationError("journal key file is unreadable") from exc
    if len(key) != _JOURNAL_KEY_BYTES:
        raise ReferenceHostConfigurationError("journal key file must contain exactly 32 bytes")
    return key


def _create_private_key(path: Path) -> bytes:
    key = secrets.token_bytes(_JOURNAL_KEY_BYTES)
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(key)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        return _read_private_key(path)
    except OSError as exc:
        if descriptor is not None:
            with suppress(OSError):
                path.unlink(missing_ok=True)
        raise ReferenceHostConfigurationError("journal key file could not be created") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return key


def load_or_create_local_journal_key(state_root: Path) -> LocalJournalKey:
    """Load a stable external key, or create it only for a fresh journal.

    Losing the key while a journal exists is terminal.  Generating a replacement
    would turn every existing record into indistinguishable apparent tampering.
    """

    root = _prepare_private_directory(state_root)
    key_path = root / _JOURNAL_KEY_FILENAME
    journal_paths = tuple(root / name for name in (
        _JOURNAL_FILENAME,
        f"{_JOURNAL_FILENAME}-shm",
        f"{_JOURNAL_FILENAME}-wal",
    ))
    if key_path.exists() or key_path.is_symlink():
        key = _read_private_key(key_path)
    else:
        if any(path.exists() or path.is_symlink() for path in journal_paths):
            raise ReferenceHostConfigurationError(
                "journal exists but its HMAC key is missing; refusing to replace it"
            )
        key = _create_private_key(key_path)
    fingerprint = hashlib.sha256(key).hexdigest()[:24]
    return LocalJournalKey(key, f"reference-journal-v1-{fingerprint}", key_path)


def _journal_binding_mac(key: LocalJournalKey, journal_id: str) -> str:
    material = json.dumps(
        {
            "domain": "flux-clone-reference-journal-key-binding-v1",
            "journal_id": journal_id,
            "key_id": key.key_id,
            "schema_version": 1,
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return hmac.new(key.key, material, hashlib.sha256).hexdigest()


def _bind_journal_to_key(journal_path: Path, key: LocalJournalKey) -> None:
    """Persist and verify a keyed sentinel before the worker opens its journal."""

    if journal_path.is_symlink():
        raise ReferenceHostConfigurationError("worker journal cannot be a symlink")
    existed = journal_path.exists()
    if existed and not journal_path.is_file():
        raise ReferenceHostConfigurationError("worker journal must be a regular file")
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(journal_path, isolation_level=None, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA trusted_schema = OFF")
        connection.execute("BEGIN IMMEDIATE")
        tables = {
            cast(str, row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        binding_table = "reference_host_journal_binding"
        if binding_table not in tables:
            if existed:
                raise ReferenceHostConfigurationError(
                    "existing worker journal has no trusted key binding"
                )
            connection.execute(
                """
                CREATE TABLE reference_host_journal_binding (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                    journal_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    binding_mac TEXT NOT NULL
                ) STRICT
                """
            )
            connection.execute(
                """
                CREATE TRIGGER reference_host_journal_binding_no_update
                BEFORE UPDATE ON reference_host_journal_binding
                BEGIN
                    SELECT RAISE(ABORT, 'journal key binding is immutable');
                END
                """
            )
            connection.execute(
                """
                CREATE TRIGGER reference_host_journal_binding_no_delete
                BEFORE DELETE ON reference_host_journal_binding
                BEGIN
                    SELECT RAISE(ABORT, 'journal key binding is immutable');
                END
                """
            )
            journal_id = f"journal_{secrets.token_hex(16)}"
            connection.execute(
                "INSERT INTO reference_host_journal_binding VALUES (1, 1, ?, ?, ?)",
                (journal_id, key.key_id, _journal_binding_mac(key, journal_id)),
            )
        else:
            columns = tuple(
                cast(str, row[1])
                for row in connection.execute(
                    "PRAGMA table_info(reference_host_journal_binding)"
                )
            )
            if columns != _JOURNAL_BINDING_COLUMNS:
                raise ReferenceHostConfigurationError("journal key binding schema changed")
            rows = connection.execute(
                "SELECT * FROM reference_host_journal_binding"
            ).fetchall()
            if len(rows) != 1:
                raise ReferenceHostConfigurationError("journal key binding row is invalid")
            row = rows[0]
            journal_id = row["journal_id"]
            key_id = row["key_id"]
            binding_mac = row["binding_mac"]
            if (
                type(journal_id) is not str
                or _IDENTIFIER.fullmatch(journal_id) is None
                or key_id != key.key_id
                or type(binding_mac) is not str
                or not hmac.compare_digest(
                    binding_mac,
                    _journal_binding_mac(key, journal_id),
                )
            ):
                raise ReferenceHostConfigurationError(
                    "worker journal is not bound to the active HMAC key"
                )
        connection.execute("COMMIT")
    except ReferenceHostConfigurationError:
        if connection is not None and connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    except sqlite3.Error as exc:
        if connection is not None and connection.in_transaction:
            with suppress(sqlite3.Error):
                connection.execute("ROLLBACK")
        raise ReferenceHostConfigurationError("journal key binding is unavailable") from exc
    finally:
        if connection is not None:
            connection.close()


class ExactReferenceBundleResolver:
    """Resolve exactly one compiler-built reference identity from immutable bytes."""

    def __init__(
        self,
        artifact_set: ReferenceArtifactSet | None = None,
        *,
        packaged_reference: PackagedReference | None = None,
    ) -> None:
        if artifact_set is not None and packaged_reference is not None:
            raise TypeError("resolver accepts either source-built or packaged reference input")
        self._artifact_set: ReferenceArtifactSet | None = None
        self._packaged_reference: PackagedReference | None = None
        if artifact_set is None:
            package = (
                load_packaged_reference()
                if packaged_reference is None
                else packaged_reference
            )
            if type(package) is not PackagedReference:
                raise TypeError("resolver requires an exact PackagedReference")
            if package.bundle.project_id != PROJECT_ID:
                raise ReferenceHostConfigurationError(
                    "packaged reference project identity changed"
                )
            self._packaged_reference = package
            self._bundle = package.bundle
            self._component_count = package.component_count
            self._net_count = package.net_count
            self._operation_count = package.operation_count
            self._source_mode = package.source_mode
            return

        package = artifact_set
        if type(package) is not ReferenceArtifactSet:
            raise TypeError("resolver requires an exact ReferenceArtifactSet")
        if package.result.design_id != PROJECT_ID:
            raise ReferenceHostConfigurationError("reference package project identity changed")
        if package.result.manufacturing_release_passed is not False:
            raise ReferenceHostConfigurationError(
                "reference MCP host cannot admit manufacturing-release authority"
            )
        verification = verify_compiled_project(package.result.graph, package.compiled)
        if (
            verification != package.result.compilation_verification
            or package.result.compiler_bundle_hash
            != package.compiled.manifest.output_bundle_sha256
            or package.result.compiler_manifest_hash != package.compiled.manifest_sha256
        ):
            raise ReferenceHostConfigurationError(
                "reference compiler bytes do not match the finalized artifact evidence"
            )
        graph = package.result.graph
        revision = "rev_" + package.result.revision_hash
        compiled = package.compiled.bundle
        self._artifact_set = package
        self._bundle = ManagedKiCadBundle.create(
            project_id=PROJECT_ID,
            project_revision=revision,
            stem=package.compiled.manifest.project_stem,
            project_payload=compiled.project_payload,
            schematic_payload=compiled.schematic_payload,
            board_payload=compiled.board_payload,
            auxiliary_files=compiled.auxiliary_files,
        )
        self._component_count = len(graph.components)
        self._net_count = len(graph.nets)
        self._operation_count = sum(
            len(items)
            for items in (
                graph.placements,
                graph.tracks,
                graph.vias,
                graph.zones,
                graph.schematic_wires,
                graph.schematic_junctions,
            )
        )
        self._source_mode = "explicit-private-evidence-rebuild"

    @classmethod
    def rebuild_from_private_source_evidence(
        cls,
        *,
        explicit_opt_in: bool,
    ) -> ExactReferenceBundleResolver:
        """Perform the separate maintainer rebuild path only after exact opt-in."""

        if explicit_opt_in is not True:
            raise ReferenceHostConfigurationError(
                "raw-evidence source rebuild requires explicit_opt_in=True"
            )
        return cls(build_reference_artifact_set())

    @property
    def artifact_set(self) -> ReferenceArtifactSet:
        if self._artifact_set is None:
            raise ReferenceHostConfigurationError(
                "the installed packaged runtime does not reconstruct private source evidence"
            )
        return self._artifact_set

    @property
    def packaged_reference(self) -> PackagedReference | None:
        return self._packaged_reference

    @property
    def bundle(self) -> ManagedKiCadBundle:
        return self._bundle

    @property
    def component_count(self) -> int:
        return self._component_count

    @property
    def net_count(self) -> int:
        return self._net_count

    @property
    def operation_count(self) -> int:
        return self._operation_count

    @property
    def source_mode(self) -> str:
        return self._source_mode

    def resolve_bundle(
        self,
        project_id: str,
        expected_project_revision: str,
    ) -> ManagedKiCadBundle:
        if (
            type(project_id) is not str
            or type(expected_project_revision) is not str
            or project_id != self._bundle.project_id
            or expected_project_revision != self._bundle.project_revision
        ):
            raise BundleResolutionError("the exact reference project revision is unavailable")
        return self._bundle


class ExactReferenceArtifactPublisher:
    """Identity-scoped, content-addressed publication with no path-shaped input."""

    def __init__(
        self,
        root: Path,
        *,
        project_id: str,
        project_revision: str,
        maximum_bytes: int = 128 * 1_048_576,
    ) -> None:
        if type(maximum_bytes) is not int or maximum_bytes < 1:
            raise ReferenceHostConfigurationError("publication limit must be positive")
        if type(project_id) is not str or _IDENTIFIER.fullmatch(project_id) is None:
            raise ReferenceHostConfigurationError("publisher project ID is invalid")
        if (
            type(project_revision) is not str
            or re.fullmatch(r"rev_[0-9a-f]{64}", project_revision) is None
        ):
            raise ReferenceHostConfigurationError("publisher project revision is invalid")
        self._root = _prepare_private_directory(root)
        self._objects = _prepare_private_directory(self._root / "objects")
        self._database_path = self._root / "publications-v1.sqlite3"
        self._project_id = project_id
        self._project_revision = project_revision
        self._maximum_bytes = maximum_bytes
        self._lock = RLock()
        self._initialize_store()

    def _connect(self) -> sqlite3.Connection:
        if self._database_path.is_symlink():
            raise ReferenceArtifactPublicationError(
                "publication database cannot be a symlink"
            )
        try:
            connection = sqlite3.connect(
                self._database_path,
                isolation_level=None,
                timeout=30,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout = 30000")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("PRAGMA trusted_schema = OFF")
            return connection
        except sqlite3.Error as exc:
            raise ReferenceArtifactPublicationError(
                "publication database is unavailable"
            ) from exc

    def _initialize_store(self) -> None:
        connection = self._connect()
        try:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS reference_publications (
                    project_id TEXT NOT NULL,
                    project_revision TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    artifact_id TEXT NOT NULL,
                    artifact_sha256 TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                    record_sha256 TEXT NOT NULL,
                    PRIMARY KEY (project_id, project_revision, idempotency_key)
                ) STRICT;
                CREATE TRIGGER IF NOT EXISTS reference_publications_no_update
                BEFORE UPDATE ON reference_publications
                BEGIN
                    SELECT RAISE(ABORT, 'reference publications are immutable');
                END;
                CREATE TRIGGER IF NOT EXISTS reference_publications_no_delete
                BEFORE DELETE ON reference_publications
                BEGIN
                    SELECT RAISE(ABORT, 'reference publications are immutable');
                END;
                """
            )
            columns = tuple(
                cast(str, row[1])
                for row in connection.execute(
                    "PRAGMA table_info(reference_publications)"
                )
            )
            if columns != _PUBLICATION_COLUMNS:
                raise ReferenceArtifactPublicationError(
                    "publication database schema changed"
                )
        except ReferenceArtifactPublicationError:
            raise
        except sqlite3.Error as exc:
            raise ReferenceArtifactPublicationError(
                "publication database could not be initialized"
            ) from exc
        finally:
            connection.close()

    @staticmethod
    def _record_digest(material: dict[str, object]) -> str:
        payload = json.dumps(
            material,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        return hashlib.sha256(
            b"flux-clone-reference-publication-v1\0" + payload
        ).hexdigest()

    @staticmethod
    def _sync_directory(path: Path) -> None:
        directory_flag = getattr(os, "O_DIRECTORY", 0)
        if directory_flag == 0:
            return
        descriptor = os.open(path, os.O_RDONLY | directory_flag)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _verified_file(path: Path, digest: str, payload: bytes) -> None:
        if path.is_symlink() or not path.is_file():
            raise ReferenceArtifactPublicationError(
                "published artifact object is not an owned regular file"
            )
        try:
            persisted = path.read_bytes()
        except OSError as exc:
            raise ReferenceArtifactPublicationError(
                "published artifact object is unreadable"
            ) from exc
        if persisted != payload or hashlib.sha256(persisted).hexdigest() != digest:
            raise ReferenceArtifactPublicationError(
                "published artifact object does not match its content identity"
            )

    def publish_artifact(
        self,
        *,
        project_id: str,
        project_revision: str,
        media_type: str,
        payload: bytes,
        expected_sha256: str,
        idempotency_key: str,
    ) -> PublishedArtifact:
        if project_id != self._project_id or project_revision != self._project_revision:
            raise ReferenceArtifactPublicationError(
                "publication is outside the exact reference project revision"
            )
        if type(media_type) is not str or media_type not in _PUBLISH_MEDIA_TYPES:
            raise ReferenceArtifactPublicationError("publication media type is not configured")
        if type(idempotency_key) is not str or _IDENTIFIER.fullmatch(idempotency_key) is None:
            raise ReferenceArtifactPublicationError("publication idempotency key is invalid")
        if type(payload) is not bytes or not 1 <= len(payload) <= self._maximum_bytes:
            raise ReferenceArtifactPublicationError("publication payload violates the byte cap")
        if type(expected_sha256) is not str or _SHA256.fullmatch(expected_sha256) is None:
            raise ReferenceArtifactPublicationError("publication digest is invalid")
        digest = hashlib.sha256(payload).hexdigest()
        if digest != expected_sha256:
            raise ReferenceArtifactPublicationError(
                "publication payload does not match its expected digest"
            )

        artifact_id = f"artifact_{digest}"
        material: dict[str, object] = {
            "artifact_id": artifact_id,
            "artifact_sha256": digest,
            "idempotency_key": idempotency_key,
            "media_type": media_type,
            "project_id": project_id,
            "project_revision": project_revision,
            "size_bytes": len(payload),
        }
        record_digest = self._record_digest(material)
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute(
                    """
                    SELECT * FROM reference_publications
                    WHERE project_id = ? AND project_revision = ? AND idempotency_key = ?
                    """,
                    (project_id, project_revision, idempotency_key),
                ).fetchone()
                if existing is not None:
                    persisted = {name: existing[name] for name in _PUBLICATION_COLUMNS[:-1]}
                    if (
                        persisted != material
                        or existing["record_sha256"] != record_digest
                    ):
                        raise ReferenceArtifactPublicationError(
                            "publication idempotency key is bound to different exact input"
                        )
                shard = _prepare_private_directory(self._objects / digest[:2])
                target = shard / f"{digest}.blob"
                if target.exists() or target.is_symlink():
                    self._verified_file(target, digest, payload)
                else:
                    temporary = shard / f".{secrets.token_hex(16)}.part"
                    try:
                        with temporary.open("xb") as stream:
                            stream.write(payload)
                            stream.flush()
                            os.fsync(stream.fileno())
                        os.replace(temporary, target)
                        self._sync_directory(shard)
                    except OSError as exc:
                        temporary.unlink(missing_ok=True)
                        raise ReferenceArtifactPublicationError(
                            "artifact publication could not be committed"
                        ) from exc
                    self._verified_file(target, digest, payload)
                if existing is None:
                    connection.execute(
                        "INSERT INTO reference_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            project_id,
                            project_revision,
                            idempotency_key,
                            media_type,
                            artifact_id,
                            digest,
                            len(payload),
                            record_digest,
                        ),
                    )
                connection.execute("COMMIT")
            except ReferenceArtifactPublicationError:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            except sqlite3.Error as exc:
                if connection.in_transaction:
                    with suppress(sqlite3.Error):
                        connection.execute("ROLLBACK")
                raise ReferenceArtifactPublicationError(
                    "artifact publication metadata could not be committed"
                ) from exc
            finally:
                connection.close()
        return PublishedArtifact(artifact_id, digest)


class ReadOnlyReferenceKiCadAdapter:
    """Gateway adapter exposing one immutable reference snapshot and nothing else."""

    def __init__(self, resolver: ExactReferenceBundleResolver) -> None:
        if type(resolver) is not ExactReferenceBundleResolver:
            raise TypeError("adapter requires an exact reference resolver")
        self._project_id = resolver.bundle.project_id
        self._project_revision = resolver.bundle.project_revision
        self._snapshot = ProjectSnapshot(
            project_id=self._project_id,
            project_revision=self._project_revision,
            component_count=resolver.component_count,
            net_count=resolver.net_count,
            operation_count=resolver.operation_count,
            active_staged_revision=None,
        )

    def inspect_project(
        self,
        project_id: str,
        expected_revision: str | None = None,
    ) -> ProjectSnapshot:
        if project_id != self._project_id:
            raise NotFound("project not found")
        if expected_revision is not None and expected_revision != self._project_revision:
            raise RevisionConflict("reference project revision does not match")
        return self._snapshot

    @staticmethod
    def _read_only() -> NoReturn:
        raise CapabilityDenied("the finalized reference project is read-only")

    def preview_patch(
        self,
        project_id: str,
        expected_revision: str,
        patch: DesignPatch,
    ) -> PatchPreview:
        del project_id, expected_revision, patch
        self._read_only()

    def stage_patch(
        self,
        project_id: str,
        expected_revision: str,
        patch: DesignPatch,
        preview_digest: str,
    ) -> StageRecord:
        del project_id, expected_revision, patch, preview_digest
        self._read_only()

    def run_verification(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> VerificationReport:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def commit(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def rollback(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def export_project(
        self,
        project_id: str,
        expected_project_revision: str,
        format: ExportFormat,
    ) -> ExportArtifact:
        del project_id, expected_project_revision, format
        self._read_only()


@dataclass(frozen=True, slots=True)
class ReferenceHostRuntime:
    """Constructed endpoint plus its exact host-owned subjects."""

    server: MCPStdioServer
    resolver: ExactReferenceBundleResolver
    publisher: ExactReferenceArtifactPublisher | None
    service: LocalKiCadCliService | None
    state_root: Path

    @property
    def project_id(self) -> str:
        return self.resolver.bundle.project_id

    @property
    def project_revision(self) -> str:
        return self.resolver.bundle.project_revision


def build_reference_host(
    settings: ReferenceHostSettings,
    *,
    runner: CommandRunner | None = None,
    artifact_set: ReferenceArtifactSet | None = None,
    packaged_reference: PackagedReference | None = None,
) -> ReferenceHostRuntime:
    """Build a reference endpoint; incomplete native configuration stays absent."""

    if type(settings) is not ReferenceHostSettings:
        raise TypeError("build_reference_host requires exact settings")
    if runner is not None and not settings.kicad_configured:
        raise ReferenceHostConfigurationError(
            "a command runner cannot be supplied while KiCad is unconfigured"
        )
    resolver = ExactReferenceBundleResolver(
        artifact_set,
        packaged_reference=packaged_reference,
    )
    bundle = resolver.bundle
    adapter = ReadOnlyReferenceKiCadAdapter(resolver)
    gateway = CapabilitySafeGateway(adapter)
    state_root = settings.state_root
    publisher: ExactReferenceArtifactPublisher | None = None
    service: LocalKiCadCliService | None = None
    worker_id: str | None = None
    kicad_version: str | None = None
    policy_digest: str | None = None
    exposed_hooks: frozenset[str] = frozenset()

    if settings.kicad_configured:
        state_root = _prepare_private_directory(state_root)
        publisher = ExactReferenceArtifactPublisher(
            state_root / "published-artifacts",
            project_id=bundle.project_id,
            project_revision=bundle.project_revision,
            maximum_bytes=settings.max_bundle_bytes,
        )
        key = load_or_create_local_journal_key(state_root)
        journal_path = state_root / _JOURNAL_FILENAME
        _bind_journal_to_key(journal_path, key)
        executable = cast(Path, settings.kicad_executable)
        executable_digest = cast(str, settings.kicad_executable_sha256)
        configured_version = cast(str, settings.kicad_version)
        policy = WorkerPolicy(
            executable=executable,
            executable_sha256=executable_digest,
            kicad_version=configured_version,
            worker_id=settings.worker_id,
            temp_root=state_root / "operations",
            journal_path=journal_path,
            journal_hmac_key=key.key,
            journal_key_id=key.key_id,
            timeout_seconds=settings.timeout_seconds,
            max_stdout_bytes=settings.max_stdout_bytes,
            max_stderr_bytes=settings.max_stderr_bytes,
            max_report_bytes=settings.max_report_bytes,
            max_bundle_bytes=settings.max_bundle_bytes,
            refill_zones_on_temp_copy=settings.refill_zones_on_temp_copy,
        )
        service = LocalKiCadCliService(
            policy,
            resolver,
            publisher,
            runner=runner,
        )
        worker_id = service.worker_id
        kicad_version = service.kicad_version
        policy_digest = service.policy_digest
        exposed_hooks = frozenset({"kicad_verify"})

    server = MCPStdioServer(
        gateway,
        HostConfig(
            principal=Principal(
                settings.actor_id,
                ActorKind.AGENT,
                ProfileName.DESIGNER,
            ),
            kicad_service=service,
            allowed_project_ids=frozenset({bundle.project_id}),
            kicad_worker=worker_id,
            kicad_version=kicad_version,
            kicad_policy_digest=policy_digest,
            durable_worker_idempotency=service is not None,
            exposed_gateway_tools=frozenset({ToolName.INSPECT_PROJECT}),
            exposed_kicad_hooks=exposed_hooks,
        ),
    )
    return ReferenceHostRuntime(server, resolver, publisher, service, state_root)


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.mcp_server.reference_host",
        description=(
            "Serve the immutable USB-C reference PCB over MCP stdio. Native KiCad "
            "verification is enabled only when all three runtime pins are supplied."
        ),
    )
    parser.add_argument("--state-root", type=Path, default=default_reference_state_root())
    parser.add_argument("--actor-id", default="local-reference-agent")
    parser.add_argument("--kicad-cli", type=Path)
    parser.add_argument("--kicad-cli-sha256")
    parser.add_argument("--kicad-version")
    parser.add_argument("--worker-id", default="local-kicad-cli-reference-v1")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument(
        "--refill-zones-on-temp-copy",
        action="store_true",
        help="allow KiCad DRC to refill zones only on the disposable managed copy",
    )
    return parser


def _settings_from_namespace(arguments: argparse.Namespace) -> ReferenceHostSettings:
    return ReferenceHostSettings(
        state_root=cast(Path, arguments.state_root),
        actor_id=cast(str, arguments.actor_id),
        kicad_executable=cast(Path | None, arguments.kicad_cli),
        kicad_executable_sha256=cast(str | None, arguments.kicad_cli_sha256),
        kicad_version=cast(str | None, arguments.kicad_version),
        worker_id=cast(str, arguments.worker_id),
        timeout_seconds=cast(int, arguments.timeout_seconds),
        refill_zones_on_temp_copy=cast(bool, arguments.refill_zones_on_temp_copy),
    )


def _configuration_exit(parser: argparse.ArgumentParser, message: str) -> NoReturn:
    parser.exit(2, f"reference MCP host configuration error: {message}\n")


def main(
    argv: Sequence[str] | None = None,
    *,
    input_stream: BinaryIO | None = None,
    output_stream: BinaryIO | None = None,
) -> int:
    parser = _argument_parser()
    arguments = parser.parse_args(argv)
    try:
        settings = _settings_from_namespace(arguments)
        runtime = build_reference_host(settings)
    except (RuntimeError, TypeError, ValueError, OSError) as exc:
        _configuration_exit(parser, str(exc))
    source = sys.stdin.buffer if input_stream is None else input_stream
    destination = sys.stdout.buffer if output_stream is None else output_stream
    serve_stdio(runtime.server, source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = (
    "ExactReferenceArtifactPublisher",
    "ExactReferenceBundleResolver",
    "LocalJournalKey",
    "ReadOnlyReferenceKiCadAdapter",
    "ReferenceArtifactPublicationError",
    "ReferenceHostConfigurationError",
    "ReferenceHostRuntime",
    "ReferenceHostSettings",
    "build_reference_host",
    "default_reference_state_root",
    "load_or_create_local_journal_key",
    "main",
)
