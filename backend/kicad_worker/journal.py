"""HMAC-sealed SQLite idempotency journal for KiCad worker invocations."""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
from collections.abc import Mapping
from contextlib import closing
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import cast

from backend.mcp_gateway import canonical_data, canonical_json

_COLUMNS = (
    "actor_id",
    "operation",
    "policy_digest",
    "idempotency_key",
    "request_digest",
    "project_id",
    "project_revision",
    "bundle_sha256",
    "runtime_support_sha256",
    "state",
    "result_json",
    "report_json",
    "failure_json",
    "record_mac",
)


def _absolute_path(value: object, label: str) -> Path:
    if not isinstance(value, Path) or not value.is_absolute():
        raise ValueError(f"{label} must be an absolute pathlib.Path")
    return value


class JournalError(RuntimeError):
    pass


class JournalTamperedError(JournalError):
    pass


class JournalConflictError(JournalError):
    pass


class ClaimDisposition(StrEnum):
    NEW = "new"
    COMPLETED = "completed"
    FAILED = "failed"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True, slots=True)
class JournalSubject:
    actor_id: str
    operation: str
    policy_digest: str
    idempotency_key: str
    request_digest: str
    project_id: str
    project_revision: str
    bundle_sha256: str
    runtime_support_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not JournalSubject:
            raise TypeError("journal subject must use the exact JournalSubject type")
        for value in (
            self.actor_id,
            self.operation,
            self.policy_digest,
            self.idempotency_key,
            self.request_digest,
            self.project_id,
            self.project_revision,
            self.bundle_sha256,
            self.runtime_support_sha256,
        ):
            if type(value) is not str or not value:
                raise ValueError("journal subject values must be non-empty exact strings")


@dataclass(frozen=True, slots=True)
class JournalClaim:
    disposition: ClaimDisposition
    result: dict[str, object] | None = None
    report: dict[str, object] | None = None
    failure: dict[str, object] | None = None

    def __post_init__(self) -> None:
        if type(self) is not JournalClaim or type(self.disposition) is not ClaimDisposition:
            raise TypeError("journal claim must use exact claim types")
        if self.disposition in {
            ClaimDisposition.NEW,
            ClaimDisposition.AMBIGUOUS,
        }:
            if self.result is not None or self.report is not None or self.failure is not None:
                raise ValueError("new/ambiguous claims cannot contain terminal material")
        elif self.disposition is ClaimDisposition.COMPLETED:
            if (
                type(self.result) is not dict
                or type(self.report) is not dict
                or self.failure is not None
            ):
                raise ValueError("completed claim has invalid terminal material")
        elif type(self.failure) is not dict or self.result is not None or self.report is not None:
            raise ValueError("failed claim has invalid terminal material")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise JournalTamperedError(f"duplicate journal JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> object:
    raise JournalTamperedError(f"invalid journal JSON constant: {value}")


def _decode_object(payload: str, label: str) -> dict[str, object]:
    try:
        value = json.loads(
            payload,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_float=lambda _: (_ for _ in ()).throw(
                JournalTamperedError("journal JSON cannot contain floats")
            ),
        )
    except JournalTamperedError:
        raise
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise JournalTamperedError(f"{label} is not canonical JSON") from exc
    if type(value) is not dict:
        raise JournalTamperedError(f"{label} must be an object")
    result = cast(dict[str, object], value)
    if canonical_json(result) != payload:
        raise JournalTamperedError(f"{label} is not canonical JSON")
    return result


class SQLiteIdempotencyJournal:
    """One durable terminal result or fail-closed ambiguous state per invocation."""

    def __init__(self, path: Path, hmac_key: bytes) -> None:
        path = _absolute_path(path, "journal path")
        if type(hmac_key) is not bytes or len(hmac_key) < 32:
            raise ValueError("journal HMAC key must contain at least 32 bytes")
        self._path = path
        self._key = hmac_key
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with closing(self._connect()) as connection:
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS kicad_worker_journal (
                        actor_id TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        policy_digest TEXT NOT NULL,
                        idempotency_key TEXT NOT NULL,
                        request_digest TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        project_revision TEXT NOT NULL,
                        bundle_sha256 TEXT NOT NULL,
                        runtime_support_sha256 TEXT NOT NULL,
                        state TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
                        result_json TEXT,
                        report_json TEXT,
                        failure_json TEXT,
                        record_mac TEXT NOT NULL,
                        PRIMARY KEY (
                            actor_id, operation, policy_digest, idempotency_key
                        )
                    ) STRICT;
                    PRAGMA user_version = 2;
                    """
                )
                columns = tuple(
                    cast(str, row[1])
                    for row in connection.execute(
                        "PRAGMA table_info(kicad_worker_journal)"
                    ).fetchall()
                )
                if columns != _COLUMNS:
                    raise JournalTamperedError("journal table schema is not the pinned schema")
        except JournalError:
            raise
        except sqlite3.Error as exc:
            raise JournalError("cannot initialize KiCad idempotency journal") from exc

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=30, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA trusted_schema = OFF")
        return connection

    @staticmethod
    def _material(
        subject: JournalSubject,
        *,
        state: str,
        result_json: str | None,
        report_json: str | None,
        failure_json: str | None,
    ) -> dict[str, object]:
        return {
            "actor_id": subject.actor_id,
            "operation": subject.operation,
            "policy_digest": subject.policy_digest,
            "idempotency_key": subject.idempotency_key,
            "request_digest": subject.request_digest,
            "project_id": subject.project_id,
            "project_revision": subject.project_revision,
            "bundle_sha256": subject.bundle_sha256,
            "runtime_support_sha256": subject.runtime_support_sha256,
            "state": state,
            "result_json": result_json,
            "report_json": report_json,
            "failure_json": failure_json,
        }

    def _mac(self, material: Mapping[str, object]) -> str:
        return hmac.new(
            self._key,
            canonical_json(material).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def _subject_from_row(row: sqlite3.Row) -> JournalSubject:
        return JournalSubject(
            actor_id=cast(str, row["actor_id"]),
            operation=cast(str, row["operation"]),
            policy_digest=cast(str, row["policy_digest"]),
            idempotency_key=cast(str, row["idempotency_key"]),
            request_digest=cast(str, row["request_digest"]),
            project_id=cast(str, row["project_id"]),
            project_revision=cast(str, row["project_revision"]),
            bundle_sha256=cast(str, row["bundle_sha256"]),
            runtime_support_sha256=cast(str, row["runtime_support_sha256"]),
        )

    def _verify_row(self, row: sqlite3.Row) -> JournalSubject:
        subject = self._subject_from_row(row)
        state = cast(str, row["state"])
        result_json = cast(str | None, row["result_json"])
        report_json = cast(str | None, row["report_json"])
        failure_json = cast(str | None, row["failure_json"])
        material = self._material(
            subject,
            state=state,
            result_json=result_json,
            report_json=report_json,
            failure_json=failure_json,
        )
        record_mac = cast(str, row["record_mac"])
        if not hmac.compare_digest(record_mac, self._mac(material)):
            raise JournalTamperedError("journal record HMAC verification failed")
        valid_shape = (
            state == "running"
            and result_json is None
            and report_json is None
            and failure_json is None
        ) or (
            state == "completed"
            and result_json is not None
            and report_json is not None
            and failure_json is None
        ) or (
            state == "failed"
            and result_json is None
            and report_json is None
            and failure_json is not None
        )
        if not valid_shape:
            raise JournalTamperedError("journal record has an invalid state shape")
        return subject

    @staticmethod
    def _same_subject(left: JournalSubject, right: JournalSubject) -> bool:
        return left == right

    def claim(self, subject: JournalSubject) -> JournalClaim:
        if type(subject) is not JournalSubject:
            raise TypeError("claim requires an exact JournalSubject")
        try:
            with closing(self._connect()) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    """
                    SELECT * FROM kicad_worker_journal
                    WHERE actor_id = ? AND operation = ? AND policy_digest = ?
                      AND idempotency_key = ?
                    """,
                    (
                        subject.actor_id,
                        subject.operation,
                        subject.policy_digest,
                        subject.idempotency_key,
                    ),
                ).fetchone()
                if row is None:
                    material = self._material(
                        subject,
                        state="running",
                        result_json=None,
                        report_json=None,
                        failure_json=None,
                    )
                    connection.execute(
                        """
                        INSERT INTO kicad_worker_journal VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?
                        )
                        """,
                        (
                            subject.actor_id,
                            subject.operation,
                            subject.policy_digest,
                            subject.idempotency_key,
                            subject.request_digest,
                            subject.project_id,
                            subject.project_revision,
                            subject.bundle_sha256,
                            subject.runtime_support_sha256,
                            self._mac(material),
                        ),
                    )
                    connection.commit()
                    return JournalClaim(ClaimDisposition.NEW)
                existing = self._verify_row(row)
                if not self._same_subject(existing, subject):
                    raise JournalConflictError(
                        "idempotency key is already bound to a different worker subject"
                    )
                state = cast(str, row["state"])
                if state == "running":
                    connection.commit()
                    return JournalClaim(ClaimDisposition.AMBIGUOUS)
                if state == "completed":
                    result = _decode_object(cast(str, row["result_json"]), "journal result")
                    report = _decode_object(cast(str, row["report_json"]), "journal report")
                    connection.commit()
                    return JournalClaim(ClaimDisposition.COMPLETED, result=result, report=report)
                failure = _decode_object(cast(str, row["failure_json"]), "journal failure")
                connection.commit()
                return JournalClaim(ClaimDisposition.FAILED, failure=failure)
        except JournalError:
            raise
        except sqlite3.Error as exc:
            raise JournalError("cannot claim KiCad idempotency journal record") from exc

    def _finish(
        self,
        subject: JournalSubject,
        *,
        state: str,
        result: Mapping[str, object] | None,
        report: Mapping[str, object] | None,
        failure: Mapping[str, object] | None,
    ) -> None:
        result_json = canonical_json(canonical_data(result)) if result is not None else None
        report_json = canonical_json(canonical_data(report)) if report is not None else None
        failure_json = canonical_json(canonical_data(failure)) if failure is not None else None
        material = self._material(
            subject,
            state=state,
            result_json=result_json,
            report_json=report_json,
            failure_json=failure_json,
        )
        try:
            with closing(self._connect()) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    """
                    SELECT * FROM kicad_worker_journal
                    WHERE actor_id = ? AND operation = ? AND policy_digest = ?
                      AND idempotency_key = ?
                    """,
                    (
                        subject.actor_id,
                        subject.operation,
                        subject.policy_digest,
                        subject.idempotency_key,
                    ),
                ).fetchone()
                if row is None:
                    raise JournalTamperedError("running journal record disappeared")
                existing = self._verify_row(row)
                if existing != subject or row["state"] != "running":
                    raise JournalTamperedError("running journal record changed before finalization")
                cursor = connection.execute(
                    """
                    UPDATE kicad_worker_journal
                    SET state = ?, result_json = ?, report_json = ?, failure_json = ?,
                        record_mac = ?
                    WHERE actor_id = ? AND operation = ? AND policy_digest = ?
                      AND idempotency_key = ? AND state = 'running' AND record_mac = ?
                    """,
                    (
                        state,
                        result_json,
                        report_json,
                        failure_json,
                        self._mac(material),
                        subject.actor_id,
                        subject.operation,
                        subject.policy_digest,
                        subject.idempotency_key,
                        row["record_mac"],
                    ),
                )
                if cursor.rowcount != 1:
                    raise JournalTamperedError("journal finalization compare-and-swap failed")
                connection.commit()
        except JournalError:
            raise
        except sqlite3.Error as exc:
            raise JournalError("cannot finalize KiCad idempotency journal record") from exc

    def complete(
        self,
        subject: JournalSubject,
        result: Mapping[str, object],
        report: Mapping[str, object],
    ) -> None:
        self._finish(
            subject,
            state="completed",
            result=result,
            report=report,
            failure=None,
        )

    def fail(self, subject: JournalSubject, failure: Mapping[str, object]) -> None:
        self._finish(
            subject,
            state="failed",
            result=None,
            report=None,
            failure=failure,
        )


__all__ = (
    "ClaimDisposition",
    "JournalClaim",
    "JournalConflictError",
    "JournalError",
    "JournalSubject",
    "JournalTamperedError",
    "SQLiteIdempotencyJournal",
)
