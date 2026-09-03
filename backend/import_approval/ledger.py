"""Append-only, sealed SQLite lifecycle ledger for import approvals."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import cast

from backend.design_kernel import stable_hash
from backend.design_kernel.model import canonical_json

from .models import (
    ApprovalLedgerAnchor,
    ApprovalLedgerAnchorStore,
    ImportApprovalIntegrityError,
    ImportApprovalInvariantError,
    ImportApprovalStale,
)
from .models import (
    approval_time_text as _time_text,
)
from .models import (
    require_approval_id as _require_id,
)

_SCHEMA_VERSION = 2
_APPLICATION_ID = 0x464C5841
_ZERO = "0" * 64
_UTC_TEXT = re.compile(
    r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z"
)

_SCHEMA_STATEMENTS = (
    """CREATE TABLE import_approval_ledger_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        issuer_id TEXT NOT NULL,
        key_check TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL
    )""",
    """CREATE TABLE import_approval_ledger_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        last_event_digest TEXT NOT NULL,
        last_occurred_at TEXT,
        state_seal TEXT NOT NULL
    )""",
    """CREATE TABLE import_approval_ledger_events (
        sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
        request_id TEXT NOT NULL,
        subject_digest TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        occurred_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        previous_event_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL UNIQUE,
        event_seal TEXT NOT NULL
    )""",
    """CREATE TRIGGER import_approval_events_no_update
    BEFORE UPDATE ON import_approval_ledger_events
    BEGIN SELECT RAISE(ABORT, 'approval ledger events are append-only'); END""",
    """CREATE TRIGGER import_approval_events_no_delete
    BEFORE DELETE ON import_approval_ledger_events
    BEGIN SELECT RAISE(ABORT, 'approval ledger events are append-only'); END""",
    """CREATE TRIGGER import_approval_state_no_delete
    BEFORE DELETE ON import_approval_ledger_state
    BEGIN SELECT RAISE(ABORT, 'approval ledger state cannot be deleted'); END""",
    """CREATE TRIGGER import_approval_meta_no_update
    BEFORE UPDATE ON import_approval_ledger_meta
    BEGIN SELECT RAISE(ABORT, 'approval ledger metadata is immutable'); END""",
    """CREATE TRIGGER import_approval_meta_no_delete
    BEFORE DELETE ON import_approval_ledger_meta
    BEGIN SELECT RAISE(ABORT, 'approval ledger metadata is immutable'); END""",
)


def _schema_rows(connection: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    rows = connection.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall()
    return tuple(tuple(row) for row in rows)


def _compile_schema() -> tuple[tuple[tuple[object, ...], ...], str]:
    connection = sqlite3.connect(":memory:")
    try:
        for statement in _SCHEMA_STATEMENTS:
            connection.execute(statement)
        rows = _schema_rows(connection)
    finally:
        connection.close()
    return rows, stable_hash(
        rows,
        domain="flux-clone-import-approval-sqlite-schema-v1",
    )


_EXPECTED_SCHEMA_ROWS, _SCHEMA_SHA256 = _compile_schema()


@dataclass(frozen=True, slots=True)
class ApprovalLedgerEvent:
    sequence: int
    request_id: str
    subject_digest: str
    operation_key: str
    state: str
    generation: int
    occurred_at: datetime
    record_json: str
    previous_event_digest: str
    event_digest: str
    event_seal: str

    def __post_init__(self) -> None:
        if type(self.sequence) is not int or self.sequence <= 0:
            raise ImportApprovalIntegrityError("approval ledger sequence is invalid")
        if type(self.generation) is not int or self.generation < 0:
            raise ImportApprovalIntegrityError("approval ledger generation is invalid")
        for value, label in (
            (self.request_id, "request ID"),
            (self.subject_digest, "subject digest"),
            (self.operation_key, "operation key"),
            (self.state, "state"),
            (self.record_json, "record JSON"),
            (self.previous_event_digest, "previous digest"),
            (self.event_digest, "event digest"),
            (self.event_seal, "event seal"),
        ):
            if type(value) is not str:
                raise ImportApprovalIntegrityError(
                    f"approval ledger {label} is not an exact string"
                )
        if type(self.occurred_at) is not datetime:
            raise ImportApprovalIntegrityError(
                "approval ledger event time is not an exact datetime"
            )


class SQLiteApprovalLedger:
    """Single-issuer append-only ledger with a sealed global chain head."""

    def __init__(
        self,
        path: str | Path,
        *,
        issuer_id: str,
        seal: Callable[[str, dict[str, object]], str],
        anchor_store: ApprovalLedgerAnchorStore,
    ) -> None:
        _require_id(issuer_id, "approval ledger issuer ID")
        if not callable(seal):
            raise ImportApprovalInvariantError("approval ledger seal must be callable")
        if not isinstance(cast(object, anchor_store), ApprovalLedgerAnchorStore):
            raise ImportApprovalInvariantError(
                "approval ledger requires an external monotonic anchor store"
            )
        self._path = Path(path)
        if self._path.exists() and (not self._path.is_file() or self._path.is_symlink()):
            raise ImportApprovalInvariantError(
                "approval ledger path must be a regular non-symlink file"
            )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._issuer_id = issuer_id
        self._seal = seal
        self._anchor_store = anchor_store
        self._lock = RLock()
        self._poisoned = False
        try:
            self._connection = sqlite3.connect(
                self._path,
                isolation_level=None,
                check_same_thread=False,
                timeout=5.0,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._connection.execute("PRAGMA busy_timeout = 5000")
            self._initialize()
        except sqlite3.Error as exc:
            connection = self.__dict__.get("_connection")
            if connection is not None:
                connection.close()
            raise ImportApprovalIntegrityError(
                "approval ledger could not be initialized"
            ) from exc
        except BaseException:
            connection = self.__dict__.get("_connection")
            if connection is not None:
                connection.close()
            raise

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @contextmanager
    def _transaction(self, *, write: bool) -> Generator[None]:
        self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        try:
            yield
            self._connection.commit()
        except BaseException:
            self._connection.rollback()
            raise

    def _initialize(self) -> None:
        with self._lock, self._transaction(write=True):
            application_id = self._pragma_integer("application_id")
            user_version = self._pragma_integer("user_version")
            rows = _schema_rows(self._connection)
            if not rows and application_id == 0 and user_version == 0:
                for statement in _SCHEMA_STATEMENTS:
                    self._connection.execute(statement)
                self._connection.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
                self._connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
                if _schema_rows(self._connection) != _EXPECTED_SCHEMA_ROWS:
                    raise ImportApprovalIntegrityError(
                        "approval ledger bootstrap schema is not exact"
                    )
                key_check = self._seal(
                    "approval-ledger-key-check",
                    {"schema": _SCHEMA_VERSION, "schema_sha256": _SCHEMA_SHA256},
                )
                self._connection.execute(
                    "INSERT INTO import_approval_ledger_meta "
                    "(singleton, schema_version, issuer_id, key_check, schema_sha256) "
                    "VALUES (1, ?, ?, ?, ?)",
                    (
                        _SCHEMA_VERSION,
                        self._issuer_id,
                        key_check,
                        _SCHEMA_SHA256,
                    ),
                )
                self._connection.execute(
                    "INSERT INTO import_approval_ledger_state "
                    "(singleton, last_sequence, last_event_digest, last_occurred_at, "
                    "state_seal) VALUES (1, 0, ?, NULL, ?)",
                    (_ZERO, self._state_seal(0, _ZERO, None)),
                )
                return
            if (
                application_id != _APPLICATION_ID
                or user_version != _SCHEMA_VERSION
                or rows != _EXPECTED_SCHEMA_ROWS
            ):
                raise ImportApprovalIntegrityError(
                    "approval ledger identity or compiled schema fingerprint is invalid"
                )
            meta = self._connection.execute(
                "SELECT schema_version, issuer_id, key_check, schema_sha256 "
                "FROM import_approval_ledger_meta WHERE singleton = 1"
            ).fetchone()
            exact_key_check = self._seal(
                "approval-ledger-key-check",
                {"schema": _SCHEMA_VERSION, "schema_sha256": _SCHEMA_SHA256},
            )
            if meta is None or (
                meta["schema_version"] != _SCHEMA_VERSION
                or meta["issuer_id"] != self._issuer_id
                or meta["schema_sha256"] != _SCHEMA_SHA256
                or type(meta["key_check"]) is not str
                or not hmac.compare_digest(meta["key_check"], exact_key_check)
            ):
                raise ImportApprovalIntegrityError(
                    "approval ledger schema, issuer, or sealing key does not match"
                )
            meta_count = self._connection.execute(
                "SELECT COUNT(*) FROM import_approval_ledger_meta"
            ).fetchone()[0]
            state_count = self._connection.execute(
                "SELECT COUNT(*) FROM import_approval_ledger_state"
            ).fetchone()[0]
            if meta_count != 1 or state_count != 1:
                raise ImportApprovalIntegrityError(
                    "initialized approval ledger is missing singleton objects"
                )

    def _pragma_integer(self, name: str) -> int:
        value = self._connection.execute(f"PRAGMA {name}").fetchone()[0]
        if type(value) is not int:
            raise ImportApprovalIntegrityError(
                f"approval ledger PRAGMA {name} is invalid"
            )
        return value

    def load(self) -> tuple[tuple[ApprovalLedgerEvent, ...], str, datetime | None]:
        self._require_healthy()
        with self._lock, self._transaction(write=False):
            state = self._state_row()
            rows = self._connection.execute(
                "SELECT * FROM import_approval_ledger_events ORDER BY sequence"
            ).fetchall()
            events: list[ApprovalLedgerEvent] = []
            previous = _ZERO
            last_at: datetime | None = None
            for expected_sequence, row in enumerate(rows, 1):
                event = self._event_from_row(row)
                if event.sequence != expected_sequence:
                    raise ImportApprovalIntegrityError(
                        "approval ledger event sequence is not contiguous"
                    )
                if event.previous_event_digest != previous:
                    raise ImportApprovalIntegrityError(
                        "approval ledger event chain is broken"
                    )
                if last_at is not None and event.occurred_at < last_at:
                    raise ImportApprovalIntegrityError(
                        "approval ledger event timestamps moved backwards"
                    )
                self._verify_event(event)
                events.append(event)
                previous = event.event_digest
                last_at = event.occurred_at
            self._verify_state(state, len(events), previous, last_at)
            self._require_recoverable_external_anchor(
                tuple(events),
                ApprovalLedgerAnchor(len(events), previous),
            )
            return tuple(events), previous, last_at

    def confirm_verified_load(
        self,
        verified_events: tuple[ApprovalLedgerEvent, ...],
        *,
        expected_head: str,
        last_at: datetime | None,
    ) -> None:
        """Advance a recoverable anchor only after semantic replay succeeds."""

        self._require_healthy()
        if (
            type(verified_events) is not tuple
            or any(type(event) is not ApprovalLedgerEvent for event in verified_events)
            or type(expected_head) is not str
            or (last_at is not None and type(last_at) is not datetime)
        ):
            raise ImportApprovalIntegrityError(
                "verified approval replay confirmation has invalid concrete types"
            )
        with self._lock, self._transaction(write=False):
            state = self._state_row()
            self._verify_state(
                state,
                len(verified_events),
                expected_head,
                last_at,
            )
            self._reconcile_external_anchor(
                verified_events,
                ApprovalLedgerAnchor(len(verified_events), expected_head),
            )

    def append(
        self,
        *,
        expected_head: str,
        request_id: str,
        subject_digest: str,
        operation_key: str,
        state: str,
        generation: int,
        occurred_at: datetime,
        record_json: str,
    ) -> str:
        self._require_healthy()
        _require_id(request_id, "approval ledger request ID")
        _require_id(operation_key, "approval ledger operation key")
        if type(expected_head) is not str or type(subject_digest) is not str:
            raise ImportApprovalInvariantError(
                "approval ledger digests must be exact strings"
            )
        if type(state) is not str or type(generation) is not int or generation < 0:
            raise ImportApprovalInvariantError(
                "approval ledger state and generation are invalid"
            )
        if type(occurred_at) is not datetime or type(record_json) is not str:
            raise ImportApprovalInvariantError(
                "approval ledger event time and record must use exact builtins"
            )
        try:
            decoded = json.loads(record_json)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ImportApprovalInvariantError(
                "approval ledger record must be canonical JSON"
            ) from exc
        if canonical_json(decoded) != record_json:
            raise ImportApprovalInvariantError(
                "approval ledger record must be canonical JSON"
            )
        previous_anchor: ApprovalLedgerAnchor
        replacement_anchor: ApprovalLedgerAnchor
        with self._lock, self._transaction(write=True):
            state_row = self._state_row()
            last_at = self._decode_optional_time(state_row["last_occurred_at"])
            self._verify_state(
                state_row,
                state_row["last_sequence"],
                state_row["last_event_digest"],
                last_at,
            )
            if state_row["last_event_digest"] != expected_head:
                raise ImportApprovalStale("approval ledger changed concurrently")
            previous_anchor = ApprovalLedgerAnchor(
                state_row["last_sequence"],
                state_row["last_event_digest"],
            )
            self._verify_external_anchor(previous_anchor)
            if last_at is not None and occurred_at < last_at:
                raise ImportApprovalStale("approval ledger clock moved backwards")
            sequence = state_row["last_sequence"] + 1
            occurred_text = _time_text(occurred_at)
            record_sha256 = hashlib.sha256(record_json.encode("utf-8")).hexdigest()
            material = {
                "sequence": sequence,
                "request_id": request_id,
                "subject_digest": subject_digest,
                "operation_key": operation_key,
                "state": state,
                "generation": generation,
                "occurred_at": occurred_text,
                "record_sha256": record_sha256,
                "previous_event_digest": expected_head,
            }
            event_digest = stable_hash(
                material,
                domain="flux-clone-import-approval-ledger-event-v1",
            )
            event_seal = self._seal(
                "approval-ledger-event",
                {"sequence": sequence, "event_digest": event_digest},
            )
            self._connection.execute(
                "INSERT INTO import_approval_ledger_events "
                "(sequence, request_id, subject_digest, operation_key, state, generation, "
                "occurred_at, record_json, previous_event_digest, event_digest, event_seal) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    sequence,
                    request_id,
                    subject_digest,
                    operation_key,
                    state,
                    generation,
                    occurred_text,
                    record_json,
                    expected_head,
                    event_digest,
                    event_seal,
                ),
            )
            self._connection.execute(
                "UPDATE import_approval_ledger_state SET last_sequence = ?, "
                "last_event_digest = ?, last_occurred_at = ?, state_seal = ? "
                "WHERE singleton = 1",
                (
                    sequence,
                    event_digest,
                    occurred_text,
                    self._state_seal(sequence, event_digest, occurred_text),
                ),
            )
            replacement_anchor = ApprovalLedgerAnchor(sequence, event_digest)
        self._advance_external_anchor(previous_anchor, replacement_anchor)
        return replacement_anchor.digest

    def _require_healthy(self) -> None:
        if self._poisoned:
            raise ImportApprovalIntegrityError(
                "approval ledger is poisoned after an anchor or integrity failure"
            )

    def _read_external_anchor(self) -> ApprovalLedgerAnchor:
        try:
            anchor = self._anchor_store.read_anchor(issuer_id=self._issuer_id)
        except Exception as exc:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor is unavailable"
            ) from exc
        if type(anchor) is not ApprovalLedgerAnchor:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor returned an invalid concrete type"
            )
        return anchor

    def _verify_external_anchor(self, expected: ApprovalLedgerAnchor) -> None:
        current = self._read_external_anchor()
        if current.sequence != expected.sequence or current.digest != expected.digest:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor is ahead, behind, or contradictory"
            )

    def _reconcile_external_anchor(
        self,
        verified_events: tuple[ApprovalLedgerEvent, ...],
        database_head: ApprovalLedgerAnchor,
    ) -> None:
        """Recover only the post-commit/pre-anchor crash window.

        The caller has already verified the complete HMAC-sealed successor
        chain and sealed SQLite head.  Therefore a behind anchor may advance
        only when it names an exact prefix of that chain.  An anchor ahead of
        the database, or one naming a different digest at the same sequence,
        is a rollback/contradiction and never repairs automatically.
        """

        current = self._require_recoverable_external_anchor(
            verified_events,
            database_head,
        )
        if (
            current.sequence == database_head.sequence
            and current.digest == database_head.digest
        ):
            return
        self._advance_external_anchor(current, database_head)

    def _require_recoverable_external_anchor(
        self,
        verified_events: tuple[ApprovalLedgerEvent, ...],
        database_head: ApprovalLedgerAnchor,
    ) -> ApprovalLedgerAnchor:
        """Verify that the external anchor is equal or an exact chain prefix."""

        current = self._read_external_anchor()
        if (
            current.sequence == database_head.sequence
            and current.digest == database_head.digest
        ):
            return current
        if current.sequence > database_head.sequence:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor is ahead of the database"
            )
        prefix_digest = (
            _ZERO
            if current.sequence == 0
            else verified_events[current.sequence - 1].event_digest
        )
        if current.digest != prefix_digest:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor contradicts the verified chain"
            )
        return current

    def _advance_external_anchor(
        self,
        expected: ApprovalLedgerAnchor,
        replacement: ApprovalLedgerAnchor,
    ) -> None:
        try:
            current = self._anchor_store.compare_and_swap_anchor(
                issuer_id=self._issuer_id,
                expected=expected,
                replacement=replacement,
            )
        except Exception as exc:
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor CAS failed"
            ) from exc
        if (
            type(current) is not ApprovalLedgerAnchor
            or current.sequence != replacement.sequence
            or current.digest != replacement.digest
        ):
            self._poisoned = True
            raise ImportApprovalIntegrityError(
                "external approval-ledger anchor CAS returned a contradictory head"
            )

    def _state_row(self) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM import_approval_ledger_state WHERE singleton = 1"
        ).fetchone()
        if row is None:
            raise ImportApprovalIntegrityError("approval ledger state is missing")
        return row

    def _state_seal(
        self,
        sequence: int,
        digest: str,
        occurred_at: str | None,
    ) -> str:
        return self._seal(
            "approval-ledger-state",
            {
                "last_sequence": sequence,
                "last_event_digest": digest,
                "last_occurred_at": occurred_at,
            },
        )

    def _verify_state(
        self,
        row: sqlite3.Row,
        sequence: int,
        digest: str,
        occurred_at: datetime | None,
    ) -> None:
        if (
            type(row["last_sequence"]) is not int
            or type(row["last_event_digest"]) is not str
            or type(row["state_seal"]) is not str
            or (
                row["last_occurred_at"] is not None
                and type(row["last_occurred_at"]) is not str
            )
        ):
            raise ImportApprovalIntegrityError(
                "approval ledger state contains non-concrete values"
            )
        occurred_text = None if occurred_at is None else _time_text(occurred_at)
        if (
            row["last_sequence"] != sequence
            or row["last_event_digest"] != digest
            or row["last_occurred_at"] != occurred_text
        ):
            raise ImportApprovalIntegrityError(
                "approval ledger state does not match its event chain"
            )
        expected = self._state_seal(sequence, digest, occurred_text)
        if not hmac.compare_digest(row["state_seal"], expected):
            raise ImportApprovalIntegrityError("approval ledger state seal is invalid")

    def _event_from_row(self, row: sqlite3.Row) -> ApprovalLedgerEvent:
        return ApprovalLedgerEvent(
            sequence=row["sequence"],
            request_id=row["request_id"],
            subject_digest=row["subject_digest"],
            operation_key=row["operation_key"],
            state=row["state"],
            generation=row["generation"],
            occurred_at=self._decode_time(row["occurred_at"]),
            record_json=row["record_json"],
            previous_event_digest=row["previous_event_digest"],
            event_digest=row["event_digest"],
            event_seal=row["event_seal"],
        )

    def _verify_event(self, event: ApprovalLedgerEvent) -> None:
        try:
            body = json.loads(event.record_json)
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ImportApprovalIntegrityError(
                "approval ledger record JSON is invalid"
            ) from exc
        if canonical_json(body) != event.record_json:
            raise ImportApprovalIntegrityError(
                "approval ledger record JSON is not canonical"
            )
        material = {
            "sequence": event.sequence,
            "request_id": event.request_id,
            "subject_digest": event.subject_digest,
            "operation_key": event.operation_key,
            "state": event.state,
            "generation": event.generation,
            "occurred_at": _time_text(event.occurred_at),
            "record_sha256": hashlib.sha256(
                event.record_json.encode("utf-8")
            ).hexdigest(),
            "previous_event_digest": event.previous_event_digest,
        }
        expected_digest = stable_hash(
            material,
            domain="flux-clone-import-approval-ledger-event-v1",
        )
        expected_seal = self._seal(
            "approval-ledger-event",
            {"sequence": event.sequence, "event_digest": event.event_digest},
        )
        if event.event_digest != expected_digest or not hmac.compare_digest(
            event.event_seal,
            expected_seal,
        ):
            raise ImportApprovalIntegrityError(
                "approval ledger event digest or seal is invalid"
            )

    @staticmethod
    def _decode_time(value: object) -> datetime:
        if type(value) is not str or _UTC_TEXT.fullmatch(value) is None:
            raise ImportApprovalIntegrityError("approval ledger timestamp is invalid")
        try:
            parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=UTC
            )
        except ValueError as exc:
            raise ImportApprovalIntegrityError(
                "approval ledger timestamp is invalid"
            ) from exc
        if _time_text(parsed) != value:
            raise ImportApprovalIntegrityError(
                "approval ledger timestamp is not canonical UTC"
            )
        return parsed

    @classmethod
    def _decode_optional_time(cls, value: object) -> datetime | None:
        return None if value is None else cls._decode_time(value)


__all__ = ("ApprovalLedgerEvent", "SQLiteApprovalLedger")
