"""Crash-releasing, cross-process execution leases for import staging.

The journal accepts an injected :class:`ExclusiveStageExecutionCoordinator`.
This implementation combines an operating-system byte-range lock (released by
the kernel when a process exits) with a durable SQLite fencing counter.  The
lock is held for the entire caller context, including every external side
effect and its journal projection.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
from collections.abc import Callable, Generator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock, RLock
from typing import BinaryIO, ClassVar

from .models import (
    InvalidStageOperation,
    StageOperationIntegrityError,
    StageOperationRecoveryRequired,
    require_public_id,
    require_time,
)
from .trust import ExecutionLease, ExecutionLeaseValidation, LeaseMode

_APPLICATION_ID = 0x46534331  # FSC1
_SCHEMA_VERSION = 1
_METADATA_SQL = (
    "CREATE TABLE coordinator_metadata("
    "singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
    "coordinator_id TEXT NOT NULL,"
    "coordinator_incarnation TEXT NOT NULL)"
)
_FENCES_SQL = (
    "CREATE TABLE operation_fences("
    "operation_id TEXT PRIMARY KEY,"
    "fencing_token INTEGER NOT NULL CHECK(fencing_token>0))"
)
_METADATA_NO_UPDATE_SQL = (
    "CREATE TRIGGER coordinator_metadata_no_update "
    "BEFORE UPDATE ON coordinator_metadata "
    "BEGIN SELECT RAISE(ABORT,'coordinator metadata is immutable'); END"
)
_METADATA_NO_DELETE_SQL = (
    "CREATE TRIGGER coordinator_metadata_no_delete "
    "BEFORE DELETE ON coordinator_metadata "
    "BEGIN SELECT RAISE(ABORT,'coordinator metadata is immutable'); END"
)
_FENCES_INSERT_ONE_SQL = (
    "CREATE TRIGGER operation_fences_insert_one "
    "BEFORE INSERT ON operation_fences WHEN NEW.fencing_token != 1 "
    "BEGIN SELECT RAISE(ABORT,'fencing sequence must begin at one'); END"
)
_FENCES_MONOTONIC_SQL = (
    "CREATE TRIGGER operation_fences_monotonic "
    "BEFORE UPDATE ON operation_fences "
    "WHEN NEW.operation_id != OLD.operation_id "
    "OR NEW.fencing_token != OLD.fencing_token + 1 "
    "BEGIN SELECT RAISE(ABORT,'fencing sequence is append-only'); END"
)
_FENCES_NO_DELETE_SQL = (
    "CREATE TRIGGER operation_fences_no_delete "
    "BEFORE DELETE ON operation_fences "
    "BEGIN SELECT RAISE(ABORT,'fencing sequence is append-only'); END"
)
_EXPECTED_CATALOG = (
    ("index", "sqlite_autoindex_operation_fences_1", None),
    ("table", "coordinator_metadata", _METADATA_SQL),
    ("table", "operation_fences", _FENCES_SQL),
    ("trigger", "coordinator_metadata_no_delete", _METADATA_NO_DELETE_SQL),
    ("trigger", "coordinator_metadata_no_update", _METADATA_NO_UPDATE_SQL),
    ("trigger", "operation_fences_insert_one", _FENCES_INSERT_ONE_SQL),
    ("trigger", "operation_fences_monotonic", _FENCES_MONOTONIC_SQL),
    ("trigger", "operation_fences_no_delete", _FENCES_NO_DELETE_SQL),
)


def _catalog(connection: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    rows = connection.execute(
        "SELECT type,name,sql FROM sqlite_master "
        "WHERE type IN ('table','index','trigger','view') ORDER BY type,name"
    ).fetchall()
    return tuple(tuple(row) for row in rows)


def _lock_file(file: BinaryIO) -> None:
    file.seek(0, os.SEEK_END)
    if file.tell() == 0:
        file.write(b"\0")
        file.flush()
        os.fsync(file.fileno())
    file.seek(0)
    if os.name == "nt":
        import msvcrt

        try:
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise StageOperationRecoveryRequired(
                "another process holds the stage execution lease"
            ) from exc
    else:
        import fcntl

        try:
            fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise StageOperationRecoveryRequired(
                "another process holds the stage execution lease"
            ) from exc


def _unlock_file(file: BinaryIO) -> None:
    file.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(file.fileno(), fcntl.LOCK_UN)


class FileStageExecutionCoordinator:
    """OS-locked, persistently fenced coordinator suitable for local workers.

    Every process using one journal must point at the same ``root`` and exact
    ``coordinator_id``.  A different ID, replaced schema, or replaced metadata
    fails closed.  The SQLite counter is committed while the OS lock is held,
    before a lease is issued.
    """

    _process_lock: ClassVar[Lock] = Lock()
    _process_active: ClassVar[set[str]] = set()

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        coordinator_id: str,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.coordinator_id = require_public_id(
            coordinator_id, "execution coordinator ID"
        )
        if clock is not None and not callable(clock):
            raise InvalidStageOperation("execution coordinator clock must be callable")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._locks_root = self._root / "locks"
        self._locks_root.mkdir(exist_ok=True)
        self._database = self._root / "fencing.sqlite3"
        self._active_lock = RLock()
        self._active: dict[str, tuple[ExecutionLease, BinaryIO, str]] = {}
        self.coordinator_incarnation = self._initialize_database()

    def _now(self) -> datetime:
        try:
            return require_time(self._clock(), "execution coordinator clock")
        except InvalidStageOperation:
            raise
        except BaseException as exc:
            raise InvalidStageOperation("execution coordinator clock failed") from exc

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self._database,
            timeout=10.0,
            isolation_level=None,
        )
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA trusted_schema=OFF")
        return connection

    def _initialize_database(self) -> str:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            application_id = int(
                connection.execute("PRAGMA application_id").fetchone()[0]
            )
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            count = int(
                connection.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
            )
            if application_id == 0 and version == 0 and count == 0:
                incarnation = (
                    f"stage-coordinator-incarnation-{secrets.token_hex(32)}"
                )
                connection.execute(f"PRAGMA application_id={_APPLICATION_ID}")
                connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
                connection.execute(_METADATA_SQL)
                connection.execute(_FENCES_SQL)
                connection.execute(_METADATA_NO_UPDATE_SQL)
                connection.execute(_METADATA_NO_DELETE_SQL)
                connection.execute(_FENCES_INSERT_ONE_SQL)
                connection.execute(_FENCES_MONOTONIC_SQL)
                connection.execute(_FENCES_NO_DELETE_SQL)
                connection.execute(
                    "INSERT INTO coordinator_metadata VALUES(1,?,?)",
                    (self.coordinator_id, incarnation),
                )
            elif (
                application_id != _APPLICATION_ID
                or version != _SCHEMA_VERSION
                or _catalog(connection) != _EXPECTED_CATALOG
            ):
                raise StageOperationIntegrityError(
                    "execution coordinator database/schema was replaced or tampered"
                )
            row = connection.execute(
                "SELECT coordinator_id,coordinator_incarnation "
                "FROM coordinator_metadata WHERE singleton=1"
            ).fetchone()
            if (
                row is None
                or type(row[0]) is not str
                or type(row[1]) is not str
                or row[0] != self.coordinator_id
            ):
                raise StageOperationIntegrityError(
                    "execution coordinator metadata is missing or rebound"
                )
            incarnation = require_public_id(
                row[1], "execution coordinator incarnation"
            )
            if _catalog(connection) != _EXPECTED_CATALOG:
                raise StageOperationIntegrityError(
                    "execution coordinator schema differs from compiled DDL"
                )
            connection.execute("COMMIT")
            return incarnation
        except BaseException:
            with suppress(sqlite3.Error):
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def _next_fencing_token(self, operation_id: str) -> int:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            if (
                int(connection.execute("PRAGMA application_id").fetchone()[0])
                != _APPLICATION_ID
                or int(connection.execute("PRAGMA user_version").fetchone()[0])
                != _SCHEMA_VERSION
                or _catalog(connection) != _EXPECTED_CATALOG
            ):
                raise StageOperationIntegrityError(
                    "execution coordinator schema changed before fencing"
                )
            row = connection.execute(
                "SELECT fencing_token FROM operation_fences WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
            if row is None:
                token = 1
                connection.execute(
                    "INSERT INTO operation_fences VALUES(?,?)",
                    (operation_id, token),
                )
            else:
                if type(row[0]) is not int or row[0] <= 0:
                    raise StageOperationIntegrityError(
                        "execution fencing counter is malformed"
                    )
                token = row[0] + 1
                cursor = connection.execute(
                    "UPDATE operation_fences SET fencing_token=? "
                    "WHERE operation_id=? AND fencing_token=?",
                    (token, operation_id, row[0]),
                )
                if cursor.rowcount != 1:
                    raise StageOperationRecoveryRequired(
                        "execution fencing CAS was lost"
                    )
            connection.execute("COMMIT")
            return token
        except BaseException:
            with suppress(sqlite3.Error):
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    @contextmanager
    def acquire(
        self,
        *,
        operation_id: str,
        session_id: str,
        mode: LeaseMode,
    ) -> Generator[ExecutionLease, None, None]:
        operation_id = require_public_id(operation_id, "execution lease operation ID")
        session_id = require_public_id(session_id, "execution lease session ID")
        if type(mode) is not LeaseMode:
            raise InvalidStageOperation("execution lease mode must be exact")
        operation_key = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()
        process_key = f"{self._root}:{operation_key}"
        with self._process_lock:
            if process_key in self._process_active:
                raise StageOperationRecoveryRequired(
                    "this process already holds the stage execution lease"
                )
            self._process_active.add(process_key)
        file: BinaryIO | None = None
        locked = False
        lease: ExecutionLease | None = None
        try:
            file = (self._locks_root / f"{operation_key}.lock").open("a+b", buffering=0)
            _lock_file(file)
            locked = True
            token = self._next_fencing_token(operation_id)
            lease = ExecutionLease.create(
                coordinator_id=self.coordinator_id,
                coordinator_incarnation=self.coordinator_incarnation,
                lease_id=f"stage-lease-{secrets.token_hex(32)}",
                operation_id=operation_id,
                session_id=session_id,
                mode=mode,
                fencing_token=token,
                acquired_at=self._now(),
            )
            with self._active_lock:
                self._active[lease.lease_id] = (lease, file, process_key)
            yield lease
        finally:
            if lease is not None:
                with self._active_lock:
                    self._active.pop(lease.lease_id, None)
            if locked and file is not None:
                with suppress(OSError):
                    _unlock_file(file)
            if file is not None:
                file.close()
            with self._process_lock:
                self._process_active.discard(process_key)

    def validate(self, lease: ExecutionLease) -> ExecutionLeaseValidation:
        if type(lease) is not ExecutionLease:
            raise StageOperationRecoveryRequired("execution lease type is not exact")
        with self._active_lock:
            current = self._active.get(lease.lease_id)
        if current is None or current[0] != lease or current[1].closed:
            raise StageOperationRecoveryRequired(
                "execution lease/fencing token is no longer active"
            )
        observed_at = self._now()
        if observed_at < lease.acquired_at:
            raise StageOperationRecoveryRequired("execution lease clock moved backwards")
        return ExecutionLeaseValidation.create(
            coordinator_id=self.coordinator_id,
            coordinator_incarnation=self.coordinator_incarnation,
            lease_id=lease.lease_id,
            operation_id=lease.operation_id,
            session_id=lease.session_id,
            mode=lease.mode,
            fencing_token=lease.fencing_token,
            lease_attestation_sha256=lease.attestation_sha256,
            observed_at=observed_at,
        )


__all__ = ("FileStageExecutionCoordinator",)
