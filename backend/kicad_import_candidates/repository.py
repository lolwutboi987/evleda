"""Versioned SQLite repository for immutable KiCad import candidates."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from threading import RLock
from typing import Protocol, runtime_checkable

from backend.interchange_artifacts import ArtifactKind

from .models import (
    LEGAL_TRANSITIONS,
    ZERO_DIGEST,
    CandidateBlocker,
    CandidateConcurrencyConflict,
    CandidateDiagnostic,
    CandidateEventKind,
    CandidateIdentityScheme,
    CandidateIntegrityError,
    CandidateNotFound,
    CandidateRepositoryError,
    CandidateState,
    CandidateStoreUnavailable,
    CandidateTransitionEvent,
    DiagnosticSeverity,
    IllegalCandidateTransition,
    ImportCandidate,
    ImportCandidateDraft,
    InvalidCandidate,
    UnsupportedCandidateStoreSchema,
    blockers_digest,
    canonical_json,
    decode_time,
    diagnostics_digest,
    encode_time,
)


STORE_SCHEMA_VERSION = 3
_APPLICATION_ID = 0x46494352  # "FICR": Flux Import Candidate Repository
_SCHEMA_NAME = "flux-clone-kicad-import-candidates"
_IDENTITY_COLUMNS = (
    "candidate_id",
    "candidate_digest",
    "identity_scheme",
    "artifact_id",
    "artifact_sha256",
    "artifact_kind",
    "project_id",
    "expected_project_revision",
    "run_id",
    "expected_run_revision",
    "inspection_payload_json",
    "inspection_payload_digest",
    "inspection_receipt_digest",
    "diagnostics_json",
    "diagnostics_digest",
    "blockers_json",
    "blockers_digest",
    "created_by",
    "created_at",
)
_V2_CANDIDATE_COLUMNS = (
    "candidate_id",
    "candidate_digest",
    "artifact_id",
    "artifact_sha256",
    "artifact_kind",
    "project_id",
    "expected_project_revision",
    "run_id",
    "expected_run_revision",
    "inspection_payload_json",
    "inspection_payload_digest",
    "inspection_receipt_digest",
    "diagnostics_json",
    "diagnostics_digest",
    "blockers_json",
    "blockers_digest",
    "created_by",
    "state",
    "generation",
    "resolution_receipt_digest",
    "stage_receipt_digest",
    "terminal_reason",
    "created_at",
    "updated_at",
    "last_event_digest",
)
_V3_CANDIDATE_COLUMNS = (
    *_V2_CANDIDATE_COLUMNS[:2],
    "identity_scheme",
    *_V2_CANDIDATE_COLUMNS[2:],
)


@runtime_checkable
class ImportCandidateRepository(Protocol):
    """Storage-independent integration boundary; no design mutation methods."""

    def create(self, draft: ImportCandidateDraft) -> ImportCandidate: ...

    def get(self, candidate_id: str) -> ImportCandidate: ...

    def list_for_project(self, project_id: str) -> tuple[ImportCandidate, ...]: ...

    def list_events(self, candidate_id: str) -> tuple[CandidateTransitionEvent, ...]: ...

    def resolve(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        resolution_receipt_digest: str,
    ) -> ImportCandidate: ...

    def mark_staged(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        stage_receipt_digest: str,
    ) -> ImportCandidate: ...

    def reject(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> ImportCandidate: ...

    def invalidate(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> ImportCandidate: ...


class SQLiteImportCandidateRepository:
    """Restart-safe candidate identities plus an append-only transition chain.

    The database location is trusted host configuration. Public lifecycle
    methods accept only IDs, digests, revisions, actors, and canonical text; no
    raw artifact bytes or filesystem destinations cross this boundary.
    """

    def __init__(
        self,
        database: str | Path,
        *,
        busy_timeout_ms: int = 5_000,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if (
            not isinstance(busy_timeout_ms, int)
            or isinstance(busy_timeout_ms, bool)
            or busy_timeout_ms < 0
        ):
            raise ValueError("busy_timeout_ms must be a non-negative integer")
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._lock = RLock()
        self._closed = False
        try:
            self._connection = sqlite3.connect(
                str(database),
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
        except sqlite3.DatabaseError as exc:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise self._translate_sqlite_error(exc) from exc
        except Exception:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise

    def __enter__(self) -> SQLiteImportCandidateRepository:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._connection.close()
                except sqlite3.DatabaseError as exc:
                    raise self._translate_sqlite_error(exc) from exc
                self._closed = True

    @staticmethod
    def _translate_sqlite_error(exc: sqlite3.DatabaseError) -> CandidateRepositoryError:
        message = str(exc).lower()
        corruption_markers = (
            "corrupt",
            "malformed",
            "not a database",
            "file is encrypted",
            "candidate identity is immutable",
            "candidate events are append-only",
            "candidate records cannot be deleted",
        )
        unavailable_markers = (
            "busy",
            "locked",
            "readonly",
            "read-only",
            "unable to open",
            "disk i/o",
            "database or disk is full",
        )
        if isinstance(exc, sqlite3.IntegrityError) or any(
            marker in message for marker in corruption_markers
        ):
            return CandidateIntegrityError(
                "import candidate database failed an integrity check"
            )
        if isinstance(exc, sqlite3.OperationalError) and any(
            marker in message for marker in unavailable_markers
        ):
            return CandidateStoreUnavailable(
                "import candidate database is temporarily unavailable"
            )
        return CandidateRepositoryError("import candidate database operation failed")

    def _require_open(self) -> None:
        if self._closed:
            raise CandidateStoreUnavailable("import candidate repository is closed")

    @contextmanager
    def _transaction(self, *, write: bool) -> Iterator[None]:
        with self._lock:
            self._require_open()
            try:
                self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield
            except sqlite3.DatabaseError as exc:
                try:
                    self._connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise self._translate_sqlite_error(exc) from exc
            except Exception:
                try:
                    self._connection.execute("ROLLBACK")
                except sqlite3.DatabaseError as exc:
                    raise self._translate_sqlite_error(exc) from exc
                raise
            else:
                try:
                    self._connection.execute("COMMIT")
                except sqlite3.DatabaseError as exc:
                    try:
                        self._connection.execute("ROLLBACK")
                    except sqlite3.DatabaseError:
                        pass
                    raise self._translate_sqlite_error(exc) from exc

    def _initialize_schema(self) -> None:
        user_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        application_id = int(
            self._connection.execute("PRAGMA application_id").fetchone()[0]
        )
        tables = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        owned = {
            "import_candidate_repository_meta",
            "import_candidates",
            "import_candidate_events",
        }
        if user_version == 0:
            if tables:
                raise UnsupportedCandidateStoreSchema(
                    "database is not an empty import-candidate repository"
                )
            if application_id not in {0, _APPLICATION_ID}:
                raise UnsupportedCandidateStoreSchema(
                    "database belongs to another application"
                )
            self._create_current_schema()
            return
        if application_id != _APPLICATION_ID:
            raise UnsupportedCandidateStoreSchema(
                "database application identity is unsupported"
            )
        if not {
            "import_candidate_repository_meta",
            "import_candidates",
        }.issubset(tables):
            raise UnsupportedCandidateStoreSchema(
                "import candidate database is missing required tables"
            )
        if user_version == 1:
            self._verify_meta(expected_version=1)
            self._migrate_v1_to_v2()
            user_version = 2
        if user_version == 2:
            self._verify_meta(expected_version=2)
            self._migrate_v2_to_v3()
        elif user_version != STORE_SCHEMA_VERSION:
            raise UnsupportedCandidateStoreSchema(
                f"unsupported import candidate schema version {user_version}"
            )
        self._verify_meta(expected_version=STORE_SCHEMA_VERSION)
        final_tables = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if not owned.issubset(final_tables):
            raise UnsupportedCandidateStoreSchema(
                "import candidate database migration is incomplete"
            )
        candidate_columns = self._connection.execute(
            "PRAGMA table_info(import_candidates)"
        ).fetchall()
        candidate_column_names = tuple(
            str(row["name"]) for row in candidate_columns
        )
        if candidate_column_names != _V3_CANDIDATE_COLUMNS:
            raise UnsupportedCandidateStoreSchema(
                "current candidate table structure is unsupported"
            )
        nullability = {
            str(row["name"]): int(row["notnull"])
            for row in candidate_columns
        }
        if (
            nullability["identity_scheme"] != 1
            or nullability["expected_project_revision"] != 1
        ):
            raise UnsupportedCandidateStoreSchema(
                "current candidate identity columns are not required"
            )
        triggers = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            )
        }
        required_triggers = {
            "import_candidates_identity_immutable",
            "import_candidates_no_delete",
            "import_candidate_events_no_update",
            "import_candidate_events_no_delete",
        }
        if not required_triggers.issubset(triggers):
            raise UnsupportedCandidateStoreSchema(
                "import candidate database is missing immutable audit triggers"
            )

    def _create_current_schema(self) -> None:
        states = ",".join(f"'{item.value}'" for item in CandidateState)
        kinds = ",".join(f"'{item.value}'" for item in ArtifactKind)
        identity_schemes = ",".join(
            f"'{item.value}'" for item in CandidateIdentityScheme
        )
        event_kinds = ",".join(f"'{item.value}'" for item in CandidateEventKind)
        identity_columns = ", ".join(_IDENTITY_COLUMNS)
        self._connection.executescript(
            f"""
            PRAGMA application_id = {_APPLICATION_ID};
            PRAGMA user_version = {STORE_SCHEMA_VERSION};
            CREATE TABLE import_candidate_repository_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_name TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            ) STRICT;
            INSERT INTO import_candidate_repository_meta VALUES
                (1, '{_SCHEMA_NAME}', {STORE_SCHEMA_VERSION});
            CREATE TABLE import_candidates (
                candidate_id TEXT PRIMARY KEY,
                candidate_digest TEXT NOT NULL UNIQUE,
                identity_scheme TEXT NOT NULL
                    CHECK (identity_scheme IN ({identity_schemes})),
                artifact_id TEXT NOT NULL,
                artifact_sha256 TEXT NOT NULL,
                artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ({kinds})),
                project_id TEXT NOT NULL,
                expected_project_revision TEXT NOT NULL,
                run_id TEXT NOT NULL,
                expected_run_revision INTEGER NOT NULL
                    CHECK (expected_run_revision >= 0),
                inspection_payload_json TEXT NOT NULL,
                inspection_payload_digest TEXT NOT NULL,
                inspection_receipt_digest TEXT NOT NULL,
                diagnostics_json TEXT NOT NULL,
                diagnostics_digest TEXT NOT NULL,
                blockers_json TEXT NOT NULL,
                blockers_digest TEXT NOT NULL,
                created_by TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ({states})),
                generation INTEGER NOT NULL CHECK (generation >= 0),
                resolution_receipt_digest TEXT,
                stage_receipt_digest TEXT,
                terminal_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_event_digest TEXT NOT NULL
            ) STRICT;
            CREATE INDEX import_candidates_project_order
                ON import_candidates(project_id, created_at, candidate_id);
            CREATE TABLE import_candidate_events (
                candidate_id TEXT NOT NULL
                    REFERENCES import_candidates(candidate_id) ON DELETE RESTRICT,
                sequence INTEGER NOT NULL CHECK (sequence >= 0),
                kind TEXT NOT NULL CHECK (kind IN ({event_kinds})),
                previous_state TEXT CHECK (previous_state IN ({states})),
                state TEXT NOT NULL CHECK (state IN ({states})),
                actor_id TEXT NOT NULL,
                receipt_digest TEXT,
                reason TEXT,
                transitioned_at TEXT NOT NULL,
                previous_event_digest TEXT NOT NULL,
                event_digest TEXT NOT NULL UNIQUE,
                PRIMARY KEY (candidate_id, sequence)
            ) STRICT;
            CREATE TRIGGER import_candidates_identity_immutable
            BEFORE UPDATE OF {identity_columns} ON import_candidates
            BEGIN
                SELECT RAISE(ABORT, 'candidate identity is immutable');
            END;
            CREATE TRIGGER import_candidates_no_delete
            BEFORE DELETE ON import_candidates
            BEGIN
                SELECT RAISE(ABORT, 'candidate records cannot be deleted');
            END;
            CREATE TRIGGER import_candidate_events_no_update
            BEFORE UPDATE ON import_candidate_events
            BEGIN
                SELECT RAISE(ABORT, 'candidate events are append-only');
            END;
            CREATE TRIGGER import_candidate_events_no_delete
            BEFORE DELETE ON import_candidate_events
            BEGIN
                SELECT RAISE(ABORT, 'candidate events are append-only');
            END;
            """
        )

    def _verify_meta(self, *, expected_version: int) -> None:
        row = self._connection.execute(
            "SELECT schema_name, schema_version "
            "FROM import_candidate_repository_meta WHERE singleton = 1"
        ).fetchone()
        if (
            row is None
            or row["schema_name"] != _SCHEMA_NAME
            or row["schema_version"] != expected_version
        ):
            raise UnsupportedCandidateStoreSchema(
                "import candidate repository metadata is unsupported"
            )

    def _migrate_v1_to_v2(self) -> None:
        event_kinds = ",".join(f"'{item.value}'" for item in CandidateEventKind)
        states = ",".join(f"'{item.value}'" for item in CandidateState)
        identity_columns = ", ".join(
            item for item in _IDENTITY_COLUMNS if item != "identity_scheme"
        )
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                "ALTER TABLE import_candidates ADD COLUMN last_event_digest TEXT"
            )
            self._connection.execute(
                f"""
                CREATE TABLE import_candidate_events (
                    candidate_id TEXT NOT NULL
                        REFERENCES import_candidates(candidate_id) ON DELETE RESTRICT,
                    sequence INTEGER NOT NULL CHECK (sequence >= 0),
                    kind TEXT NOT NULL CHECK (kind IN ({event_kinds})),
                    previous_state TEXT CHECK (previous_state IN ({states})),
                    state TEXT NOT NULL CHECK (state IN ({states})),
                    actor_id TEXT NOT NULL,
                    receipt_digest TEXT,
                    reason TEXT,
                    transitioned_at TEXT NOT NULL,
                    previous_event_digest TEXT NOT NULL,
                    event_digest TEXT NOT NULL UNIQUE,
                    PRIMARY KEY (candidate_id, sequence)
                ) STRICT
                """
            )
            rows = self._connection.execute(
                "SELECT * FROM import_candidates ORDER BY candidate_id"
            ).fetchall()
            for row in rows:
                state = CandidateState(row["state"])
                event = CandidateTransitionEvent.build(
                    candidate_id=row["candidate_id"],
                    sequence=row["generation"],
                    kind=CandidateEventKind.MIGRATED,
                    previous_state=None,
                    state=state,
                    actor_id=row["created_by"],
                    receipt_digest=_migration_receipt(row, state),
                    reason=_migration_reason(row),
                    transitioned_at=decode_time(row["updated_at"]),
                    previous_event_digest=ZERO_DIGEST,
                )
                self._insert_event(event)
                self._connection.execute(
                    "UPDATE import_candidates SET last_event_digest = ? "
                    "WHERE candidate_id = ?",
                    (event.event_digest, event.candidate_id),
                )
            self._connection.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS import_candidates_identity_immutable
                BEFORE UPDATE OF {identity_columns} ON import_candidates
                BEGIN
                    SELECT RAISE(ABORT, 'candidate identity is immutable');
                END
                """
            )
            self._connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS import_candidates_no_delete
                BEFORE DELETE ON import_candidates
                BEGIN
                    SELECT RAISE(ABORT, 'candidate records cannot be deleted');
                END
                """
            )
            self._connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS import_candidate_events_no_update
                BEFORE UPDATE ON import_candidate_events
                BEGIN
                    SELECT RAISE(ABORT, 'candidate events are append-only');
                END
                """
            )
            self._connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS import_candidate_events_no_delete
                BEFORE DELETE ON import_candidate_events
                BEGIN
                    SELECT RAISE(ABORT, 'candidate events are append-only');
                END
                """
            )
            null_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) FROM import_candidates "
                    "WHERE last_event_digest IS NULL"
                ).fetchone()[0]
            )
            if null_count:
                raise CandidateIntegrityError(
                    "schema migration did not seal every candidate"
                )
            self._connection.execute(
                "UPDATE import_candidate_repository_meta SET schema_version = ? "
                "WHERE singleton = 1",
                (2,),
            )
            self._connection.execute("PRAGMA user_version = 2")
            self._connection.execute("COMMIT")
        except sqlite3.DatabaseError as exc:
            try:
                self._connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise self._translate_sqlite_error(exc) from exc
        except Exception:
            try:
                self._connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise

    def _migrate_v2_to_v3(self) -> None:
        """Preserve v2 identities while making revision binding non-null.

        Version 2 existed with both the original domain-hashed inspection
        payload digest and the later plain SHA-256 digest. The migration labels
        each row with the algorithm that reproduces its immutable digest and
        candidate ID; neither value is rewritten.
        """

        states = ",".join(f"'{item.value}'" for item in CandidateState)
        kinds = ",".join(f"'{item.value}'" for item in ArtifactKind)
        identity_schemes = ",".join(
            f"'{item.value}'" for item in CandidateIdentityScheme
        )
        identity_columns = ", ".join(_IDENTITY_COLUMNS)
        self._connection.execute("PRAGMA foreign_keys = OFF")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            column_names = tuple(
                str(row["name"])
                for row in self._connection.execute(
                    "PRAGMA table_info(import_candidates)"
                ).fetchall()
            )
            if column_names != _V2_CANDIDATE_COLUMNS:
                raise UnsupportedCandidateStoreSchema(
                    "version 2 candidate table structure is unsupported"
                )
            rows = self._connection.execute(
                "SELECT * FROM import_candidates ORDER BY candidate_id"
            ).fetchall()
            if any(row["expected_project_revision"] is None for row in rows):
                raise CandidateIntegrityError(
                    "version 2 candidate has no canonical project revision"
                )

            schemes: dict[str, CandidateIdentityScheme] = {}
            for row in rows:
                schemes[row["candidate_id"]] = _v2_identity_scheme(row)

            self._connection.execute(
                "DROP TRIGGER IF EXISTS import_candidates_identity_immutable"
            )
            self._connection.execute(
                "DROP TRIGGER IF EXISTS import_candidates_no_delete"
            )
            self._connection.execute(
                f"""
                CREATE TABLE import_candidates_v3 (
                    candidate_id TEXT PRIMARY KEY,
                    candidate_digest TEXT NOT NULL UNIQUE,
                    identity_scheme TEXT NOT NULL
                        CHECK (identity_scheme IN ({identity_schemes})),
                    artifact_id TEXT NOT NULL,
                    artifact_sha256 TEXT NOT NULL,
                    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ({kinds})),
                    project_id TEXT NOT NULL,
                    expected_project_revision TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    expected_run_revision INTEGER NOT NULL
                        CHECK (expected_run_revision >= 0),
                    inspection_payload_json TEXT NOT NULL,
                    inspection_payload_digest TEXT NOT NULL,
                    inspection_receipt_digest TEXT NOT NULL,
                    diagnostics_json TEXT NOT NULL,
                    diagnostics_digest TEXT NOT NULL,
                    blockers_json TEXT NOT NULL,
                    blockers_digest TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ({states})),
                    generation INTEGER NOT NULL CHECK (generation >= 0),
                    resolution_receipt_digest TEXT,
                    stage_receipt_digest TEXT,
                    terminal_reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_event_digest TEXT NOT NULL
                ) STRICT
                """
            )
            for row in rows:
                self._connection.execute(
                    """
                    INSERT INTO import_candidates_v3 (
                        candidate_id, candidate_digest, identity_scheme,
                        artifact_id, artifact_sha256, artifact_kind, project_id,
                        expected_project_revision, run_id, expected_run_revision,
                        inspection_payload_json, inspection_payload_digest,
                        inspection_receipt_digest, diagnostics_json,
                        diagnostics_digest, blockers_json, blockers_digest,
                        created_by, state, generation, resolution_receipt_digest,
                        stage_receipt_digest, terminal_reason, created_at,
                        updated_at, last_event_digest
                    )
                    SELECT candidate_id, candidate_digest, ?, artifact_id,
                        artifact_sha256, artifact_kind, project_id,
                        expected_project_revision, run_id, expected_run_revision,
                        inspection_payload_json, inspection_payload_digest,
                        inspection_receipt_digest, diagnostics_json,
                        diagnostics_digest, blockers_json, blockers_digest,
                        created_by, state, generation, resolution_receipt_digest,
                        stage_receipt_digest, terminal_reason, created_at,
                        updated_at, last_event_digest
                    FROM import_candidates WHERE candidate_id = ?
                    """,
                    (schemes[row["candidate_id"]].value, row["candidate_id"]),
                )
            self._connection.execute("DROP TABLE import_candidates")
            self._connection.execute(
                "ALTER TABLE import_candidates_v3 RENAME TO import_candidates"
            )
            self._connection.execute(
                "CREATE INDEX import_candidates_project_order "
                "ON import_candidates(project_id, created_at, candidate_id)"
            )
            self._connection.execute(
                f"""
                CREATE TRIGGER import_candidates_identity_immutable
                BEFORE UPDATE OF {identity_columns} ON import_candidates
                BEGIN
                    SELECT RAISE(ABORT, 'candidate identity is immutable');
                END
                """
            )
            self._connection.execute(
                """
                CREATE TRIGGER import_candidates_no_delete
                BEFORE DELETE ON import_candidates
                BEGIN
                    SELECT RAISE(ABORT, 'candidate records cannot be deleted');
                END
                """
            )
            migrated_rows = self._connection.execute(
                "SELECT * FROM import_candidates ORDER BY candidate_id"
            ).fetchall()
            for row in migrated_rows:
                candidate = self._candidate_from_row(row)
                self._verify_event_chain(candidate)
            if self._connection.execute("PRAGMA foreign_key_check").fetchall():
                raise CandidateIntegrityError(
                    "version 2 migration broke event foreign-key bindings"
                )
            self._connection.execute(
                "UPDATE import_candidate_repository_meta SET schema_version = 3 "
                "WHERE singleton = 1"
            )
            self._connection.execute("PRAGMA user_version = 3")
            self._connection.execute("COMMIT")
        except sqlite3.DatabaseError as exc:
            try:
                self._connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise self._translate_sqlite_error(exc) from exc
        except Exception:
            try:
                self._connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise
        finally:
            self._connection.execute("PRAGMA foreign_keys = ON")

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise InvalidCandidate("repository clock must return a timezone-aware datetime")
        return value.astimezone(timezone.utc)

    def create(self, draft: ImportCandidateDraft) -> ImportCandidate:
        if not isinstance(draft, ImportCandidateDraft):
            raise InvalidCandidate("create requires an ImportCandidateDraft")
        created_at = self._now()
        event = CandidateTransitionEvent.build(
            candidate_id=draft.candidate_id,
            sequence=0,
            kind=CandidateEventKind.CREATED,
            previous_state=None,
            state=CandidateState.PENDING,
            actor_id=draft.created_by,
            receipt_digest=draft.inspection_receipt_digest,
            reason=None,
            transitioned_at=created_at,
            previous_event_digest=ZERO_DIGEST,
        )
        candidate = ImportCandidate(
            candidate_id=draft.candidate_id,
            candidate_digest=draft.candidate_digest,
            identity_scheme=draft.identity_scheme,
            artifact_id=draft.artifact_id,
            artifact_sha256=draft.artifact_sha256,
            artifact_kind=draft.artifact_kind,
            project_id=draft.project_id,
            expected_project_revision=draft.expected_project_revision,
            run_id=draft.run_id,
            expected_run_revision=draft.expected_run_revision,
            inspection_payload_json=draft.inspection_payload_json,
            inspection_payload_digest=draft.inspection_payload_digest,
            inspection_receipt_digest=draft.inspection_receipt_digest,
            diagnostics=draft.diagnostics,
            blockers=draft.blockers,
            created_by=draft.created_by,
            state=CandidateState.PENDING,
            generation=0,
            resolution_receipt_digest=None,
            stage_receipt_digest=None,
            terminal_reason=None,
            created_at=created_at,
            updated_at=created_at,
            last_event_digest=event.event_digest,
        )
        with self._transaction(write=True):
            row = self._connection.execute(
                "SELECT * FROM import_candidates WHERE candidate_id = ?",
                (candidate.candidate_id,),
            ).fetchone()
            if row is not None:
                existing = self._candidate_from_row(row)
                self._verify_event_chain(existing)
                if existing.candidate_digest != candidate.candidate_digest:
                    raise CandidateIntegrityError(
                        "candidate ID collision has a different immutable digest"
                    )
                return existing
            self._connection.execute(
                """
                INSERT INTO import_candidates (
                    candidate_id, candidate_digest, identity_scheme, artifact_id,
                    artifact_sha256, artifact_kind, project_id,
                    expected_project_revision, run_id, expected_run_revision,
                    inspection_payload_json,
                    inspection_payload_digest, inspection_receipt_digest,
                    diagnostics_json, diagnostics_digest, blockers_json,
                    blockers_digest, created_by, state, generation,
                    resolution_receipt_digest, stage_receipt_digest, terminal_reason,
                    created_at, updated_at, last_event_digest
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?
                )
                """,
                _candidate_insert_values(candidate),
            )
            self._insert_event(event)
        return candidate

    def get(self, candidate_id: str) -> ImportCandidate:
        _validate_candidate_lookup(candidate_id)
        with self._transaction(write=False):
            candidate = self._get_locked(candidate_id)
            self._verify_event_chain(candidate)
            return candidate

    def list_for_project(self, project_id: str) -> tuple[ImportCandidate, ...]:
        _validate_public_lookup(project_id, "project ID")
        with self._transaction(write=False):
            rows = self._connection.execute(
                "SELECT * FROM import_candidates WHERE project_id = ? "
                "ORDER BY created_at, candidate_id",
                (project_id,),
            ).fetchall()
            candidates = tuple(self._candidate_from_row(row) for row in rows)
            for candidate in candidates:
                self._verify_event_chain(candidate)
            return candidates

    def list_events(self, candidate_id: str) -> tuple[CandidateTransitionEvent, ...]:
        _validate_candidate_lookup(candidate_id)
        with self._transaction(write=False):
            candidate = self._get_locked(candidate_id)
            return self._verify_event_chain(candidate)

    def resolve(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        resolution_receipt_digest: str,
    ) -> ImportCandidate:
        return self._transition(
            candidate_id,
            expected_generation=expected_generation,
            actor_id=actor_id,
            target=CandidateState.RESOLVED,
            receipt_digest=resolution_receipt_digest,
            reason=None,
        )

    def mark_staged(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        stage_receipt_digest: str,
    ) -> ImportCandidate:
        return self._transition(
            candidate_id,
            expected_generation=expected_generation,
            actor_id=actor_id,
            target=CandidateState.STAGED,
            receipt_digest=stage_receipt_digest,
            reason=None,
        )

    def reject(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> ImportCandidate:
        return self._transition(
            candidate_id,
            expected_generation=expected_generation,
            actor_id=actor_id,
            target=CandidateState.REJECTED,
            receipt_digest=None,
            reason=reason,
        )

    def invalidate(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> ImportCandidate:
        return self._transition(
            candidate_id,
            expected_generation=expected_generation,
            actor_id=actor_id,
            target=CandidateState.INVALIDATED,
            receipt_digest=None,
            reason=reason,
        )

    def _transition(
        self,
        candidate_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        target: CandidateState,
        receipt_digest: str | None,
        reason: str | None,
    ) -> ImportCandidate:
        _validate_candidate_lookup(candidate_id)
        if (
            not isinstance(expected_generation, int)
            or isinstance(expected_generation, bool)
            or expected_generation < 0
        ):
            raise InvalidCandidate("expected generation must be a non-negative integer")
        _validate_public_lookup(actor_id, "actor ID")
        if target in {CandidateState.RESOLVED, CandidateState.STAGED}:
            _validate_digest(receipt_digest, "transition receipt digest")
            if reason is not None:
                raise InvalidCandidate("resolution/stage transitions do not accept a reason")
        else:
            if receipt_digest is not None:
                raise InvalidCandidate("terminal transitions do not accept a receipt digest")
            _validate_reason(reason)
        with self._transaction(write=True):
            candidate = self._get_locked(candidate_id)
            self._verify_event_chain(candidate)
            if candidate.generation != expected_generation:
                raise CandidateConcurrencyConflict(
                    "candidate generation changed after the caller read it"
                )
            if target not in LEGAL_TRANSITIONS[candidate.state]:
                raise IllegalCandidateTransition(
                    f"cannot transition import candidate from "
                    f"{candidate.state.value} to {target.value}"
                )
            transitioned_at = self._now()
            if transitioned_at < candidate.updated_at:
                raise CandidateIntegrityError(
                    "repository clock moved backwards during candidate transition"
                )
            next_generation = candidate.generation + 1
            event = CandidateTransitionEvent.build(
                candidate_id=candidate.candidate_id,
                sequence=next_generation,
                kind=CandidateEventKind.TRANSITIONED,
                previous_state=candidate.state,
                state=target,
                actor_id=actor_id,
                receipt_digest=receipt_digest,
                reason=reason,
                transitioned_at=transitioned_at,
                previous_event_digest=candidate.last_event_digest,
            )
            next_candidate = candidate.with_transition(
                state=target,
                generation=next_generation,
                updated_at=transitioned_at,
                last_event_digest=event.event_digest,
                resolution_receipt_digest=(
                    receipt_digest if target is CandidateState.RESOLVED else None
                ),
                stage_receipt_digest=(
                    receipt_digest if target is CandidateState.STAGED else None
                ),
                terminal_reason=reason,
            )
            cursor = self._connection.execute(
                """
                UPDATE import_candidates
                SET state = ?, generation = ?, resolution_receipt_digest = ?,
                    stage_receipt_digest = ?, terminal_reason = ?, updated_at = ?,
                    last_event_digest = ?
                WHERE candidate_id = ? AND generation = ? AND state = ?
                    AND last_event_digest = ?
                """,
                (
                    next_candidate.state.value,
                    next_candidate.generation,
                    next_candidate.resolution_receipt_digest,
                    next_candidate.stage_receipt_digest,
                    next_candidate.terminal_reason,
                    encode_time(next_candidate.updated_at),
                    next_candidate.last_event_digest,
                    candidate.candidate_id,
                    expected_generation,
                    candidate.state.value,
                    candidate.last_event_digest,
                ),
            )
            if cursor.rowcount != 1:
                raise CandidateConcurrencyConflict(
                    "candidate changed before compare-and-swap could commit"
                )
            self._insert_event(event)
            return next_candidate

    def _get_locked(self, candidate_id: str) -> ImportCandidate:
        row = self._connection.execute(
            "SELECT * FROM import_candidates WHERE candidate_id = ?",
            (candidate_id,),
        ).fetchone()
        if row is None:
            raise CandidateNotFound(f"import candidate not found: {candidate_id}")
        return self._candidate_from_row(row)

    def _candidate_from_row(self, row: sqlite3.Row) -> ImportCandidate:
        try:
            diagnostics = _decode_diagnostics(row["diagnostics_json"])
            blockers = _decode_blockers(row["blockers_json"])
            if diagnostics_digest(diagnostics) != row["diagnostics_digest"]:
                raise CandidateIntegrityError(
                    "persisted diagnostics digest does not match diagnostics"
                )
            if blockers_digest(blockers) != row["blockers_digest"]:
                raise CandidateIntegrityError(
                    "persisted blockers digest does not match blockers"
                )
            return ImportCandidate(
                candidate_id=row["candidate_id"],
                candidate_digest=row["candidate_digest"],
                identity_scheme=CandidateIdentityScheme(row["identity_scheme"]),
                artifact_id=row["artifact_id"],
                artifact_sha256=row["artifact_sha256"],
                artifact_kind=ArtifactKind(row["artifact_kind"]),
                project_id=row["project_id"],
                expected_project_revision=row["expected_project_revision"],
                run_id=row["run_id"],
                expected_run_revision=row["expected_run_revision"],
                inspection_payload_json=row["inspection_payload_json"],
                inspection_payload_digest=row["inspection_payload_digest"],
                inspection_receipt_digest=row["inspection_receipt_digest"],
                diagnostics=diagnostics,
                blockers=blockers,
                created_by=row["created_by"],
                state=CandidateState(row["state"]),
                generation=row["generation"],
                resolution_receipt_digest=row["resolution_receipt_digest"],
                stage_receipt_digest=row["stage_receipt_digest"],
                terminal_reason=row["terminal_reason"],
                created_at=decode_time(row["created_at"]),
                updated_at=decode_time(row["updated_at"]),
                last_event_digest=row["last_event_digest"],
            )
        except CandidateIntegrityError:
            raise
        except (InvalidCandidate, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CandidateIntegrityError(
                "persisted import candidate record is malformed"
            ) from exc

    def _insert_event(self, event: CandidateTransitionEvent) -> None:
        self._connection.execute(
            """
            INSERT INTO import_candidate_events (
                candidate_id, sequence, kind, previous_state, state, actor_id,
                receipt_digest, reason, transitioned_at, previous_event_digest,
                event_digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.candidate_id,
                event.sequence,
                event.kind.value,
                event.previous_state.value if event.previous_state is not None else None,
                event.state.value,
                event.actor_id,
                event.receipt_digest,
                event.reason,
                encode_time(event.transitioned_at),
                event.previous_event_digest,
                event.event_digest,
            ),
        )

    def _event_from_row(self, row: sqlite3.Row) -> CandidateTransitionEvent:
        try:
            return CandidateTransitionEvent(
                candidate_id=row["candidate_id"],
                sequence=row["sequence"],
                kind=CandidateEventKind(row["kind"]),
                previous_state=(
                    CandidateState(row["previous_state"])
                    if row["previous_state"] is not None
                    else None
                ),
                state=CandidateState(row["state"]),
                actor_id=row["actor_id"],
                receipt_digest=row["receipt_digest"],
                reason=row["reason"],
                transitioned_at=decode_time(row["transitioned_at"]),
                previous_event_digest=row["previous_event_digest"],
                event_digest=row["event_digest"],
            )
        except CandidateIntegrityError:
            raise
        except (InvalidCandidate, KeyError, TypeError, ValueError) as exc:
            raise CandidateIntegrityError(
                "persisted import candidate event is malformed"
            ) from exc

    def _verify_event_chain(
        self, candidate: ImportCandidate
    ) -> tuple[CandidateTransitionEvent, ...]:
        rows = self._connection.execute(
            "SELECT * FROM import_candidate_events WHERE candidate_id = ? "
            "ORDER BY sequence",
            (candidate.candidate_id,),
        ).fetchall()
        events = tuple(self._event_from_row(row) for row in rows)
        if not events:
            raise CandidateIntegrityError("candidate has no durable lifecycle event")
        first = events[0]
        if first.kind not in {CandidateEventKind.CREATED, CandidateEventKind.MIGRATED}:
            raise CandidateIntegrityError("candidate event chain has no creation/migration root")
        if first.previous_event_digest != ZERO_DIGEST:
            raise CandidateIntegrityError("candidate event chain root is not zero-bound")
        if first.actor_id != candidate.created_by:
            raise CandidateIntegrityError(
                "candidate creator is not bound by the event-chain root"
            )
        replayed_resolution: str | None = None
        replayed_stage: str | None = None
        replayed_terminal_reason: str | None = None
        if first.kind is CandidateEventKind.CREATED:
            if (
                first.receipt_digest != candidate.inspection_receipt_digest
                or first.reason is not None
            ):
                raise CandidateIntegrityError(
                    "candidate inspection receipt is not bound by its creation event"
                )
        else:
            if (
                first.receipt_digest
                != _candidate_migration_receipt(candidate, first.state)
                or first.reason != _candidate_migration_reason(candidate, first)
            ):
                raise CandidateIntegrityError(
                    "migrated candidate lifecycle snapshot is not event-bound"
                )
            if first.state in {
                CandidateState.RESOLVED,
                CandidateState.STAGED,
                CandidateState.REJECTED,
                CandidateState.INVALIDATED,
            }:
                replayed_resolution = candidate.resolution_receipt_digest
            if first.state in {CandidateState.STAGED, CandidateState.INVALIDATED}:
                replayed_stage = candidate.stage_receipt_digest
            if first.state in {CandidateState.REJECTED, CandidateState.INVALIDATED}:
                replayed_terminal_reason = candidate.terminal_reason
        previous = first
        for event in events[1:]:
            if event.kind is not CandidateEventKind.TRANSITIONED:
                raise CandidateIntegrityError("only the event-chain root may be migrated")
            if event.sequence != previous.sequence + 1:
                raise CandidateIntegrityError("candidate event sequences are not contiguous")
            if event.previous_event_digest != previous.event_digest:
                raise CandidateIntegrityError("candidate event digest chain is broken")
            if event.previous_state is not previous.state:
                raise CandidateIntegrityError("candidate event state chain is broken")
            if event.transitioned_at < previous.transitioned_at:
                raise CandidateIntegrityError("candidate event time moved backwards")
            if event.state is CandidateState.RESOLVED:
                replayed_resolution = event.receipt_digest
            elif event.state is CandidateState.STAGED:
                replayed_stage = event.receipt_digest
            elif event.state in {
                CandidateState.REJECTED,
                CandidateState.INVALIDATED,
            }:
                replayed_terminal_reason = event.reason
            previous = event
        if (
            previous.sequence != candidate.generation
            or previous.state is not candidate.state
            or previous.event_digest != candidate.last_event_digest
            or previous.transitioned_at != candidate.updated_at
        ):
            raise CandidateIntegrityError(
                "candidate current state is not sealed by its final event"
            )
        if (
            replayed_resolution != candidate.resolution_receipt_digest
            or replayed_stage != candidate.stage_receipt_digest
            or replayed_terminal_reason != candidate.terminal_reason
        ):
            raise CandidateIntegrityError(
                "candidate lifecycle evidence does not replay from its event chain"
            )
        if (
            first.kind is CandidateEventKind.CREATED
            and first.transitioned_at != candidate.created_at
        ):
            raise CandidateIntegrityError(
                "candidate creation time is not sealed by its creation event"
            )
        return events


def _candidate_insert_values(candidate: ImportCandidate) -> tuple[object, ...]:
    return (
        candidate.candidate_id,
        candidate.candidate_digest,
        candidate.identity_scheme.value,
        candidate.artifact_id,
        candidate.artifact_sha256,
        candidate.artifact_kind.value,
        candidate.project_id,
        candidate.expected_project_revision,
        candidate.run_id,
        candidate.expected_run_revision,
        candidate.inspection_payload_json,
        candidate.inspection_payload_digest,
        candidate.inspection_receipt_digest,
        canonical_json([item.payload() for item in candidate.diagnostics]),
        diagnostics_digest(candidate.diagnostics),
        canonical_json([item.payload() for item in candidate.blockers]),
        blockers_digest(candidate.blockers),
        candidate.created_by,
        candidate.state.value,
        candidate.generation,
        candidate.resolution_receipt_digest,
        candidate.stage_receipt_digest,
        candidate.terminal_reason,
        encode_time(candidate.created_at),
        encode_time(candidate.updated_at),
        candidate.last_event_digest,
    )


def _decode_diagnostics(source: object) -> tuple[CandidateDiagnostic, ...]:
    decoded = _decode_canonical_array(source, "diagnostics")
    expected = {
        "code",
        "diagnostic_id",
        "entity_id",
        "evidence_digest",
        "message",
        "scope",
        "severity",
    }
    items: list[CandidateDiagnostic] = []
    for item in decoded:
        if not isinstance(item, dict) or set(item) != expected:
            raise CandidateIntegrityError("persisted diagnostic has unknown fields")
        items.append(
            CandidateDiagnostic(
                diagnostic_id=item["diagnostic_id"],
                code=item["code"],
                severity=DiagnosticSeverity(item["severity"]),
                scope=item["scope"],
                message=item["message"],
                evidence_digest=item["evidence_digest"],
                entity_id=item["entity_id"],
            )
        )
    return tuple(items)


def _decode_blockers(source: object) -> tuple[CandidateBlocker, ...]:
    decoded = _decode_canonical_array(source, "blockers")
    expected = {"blocker_id", "code", "entity_ids", "evidence_digest", "message"}
    items: list[CandidateBlocker] = []
    for item in decoded:
        if not isinstance(item, dict) or set(item) != expected:
            raise CandidateIntegrityError("persisted blocker has unknown fields")
        entity_ids = item["entity_ids"]
        if not isinstance(entity_ids, list):
            raise CandidateIntegrityError("persisted blocker entity IDs are malformed")
        items.append(
            CandidateBlocker(
                blocker_id=item["blocker_id"],
                code=item["code"],
                message=item["message"],
                evidence_digest=item["evidence_digest"],
                entity_ids=tuple(entity_ids),
            )
        )
    return tuple(items)


def _decode_canonical_array(source: object, label: str) -> list[object]:
    if not isinstance(source, str):
        raise CandidateIntegrityError(f"persisted {label} are not JSON text")
    decoded = json.loads(source)
    if not isinstance(decoded, list) or canonical_json(decoded) != source:
        raise CandidateIntegrityError(f"persisted {label} are not canonical JSON")
    return decoded


def _v2_identity_scheme(row: sqlite3.Row) -> CandidateIdentityScheme:
    try:
        diagnostics = _decode_diagnostics(row["diagnostics_json"])
        blockers = _decode_blockers(row["blockers_json"])
        if diagnostics_digest(diagnostics) != row["diagnostics_digest"]:
            raise CandidateIntegrityError(
                "version 2 diagnostics digest is inconsistent"
            )
        if blockers_digest(blockers) != row["blockers_digest"]:
            raise CandidateIntegrityError(
                "version 2 blockers digest is inconsistent"
            )
        matching: list[CandidateIdentityScheme] = []
        for scheme in CandidateIdentityScheme:
            draft = ImportCandidateDraft(
                artifact_id=row["artifact_id"],
                artifact_sha256=row["artifact_sha256"],
                artifact_kind=ArtifactKind(row["artifact_kind"]),
                project_id=row["project_id"],
                expected_project_revision=row["expected_project_revision"],
                run_id=row["run_id"],
                expected_run_revision=row["expected_run_revision"],
                inspection_payload_json=row["inspection_payload_json"],
                inspection_receipt_digest=row["inspection_receipt_digest"],
                diagnostics=diagnostics,
                blockers=blockers,
                created_by=row["created_by"],
                identity_scheme=scheme,
            )
            if (
                draft.inspection_payload_digest == row["inspection_payload_digest"]
                and draft.candidate_digest == row["candidate_digest"]
                and draft.candidate_id == row["candidate_id"]
            ):
                matching.append(scheme)
        if len(matching) != 1:
            raise CandidateIntegrityError(
                "version 2 candidate identity algorithm is ambiguous or invalid"
            )
        return matching[0]
    except CandidateIntegrityError:
        raise
    except (InvalidCandidate, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CandidateIntegrityError(
            "version 2 candidate identity is malformed"
        ) from exc


def _migration_receipt(row: sqlite3.Row, state: CandidateState) -> str | None:
    if state is CandidateState.STAGED:
        return row["stage_receipt_digest"]
    if state is CandidateState.RESOLVED:
        return row["resolution_receipt_digest"]
    if state is CandidateState.PENDING:
        return row["inspection_receipt_digest"]
    return None


def _migration_reason(row: sqlite3.Row) -> str:
    digest = _lifecycle_snapshot_digest(
        candidate_id=row["candidate_id"],
        state=CandidateState(row["state"]),
        generation=row["generation"],
        created_by=row["created_by"],
        inspection_receipt_digest=row["inspection_receipt_digest"],
        resolution_receipt_digest=row["resolution_receipt_digest"],
        stage_receipt_digest=row["stage_receipt_digest"],
        terminal_reason=row["terminal_reason"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
    return f"schema-v1-migration:{digest}"


def _candidate_migration_receipt(
    candidate: ImportCandidate, migrated_state: CandidateState
) -> str | None:
    if migrated_state is CandidateState.STAGED:
        return candidate.stage_receipt_digest
    if migrated_state is CandidateState.RESOLVED:
        return candidate.resolution_receipt_digest
    if migrated_state is CandidateState.PENDING:
        return candidate.inspection_receipt_digest
    return None


def _candidate_migration_reason(
    candidate: ImportCandidate, root: CandidateTransitionEvent
) -> str:
    migrated_state = root.state
    digest = _lifecycle_snapshot_digest(
        candidate_id=candidate.candidate_id,
        state=migrated_state,
        generation=root.sequence,
        created_by=candidate.created_by,
        inspection_receipt_digest=candidate.inspection_receipt_digest,
        resolution_receipt_digest=(
            candidate.resolution_receipt_digest
            if migrated_state
            in {
                CandidateState.RESOLVED,
                CandidateState.STAGED,
                CandidateState.REJECTED,
                CandidateState.INVALIDATED,
            }
            else None
        ),
        stage_receipt_digest=(
            candidate.stage_receipt_digest
            if migrated_state in {CandidateState.STAGED, CandidateState.INVALIDATED}
            else None
        ),
        terminal_reason=(
            candidate.terminal_reason
            if migrated_state in {CandidateState.REJECTED, CandidateState.INVALIDATED}
            else None
        ),
        created_at=encode_time(candidate.created_at),
        updated_at=encode_time(root.transitioned_at),
    )
    return f"schema-v1-migration:{digest}"


def _lifecycle_snapshot_digest(
    *,
    candidate_id: str,
    state: CandidateState,
    generation: int,
    created_by: str,
    inspection_receipt_digest: str,
    resolution_receipt_digest: str | None,
    stage_receipt_digest: str | None,
    terminal_reason: str | None,
    created_at: str,
    updated_at: str,
) -> str:
    material = canonical_json(
        {
            "candidate_id": candidate_id,
            "created_at": created_at,
            "created_by": created_by,
            "domain": "flux-clone.kicad-import-candidate.migration-snapshot.v1",
            "generation": generation,
            "inspection_receipt_digest": inspection_receipt_digest,
            "resolution_receipt_digest": resolution_receipt_digest,
            "stage_receipt_digest": stage_receipt_digest,
            "state": state.value,
            "terminal_reason": terminal_reason,
            "updated_at": updated_at,
        }
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _validate_candidate_lookup(value: object) -> None:
    if not isinstance(value, str) or not re_fullmatch_candidate(value):
        raise InvalidCandidate("import candidate ID is invalid")


def re_fullmatch_candidate(value: str) -> bool:
    return re.fullmatch(r"import_candidate_[0-9a-f]{32}", value) is not None


def _validate_public_lookup(value: object, label: str) -> None:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value) is None
    ):
        raise InvalidCandidate(f"{label} must be a canonical public identifier")


def _validate_digest(value: object, label: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise InvalidCandidate(f"{label} must be a lowercase SHA-256 digest")


def _validate_reason(value: object) -> None:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise InvalidCandidate("terminal transition reason must be non-empty trimmed text")
